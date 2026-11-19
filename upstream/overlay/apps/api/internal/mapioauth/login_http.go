package mapioauth

import (
	"context"
	"crypto/subtle"
	"errors"
	"html/template"
	"mime"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/zitadel/nextgen/internal/api"
	"github.com/zitadel/nextgen/internal/domain"
	"github.com/zitadel/nextgen/internal/service"
	"github.com/zitadel/oidc/v3/pkg/oidc"
	"github.com/zitadel/oidc/v3/pkg/op"
)

// SessionGetter is implemented by Nextgen's SessionService. Both this and
// TokenService must use the same DB connection as the LoginBridge transaction.
type SessionGetter interface {
	Get(context.Context, service.GetSessionInput) (*domain.Session, error)
}

// NextgenSessionValidator performs the same token introspection and current
// session-token checks as the upstream /sessions/me handler. Wire it only to
// services using the LoginBridge's transaction-scoped authoritative DB.
func NextgenSessionValidator(tokens service.TokenService, sessions SessionGetter, now func() time.Time) func(context.Context, string, string) (LoginIdentity, error) {
	return func(ctx context.Context, project, credential string) (LoginIdentity, error) {
		if tokens == nil || sessions == nil || now == nil || credential == "" {
			return LoginIdentity{}, ErrInvalidLogin
		}
		token, err := tokens.IntrospectToken(ctx, credential)
		if err != nil || token == nil || domain.ValidateSessionToken(token) != nil || token.ProjectID != project || token.SessionID == nil || *token.SessionID == "" {
			return LoginIdentity{}, ErrInvalidLogin
		}
		session, err := sessions.Get(ctx, service.GetSessionInput{ProjectID: project, SessionID: *token.SessionID})
		if err != nil || session == nil || session.ProjectID != project || session.ID != *token.SessionID || session.TokenID != token.TokenID || !session.ExpiresAt.After(now()) || session.UserID == nil || *session.UserID == "" || token.UserID != *session.UserID {
			return LoginIdentity{}, ErrInvalidLogin
		}
		verified := false
		for _, factor := range session.Factors {
			if factor == nil || !factor.Type().IsCredential() {
				continue
			}
			at := factor.GetLastVerifiedAt()
			if !at.IsZero() && !at.After(now()) {
				verified = true
				break
			}
		}
		if !verified {
			return LoginIdentity{}, ErrInvalidLogin
		}
		return LoginIdentity{ProjectID: project, UserID: *session.UserID, SessionID: session.ID}, nil
	}
}

// LoginHTTP wires the provider callback to a login page and supplies a separate
// continuation handler. The page must send the opaque mapi_oauth query handle
// to the official component's same-origin post-sign-in URL. It must not expose
// the binding cookie or an upstream session credential to JavaScript.
type LoginHTTP struct {
	Bridge LoginBridge
	Origin string
}

func (h LoginHTTP) validOrigin() bool {
	u, err := url.Parse(h.Origin)
	return err == nil && u.Scheme == "https" && u.Host != "" && u.User == nil && u.Path == "" && u.RawQuery == "" && u.Fragment == ""
}

func loginBindingName(handle string) string { return "__Host-mapi-oauth-" + handle }

// Begin is suitable for Provider.BeginLogin after request validation. It uses
// a separate __Host cookie per authorization request for parallel browser tabs.
func (h LoginHTTP) Begin(ctx context.Context, request *op.ClientRequest[oidc.AuthRequest]) (*op.Redirect, error) {
	if !h.validOrigin() || request == nil || request.Data == nil {
		return nil, ErrInvalidLogin
	}
	a := request.Data
	if _, err := safeAuthorizationRedirect(CompletedLogin{RedirectURI: a.RedirectURI, Code: "validation"}); err != nil {
		return nil, ErrInvalidLogin
	}
	handle, binding, err := h.Bridge.Begin(ctx, LoginRequest{ClientID: a.ClientID, RedirectURI: a.RedirectURI, Scope: CanonicalLoginScope(a.Scopes), State: a.State, Nonce: a.Nonce, CodeChallenge: a.CodeChallenge})
	if err != nil {
		return nil, err
	}
	dest := h.Origin + "/login?mapi_oauth=" + url.QueryEscape(handle)
	redirect := op.NewRedirect(dest)
	redirect.Header.Add("Set-Cookie", (&http.Cookie{Name: loginBindingName(handle), Value: binding, Path: "/", Secure: true, HttpOnly: true, SameSite: http.SameSiteLaxMode, MaxAge: int(h.Bridge.LoginTTL.Seconds())}).String())
	redirect.Header.Set("Cache-Control", "no-store")
	redirect.Header.Set("Referrer-Policy", "no-referrer")
	return redirect, nil
}

func uniqueCookie(r *http.Request, name string) (string, bool) {
	var value string
	count := 0
	for _, cookie := range r.Cookies() {
		if cookie.Name == name {
			value = cookie.Value
			count++
		}
	}
	return value, count == 1 && value != ""
}

func (h LoginHTTP) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	// Chromium emits Origin: null for a form under no-referrer, which defeats
	// the strict same-origin POST check. strict-origin sends only the origin as
	// a referrer, so the opaque authorization handle is not logged in a URL.
	w.Header().Set("Referrer-Policy", "strict-origin")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	if !h.validOrigin() || r.URL.Path != "/oauth/continue" || r.Host != strings.TrimPrefix(h.Origin, "https://") {
		http.NotFound(w, r)
		return
	}
	if r.Method == http.MethodGet {
		h.showContinue(w, r)
		return
	}
	if r.Method != http.MethodPost {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	contentType, _, contentErr := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if len(r.Header.Values("Origin")) != 1 || r.Header.Get("Origin") != h.Origin || r.URL.RawQuery != "" || contentErr != nil || contentType != "application/x-www-form-urlencoded" {
		http.Error(w, "Forbidden", http.StatusForbidden)
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 4096)
	if err := r.ParseForm(); err != nil || len(r.PostForm) != 2 || len(r.PostForm["request"]) != 1 || len(r.PostForm["csrf"]) != 1 {
		http.Error(w, "Bad request", http.StatusBadRequest)
		return
	}
	handle := r.PostForm.Get("request")
	if !validLoginSecret(handle) {
		http.Error(w, "Forbidden", http.StatusForbidden)
		return
	}
	binding, ok := uniqueCookie(r, loginBindingName(handle))
	session, sessionOK := uniqueCookie(r, "__Host-zitadel_session")
	if !ok || !sessionOK || subtle.ConstantTimeCompare([]byte(r.PostForm.Get("csrf")), []byte(api.CSRFToken(session))) != 1 {
		http.Error(w, "Forbidden", http.StatusForbidden)
		return
	}
	result, err := h.Bridge.Complete(r.Context(), handle, binding, session)
	if err != nil {
		http.Error(w, "Authorization could not be completed", http.StatusForbidden)
		return
	}
	destination, err := safeAuthorizationRedirect(result)
	if err != nil {
		http.Error(w, "Authorization could not be completed", http.StatusInternalServerError)
		return
	}
	http.SetCookie(w, &http.Cookie{Name: loginBindingName(handle), Value: "", Path: "/", Secure: true, HttpOnly: true, SameSite: http.SameSiteLaxMode, MaxAge: -1})
	http.Redirect(w, r, destination, http.StatusSeeOther)
}

func (h LoginHTTP) showContinue(w http.ResponseWriter, r *http.Request) {
	if len(r.URL.Query()) != 1 || len(r.URL.Query()["request"]) != 1 {
		http.Error(w, "Bad request", http.StatusBadRequest)
		return
	}
	handle := r.URL.Query().Get("request")
	binding, ok := uniqueCookie(r, loginBindingName(handle))
	session, sessionOK := uniqueCookie(r, "__Host-zitadel_session")
	if !validLoginSecret(handle) || !ok || !sessionOK {
		http.Error(w, "Forbidden", http.StatusForbidden)
		return
	}
	redirectURI, err := h.Bridge.RedirectURI(r.Context(), handle, binding, session)
	if err != nil {
		http.Error(w, "Forbidden", http.StatusForbidden)
		return
	}
	validated, err := safeAuthorizationRedirect(CompletedLogin{RedirectURI: redirectURI, Code: "validation"})
	if err != nil {
		http.Error(w, "Forbidden", http.StatusForbidden)
		return
	}
	target, err := url.Parse(validated)
	if err != nil {
		http.Error(w, "Forbidden", http.StatusForbidden)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	// Browsers apply form-action to the final 303 destination as well as to the
	// form POST. Only this validated RP origin is added to the policy.
	w.Header().Set("Content-Security-Policy", "default-src 'none'; form-action 'self' "+target.Scheme+"://"+target.Host+"; base-uri 'none'; frame-ancestors 'none'")
	_, _ = w.Write([]byte(`<!doctype html><html lang="en"><meta charset="utf-8"><title>Continue sign-in</title><form method="post" action="/oauth/continue"><input type="hidden" name="request" value="` + template.HTMLEscapeString(handle) + `"><input type="hidden" name="csrf" value="` + template.HTMLEscapeString(api.CSRFToken(session)) + `"><button type="submit">Continue</button></form></html>`))
}

func safeAuthorizationRedirect(result CompletedLogin) (string, error) {
	u, err := url.Parse(result.RedirectURI)
	if err != nil || u.Scheme != "https" || u.Host == "" || u.User != nil || u.Fragment != "" || result.Code == "" {
		return "", errors.New("invalid registered redirect")
	}
	// The validated host is also used as a CSP source; reject punctuation and
	// non-ASCII characters that could change the policy's meaning.
	for _, r := range u.Host {
		if !(r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || strings.ContainsRune(".-:[]", r)) {
			return "", errors.New("invalid registered redirect host")
		}
	}
	values, err := url.ParseQuery(u.RawQuery)
	if err != nil || values.Has("code") || values.Has("state") || values.Has("error") {
		return "", errors.New("invalid registered redirect query")
	}
	values.Set("code", result.Code)
	if result.State != "" {
		values.Set("state", result.State)
	}
	u.RawQuery = values.Encode()
	return u.String(), nil
}
