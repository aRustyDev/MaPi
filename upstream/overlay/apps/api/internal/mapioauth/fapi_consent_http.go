package mapioauth

import (
	"crypto/subtle"
	"html/template"
	"mime"
	"net/http"
	"net/url"
	"strings"

	"github.com/zitadel/nextgen/internal/api"
)

// FAPIConsentHTTP is an unmounted consent page. A browser decision is accepted
// only for the original browser binding and current upstream session.
type FAPIConsentHTTP struct {
	Login          FAPILogin
	Origin, Issuer string
}

func (h FAPIConsentHTTP) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Referrer-Policy", "strict-origin")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	if !(LoginHTTP{Origin: h.Origin}).validOrigin() || h.Issuer != h.Origin+"/oauth/"+h.Login.ProjectID || r.URL.Path != "/oauth/continue" || r.Host != strings.TrimPrefix(h.Origin, "https://") {
		http.NotFound(w, r)
		return
	}
	if r.Method == http.MethodGet {
		h.show(w, r)
		return
	}
	if r.Method != http.MethodPost {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	media, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if len(r.Header.Values("Origin")) != 1 || r.Header.Get("Origin") != h.Origin || r.URL.RawQuery != "" || err != nil || media != "application/x-www-form-urlencoded" {
		http.Error(w, "Forbidden", http.StatusForbidden)
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 4096)
	if err = r.ParseForm(); err != nil || len(r.PostForm) != 3 || len(r.PostForm["request"]) != 1 || len(r.PostForm["csrf"]) != 1 || len(r.PostForm["decision"]) != 1 {
		http.Error(w, "Bad request", http.StatusBadRequest)
		return
	}
	handle := r.PostForm.Get("request")
	binding, ok := uniqueCookie(r, loginBindingName(handle))
	session, sessionOK := uniqueCookie(r, "__Host-zitadel_session")
	if !validLoginSecret(handle) || !ok || !sessionOK || subtle.ConstantTimeCompare([]byte(r.PostForm.Get("csrf")), []byte(api.CSRFToken(session))) != 1 {
		http.Error(w, "Forbidden", http.StatusForbidden)
		return
	}
	var destination string
	switch r.PostForm.Get("decision") {
	case "allow":
		result, e := h.Login.CompleteWithConsent(r.Context(), handle, binding, session)
		if e != nil {
			http.Error(w, "Authorization could not be completed", http.StatusForbidden)
			return
		}
		destination, e = safeAuthorizationRedirect(result)
		if e != nil {
			http.Error(w, "Authorization could not be completed", http.StatusInternalServerError)
			return
		}
	case "deny":
		result, e := h.Login.Deny(r.Context(), handle, binding, session)
		if e != nil {
			http.Error(w, "Authorization could not be completed", http.StatusForbidden)
			return
		}
		u, e := url.Parse(result.RedirectURI)
		if e != nil {
			http.Error(w, "Authorization could not be completed", http.StatusInternalServerError)
			return
		}
		values := u.Query()
		values.Set("error", "access_denied")
		if result.State != "" {
			values.Set("state", result.State)
		}
		u.RawQuery = values.Encode()
		destination = u.String()
	default:
		http.Error(w, "Bad request", http.StatusBadRequest)
		return
	}
	u, err := url.Parse(destination)
	if err != nil || u.Query().Has("iss") {
		http.Error(w, "Authorization could not be completed", http.StatusInternalServerError)
		return
	}
	values := u.Query()
	values.Set("iss", h.Issuer)
	u.RawQuery = values.Encode()
	http.SetCookie(w, &http.Cookie{Name: loginBindingName(handle), Value: "", Path: "/", Secure: true, HttpOnly: true, SameSite: http.SameSiteLaxMode, MaxAge: -1})
	http.Redirect(w, r, u.String(), http.StatusSeeOther)
}

func (h FAPIConsentHTTP) show(w http.ResponseWriter, r *http.Request) {
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
	details, err := h.Login.ConsentPreview(r.Context(), handle, binding, session)
	if err != nil {
		http.Error(w, "Forbidden", http.StatusForbidden)
		return
	}
	target, err := url.Parse(details.RedirectURI)
	if err != nil {
		http.Error(w, "Forbidden", http.StatusForbidden)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Content-Security-Policy", "default-src 'none'; form-action 'self' "+target.Scheme+"://"+target.Host+"; base-uri 'none'; frame-ancestors 'none'")
	esc := template.HTMLEscapeString
	_, _ = w.Write([]byte(`<!doctype html><html lang="en"><meta charset="utf-8"><title>Authorize application</title><h1>Authorize application</h1><p>Application: ` + esc(details.ClientID) + `</p><p>Requested access: ` + esc(details.Scope) + `</p><form method="post" action="/oauth/continue"><input type="hidden" name="request" value="` + esc(handle) + `"><input type="hidden" name="csrf" value="` + esc(api.CSRFToken(session)) + `"><button type="submit" name="decision" value="allow">Continue</button><button type="submit" name="decision" value="deny">Deny</button></form></html>`))
}
