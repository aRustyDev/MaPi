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

	"github.com/zitadel/nextgen/internal/api"
)

// FAPILoginHTTP is a private-only browser adapter. It is not a certified provider.
type FAPILoginHTTP struct {
	Private        *PrivatePAR
	Login          FAPILogin
	Origin, Issuer string
}

// Authorize atomically consumes PAR into a browser-bound login transaction.
func (h FAPILoginHTTP) Authorize(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Referrer-Policy", "no-referrer")
	if h.Private == nil || !(LoginHTTP{Origin: h.Origin}).validOrigin() || h.Issuer != h.Origin+"/oauth/"+h.Private.PAR.ProjectID || r.Method != http.MethodGet || r.Host != strings.TrimPrefix(h.Origin, "https://") || r.URL.Path != "/oauth/"+h.Private.PAR.ProjectID+"/authorize" {
		http.NotFound(w, r)
		return
	}
	// The PAR record is authoritative. Ignore all other front-channel values,
	// including conflicting redirect, scope, or state; never merge them.
	values := r.URL.Query()
	if len(r.URL.RawQuery) > 8192 || len(values["client_id"]) != 1 || len(values["request_uri"]) != 1 {
		http.Error(w, "Invalid request", http.StatusBadRequest)
		return
	}
	requestURI := values.Get("request_uri")
	if !strings.HasPrefix(requestURI, parPrefix) || !validLoginSecret(strings.TrimPrefix(requestURI, parPrefix)) {
		http.Error(w, "Invalid request", http.StatusBadRequest)
		return
	}
	optionalCookie := func(name string) (string, bool) {
		var value string
		count := 0
		for _, cookie := range r.Cookies() {
			if cookie.Name == name {
				value = cookie.Value
				count++
			}
		}
		return value, count <= 1
	}
	session, unique := optionalCookie("__Host-zitadel_session")
	if !unique || len(session) > 8192 {
		http.Error(w, "Invalid request", http.StatusBadRequest)
		return
	}
	reloadName := parReloadCookieName(requestURI)
	reloadHandle, unique := optionalCookie(reloadName)
	if !unique {
		http.Error(w, "Invalid request", http.StatusBadRequest)
		return
	}
	if reloadHandle != "" {
		if !validLoginSecret(reloadHandle) {
			http.Error(w, "Invalid request", http.StatusBadRequest)
			return
		}
		binding, ok := uniqueCookie(r, loginBindingName(reloadHandle))
		if !ok || resumeFAPIReload(r.Context(), h.Login, requestURI, values.Get("client_id"), reloadHandle, binding, session) != nil {
			http.Error(w, "Invalid request", http.StatusBadRequest)
			return
		}
		http.Redirect(w, r, h.Origin+"/login?mapi_oauth="+url.QueryEscape(reloadHandle), http.StatusSeeOther)
		return
	}
	var handle, binding string
	err := h.Private.PAR.Consume(r.Context(), h.Private.PAR.ProjectID, values.Get("client_id"), requestURI, func(ctx context.Context, req PushedAuthorizationRequest) error {
		redirect, err := url.Parse(req.RedirectURI)
		if err != nil || redirect.Query().Has("iss") {
			return errors.New("invalid redirect")
		}
		if _, err = safeAuthorizationRedirect(CompletedLogin{RedirectURI: req.RedirectURI, Code: "validation"}); err != nil {
			return err
		}
		var beginErr error
		handle, binding, beginErr = h.Login.BeginInTransaction(ctx, req)
		if beginErr != nil {
			return beginErr
		}
		return recordFAPIReload(ctx, h.Login, requestURI, handle, binding, session, req)
	})
	if err != nil {
		http.Error(w, "Invalid request", http.StatusBadRequest)
		return
	}
	http.SetCookie(w, &http.Cookie{Name: loginBindingName(handle), Value: binding, Path: "/", Secure: true, HttpOnly: true, SameSite: http.SameSiteLaxMode, MaxAge: int(h.Login.LoginTTL.Seconds())})
	http.SetCookie(w, &http.Cookie{Name: reloadName, Value: handle, Path: "/", Secure: true, HttpOnly: true, SameSite: http.SameSiteLaxMode, MaxAge: int(h.Private.PAR.TTL.Seconds())})
	http.Redirect(w, r, h.Origin+"/login?mapi_oauth="+url.QueryEscape(handle), http.StatusSeeOther)
}

func (h FAPILoginHTTP) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	// Chromium emits Origin: null for a form under no-referrer, which defeats
	// the strict same-origin POST check. strict-origin sends only the origin as
	// a referrer, so the opaque authorization handle is not logged in a URL.
	w.Header().Set("Referrer-Policy", "strict-origin")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	if !(LoginHTTP{Origin: h.Origin}).validOrigin() || r.URL.Path != "/oauth/continue" || r.Host != strings.TrimPrefix(h.Origin, "https://") {
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
	result, err := h.Login.Complete(r.Context(), handle, binding, session)
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
	u, _ := url.Parse(destination)
	if u.Query().Has("iss") {
		http.Error(w, "Invalid redirect", http.StatusForbidden)
		return
	}
	values := u.Query()
	values.Set("iss", h.Issuer)
	u.RawQuery = values.Encode()
	http.Redirect(w, r, u.String(), http.StatusSeeOther)
}

func (h FAPILoginHTTP) showContinue(w http.ResponseWriter, r *http.Request) {
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
	redirectURI, err := h.Login.RedirectURI(r.Context(), handle, binding, session)
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
