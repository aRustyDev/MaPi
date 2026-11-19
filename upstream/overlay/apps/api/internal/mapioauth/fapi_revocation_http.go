package mapioauth

import (
	"errors"
	"net/http"
	"net/url"
)

// FAPIRevocationHTTP is private and unmounted. Its trusted ingress must enforce
// HTTPS, exact project routing, request limits and credential redaction.
type FAPIRevocationHTTP struct{ Revoker FAPIRevoker }

func (h FAPIRevocationHTTP) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	fapiResponse(w)
	p := h.Revoker.Issuer.Private
	if p == nil {
		fapiError(w, http.StatusInternalServerError, "server_error")
		return
	}
	endpoint, err := url.Parse(p.Assertions.Issuer + "/revoke")
	if err != nil || r.URL == nil || r.Host != endpoint.Host || r.URL.Path != endpoint.Path || r.URL.RawQuery != "" || (r.TLS == nil && r.URL.Scheme != "https") {
		fapiError(w, http.StatusBadRequest, "invalid_request")
		return
	}
	form, ok := fapiForm(w, r)
	if !ok {
		return
	}
	if r.Header.Get("Authorization") != "" || len(r.Header.Values("DPoP")) > 1 || len(r.Header.Get("DPoP")) > 16384 {
		fapiError(w, http.StatusBadRequest, "invalid_request")
		return
	}
	if headers := r.Header.Values("DPoP"); len(headers) == 1 && headers[0] == "" {
		fapiError(w, http.StatusBadRequest, "invalid_dpop_proof")
		return
	}
	for _, values := range form {
		if len(values) != 1 {
			fapiError(w, http.StatusBadRequest, "invalid_request")
			return
		}
	}
	if _, exists := form["client_secret"]; exists {
		fapiError(w, http.StatusBadRequest, "invalid_client")
		return
	}
	clientID, hintErr := assertionClientHint(form)
	if hintErr != nil {
		fapiError(w, http.StatusBadRequest, "invalid_client")
		return
	}
	req := FAPIRevokeRequest{ClientID: clientID, AssertionType: form.Get("client_assertion_type"), Assertion: form.Get("client_assertion"), Proof: r.Header.Get("DPoP"), Token: form.Get("token")}
	if req.ClientID == "" || len(req.ClientID) > 512 || req.AssertionType != privateKeyAssertionType || req.Assertion == "" || len(req.Assertion) > 16384 {
		fapiError(w, http.StatusBadRequest, "invalid_client")
		return
	}
	if req.Token == "" || len(req.Token) > 16384 {
		fapiError(w, http.StatusBadRequest, "invalid_request")
		return
	}
	// RFC 7009 permits unknown token_type_hint values; ignore the hint and
	// unknown extension parameters while still rejecting duplicate values.
	err = h.Revoker.RevokeAccess(r.Context(), req)
	if writeNonceChallenge(r.Context(), w, err, p.Nonces, p.Grants.ProjectID, "revocation") {
		return
	}
	switch {
	case errors.Is(err, ErrInvalidClient):
		fapiError(w, http.StatusBadRequest, "invalid_client")
	case errors.Is(err, ErrInvalidDPoP):
		fapiError(w, http.StatusBadRequest, "invalid_dpop_proof")
	case err != nil:
		fapiError(w, http.StatusInternalServerError, "server_error")
	default:
		w.WriteHeader(http.StatusOK)
	}
}
