package mapioauth

import (
	"context"
	"crypto/subtle"
	"errors"
	"html/template"
	"mime"
	"net/http"
	"net/url"

	"github.com/zitadel/nextgen/internal/api"
)

// LogoutHTTP is an unmounted RP-initiated logout adapter. A valid ID-token
// hint must match the current authenticated browser session. Mutations require
// same-origin POST and a session-bound CSRF token, after a confirmation page.
type LogoutHTTP struct {
	ProjectID, Origin string
	Store             Store
	Registry          ClientRegistry
	Tokens            TokenIssuer
	Session           func(context.Context, string, string) (LoginIdentity, error)
	DeleteSession     func(context.Context, string, string) error
}

type logoutRequest struct{ Hint, ClientID, Redirect, State string }

func parseLogout(values url.Values) (logoutRequest, error) {
	allowed := map[string]bool{"id_token_hint": true, "client_id": true, "post_logout_redirect_uri": true, "state": true, "csrf": true}
	for k, v := range values {
		if !allowed[k] || len(v) != 1 {
			return logoutRequest{}, errors.New("invalid logout request")
		}
	}
	req := logoutRequest{Hint: values.Get("id_token_hint"), ClientID: values.Get("client_id"), Redirect: values.Get("post_logout_redirect_uri"), State: values.Get("state")}
	if req.Hint == "" || len(req.Hint) > 16384 || len(req.ClientID) > 512 || len(req.State) > 1024 || (req.State != "" && req.Redirect == "") {
		return req, errors.New("invalid logout request")
	}
	return req, nil
}
func (h LogoutHTTP) validate(ctx context.Context, request logoutRequest, cookie string) (LoginIdentity, error) {
	if h.ProjectID == "" || h.Store.DB == nil || h.Store.Transaction == nil || h.Session == nil || h.DeleteSession == nil || h.Registry.Statements == nil {
		return LoginIdentity{}, errors.New("logout not configured")
	}
	hint, err := h.Tokens.IDHint(ctx, request.Hint)
	if err != nil {
		return LoginIdentity{}, err
	}
	if request.ClientID != "" && request.ClientID != hint.ClientID {
		return LoginIdentity{}, ErrInvalidAccess
	}
	if _, err = h.Registry.Lookup(ctx, h.ProjectID, hint.ClientID); err != nil {
		return LoginIdentity{}, err
	}
	identity, err := h.Session(ctx, h.ProjectID, cookie)
	if err != nil || identity.ProjectID != h.ProjectID || identity.UserID != hint.Subject || identity.SessionID != hint.SessionID {
		return LoginIdentity{}, ErrInvalidAccess
	}
	if request.Redirect != "" {
		if !validLogoutURI(request.Redirect) {
			return LoginIdentity{}, ErrInvalidAccess
		}
		var count int
		if err := h.Store.DB.QueryRowContext(ctx, `SELECT count(*) FROM mapi_oauth_logout_uris WHERE project_id=? AND client_id=? AND uri=?`, h.ProjectID, hint.ClientID, request.Redirect).Scan(&count); err != nil {
			return LoginIdentity{}, err
		}
		if count != 1 {
			return LoginIdentity{}, ErrInvalidAccess
		}
	}
	return identity, nil
}

func (h LogoutHTTP) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Referrer-Policy", "strict-origin")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	origin, err := url.Parse(h.Origin)
	if err != nil || origin.Scheme != "https" || origin.Host == "" || r.Host != origin.Host || r.URL.Path != "/oauth/"+h.ProjectID+"/end_session" {
		http.NotFound(w, r)
		return
	}
	cookie, ok := uniqueCookie(r, "__Host-zitadel_session")
	if !ok {
		http.Error(w, "Logout request could not be verified", http.StatusBadRequest)
		return
	}
	if r.Method == http.MethodGet {
		request, err := parseLogout(r.URL.Query())
		if err != nil {
			http.Error(w, "Logout request could not be verified", http.StatusBadRequest)
			return
		}
		if _, err = h.validate(r.Context(), request, cookie); err != nil {
			http.Error(w, "Logout request could not be verified", http.StatusBadRequest)
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		// Browsers enforce form-action against the final 303 destination. The
		// redirect has already been matched to the client's registered URI.
		formAction := "'self'"
		if request.Redirect != "" {
			target, _ := url.Parse(request.Redirect)
			formAction += " " + target.Scheme + "://" + target.Host
		}
		w.Header().Set("Content-Security-Policy", "default-src 'none'; form-action "+formAction+"; base-uri 'none'; frame-ancestors 'none'")
		esc := template.HTMLEscapeString
		_, _ = w.Write([]byte(`<!doctype html><html lang="en"><meta charset="utf-8"><title>Sign out</title><form method="post" action="/oauth/` + esc(h.ProjectID) + `/end_session"><input type="hidden" name="id_token_hint" value="` + esc(request.Hint) + `"><input type="hidden" name="client_id" value="` + esc(request.ClientID) + `"><input type="hidden" name="post_logout_redirect_uri" value="` + esc(request.Redirect) + `"><input type="hidden" name="state" value="` + esc(request.State) + `"><input type="hidden" name="csrf" value="` + esc(api.CSRFToken(cookie)) + `"><button type="submit">Sign out</button></form></html>`))
		return
	}
	if r.Method != http.MethodPost {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	content, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || content != "application/x-www-form-urlencoded" || len(r.Header.Values("Origin")) != 1 || r.Header.Get("Origin") != h.Origin || r.URL.RawQuery != "" {
		http.Error(w, "Forbidden", http.StatusForbidden)
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 32768)
	if err = r.ParseForm(); err != nil {
		http.Error(w, "Bad request", http.StatusBadRequest)
		return
	}
	request, err := parseLogout(r.PostForm)
	if err != nil || len(r.PostForm["csrf"]) != 1 || subtle.ConstantTimeCompare([]byte(r.PostForm.Get("csrf")), []byte(api.CSRFToken(cookie))) != 1 {
		http.Error(w, "Forbidden", http.StatusForbidden)
		return
	}
	err = h.Store.Transaction(func() error {
		identity, err := h.validate(r.Context(), request, cookie)
		if err != nil {
			return err
		}
		return h.DeleteSession(r.Context(), identity.ProjectID, identity.SessionID)
	})
	if err != nil {
		http.Error(w, "Logout request could not be verified", http.StatusBadRequest)
		return
	}
	http.SetCookie(w, &http.Cookie{Name: "__Host-zitadel_session", Value: "", Path: "/", Secure: true, HttpOnly: true, SameSite: http.SameSiteLaxMode, MaxAge: -1})
	if request.Redirect == "" {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		_, _ = w.Write([]byte("Signed out"))
		return
	}
	target, _ := url.Parse(request.Redirect)
	params := target.Query()
	if request.State != "" {
		params.Set("state", request.State)
	}
	target.RawQuery = params.Encode()
	http.Redirect(w, r, target.String(), http.StatusSeeOther)
}
