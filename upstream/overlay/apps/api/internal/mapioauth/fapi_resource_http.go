package mapioauth

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"
)

// FAPIResourceHTTP is a deliberately unmounted sample protected resource.
// ResourceURL and Policy are trusted resource configuration, not headers.
// It does not grant general application permissions.
type FAPIResourceHTTP struct {
	Tokens      FAPIAccessIssuer
	ResourceURL string
	Policy      FAPIResourcePolicy
}

func (h FAPIResourceHTTP) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	fapiResponse(w)
	w.Header().Set("Date", time.Now().UTC().Format(http.TimeFormat))
	if h.Tokens.Private == nil || r.Method != http.MethodGet || r.URL == nil || r.URL.Scheme+"://"+r.URL.Host+r.URL.Path != h.ResourceURL || r.URL.RawQuery != "" {
		fapiError(w, http.StatusBadRequest, "invalid_request")
		return
	}
	auth := r.Header.Values("Authorization")
	proof := r.Header.Values("DPoP")
	if len(auth) != 1 || len(proof) != 1 || len(proof[0]) > 16384 || (len(auth[0]) < 5 || !strings.EqualFold(auth[0][:5], "DPoP ")) || len(auth[0]) > 16389 {
		w.Header().Set("WWW-Authenticate", `DPoP error="invalid_token"`)
		fapiError(w, http.StatusUnauthorized, "invalid_token")
		return
	}
	identity, err := h.Tokens.AuthorizeResource(r.Context(), auth[0][5:], proof[0], r.Method, h.ResourceURL, h.Policy)
	if writeNonceChallenge(r.Context(), w, err, h.Tokens.Private.Nonces, h.Tokens.Keys.ProjectID, "resource") {
		return
	}
	if err != nil {
		if errors.Is(err, ErrInvalidAccess) || errors.Is(err, ErrInvalidDPoP) {
			w.Header().Set("WWW-Authenticate", `DPoP error="invalid_token"`)
			fapiError(w, http.StatusUnauthorized, "invalid_token")
			return
		}
		if errors.Is(err, ErrInsufficientScope) {
			fapiError(w, http.StatusForbidden, "insufficient_scope")
		} else {
			fapiError(w, http.StatusInternalServerError, "server_error")
		}
		return
	}
	_ = json.NewEncoder(w).Encode(map[string]string{"sub": identity.Subject})
}
