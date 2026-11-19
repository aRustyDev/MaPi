package mapioauth

import (
	"context"
	"encoding/json"
	"errors"
	"mime"
	"net/http"
	"net/url"
	"strings"
)

// These adapters are deliberately unmounted. Ingress must enforce its own
// TLS, trusted-origin routing, rate limits, body and credential redaction.
type FAPIPARHTTP struct{ Private *PrivatePAR }
type FAPITokenHTTP struct{ Exchange FAPIExchange }

func fapiResponse(w http.ResponseWriter) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Pragma", "no-cache")
	w.Header().Set("Content-Type", "application/json")
}
func fapiError(w http.ResponseWriter, status int, code string) {
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": code})
}
func fapiForm(w http.ResponseWriter, r *http.Request) (url.Values, bool) {
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", "POST")
		fapiError(w, http.StatusMethodNotAllowed, "invalid_request")
		return nil, false
	}
	media, params, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || media != "application/x-www-form-urlencoded" || (params["charset"] != "" && !strings.EqualFold(params["charset"], "UTF-8")) {
		fapiError(w, http.StatusBadRequest, "invalid_request")
		return nil, false
	}
	if r.Body == nil {
		r.Body = http.NoBody
	}
	r.Body = http.MaxBytesReader(w, r.Body, 65536)
	if err = r.ParseForm(); err != nil {
		var limit *http.MaxBytesError
		if errors.As(err, &limit) {
			fapiError(w, http.StatusRequestEntityTooLarge, "invalid_request")
		} else {
			fapiError(w, http.StatusBadRequest, "invalid_request")
		}
		return nil, false
	}
	return r.PostForm, true
}
func (h FAPIPARHTTP) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	fapiResponse(w)
	if h.Private == nil {
		fapiError(w, http.StatusInternalServerError, "server_error")
		return
	}
	form, ok := fapiForm(w, r)
	if !ok {
		return
	}
	requestURI, err := h.Private.PAR.Push(r.Context(), r, form)
	if writeNonceChallenge(r.Context(), w, err, h.Private.Nonces, h.Private.PAR.ProjectID, "par") {
		return
	}
	switch {
	case errors.Is(err, ErrInvalidClient):
		fapiError(w, http.StatusBadRequest, "invalid_client")
	case errors.Is(err, ErrInvalidDPoP):
		fapiError(w, http.StatusBadRequest, "invalid_dpop_proof")
	case errors.Is(err, ErrInvalidPAR):
		fapiError(w, http.StatusBadRequest, "invalid_request")
	case err != nil:
		fapiError(w, http.StatusInternalServerError, "server_error")
	default:
		w.WriteHeader(http.StatusCreated)
		_ = json.NewEncoder(w).Encode(map[string]any{"request_uri": requestURI, "expires_in": int(h.Private.PAR.TTL.Seconds())})
	}
}
func (h FAPITokenHTTP) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	fapiResponse(w)
	p := h.Exchange.Private
	if p == nil {
		fapiError(w, http.StatusInternalServerError, "server_error")
		return
	}
	endpoint, err := url.Parse(p.Assertions.Issuer + "/token")
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
	for _, values := range form {
		if len(values) != 1 {
			fapiError(w, http.StatusBadRequest, "invalid_request")
			return
		}
	}
	for _, name := range []string{"client_secret", "resource", "authorization_details"} {
		if _, exists := form[name]; exists {
			fapiError(w, http.StatusBadRequest, "invalid_request")
			return
		}
	}
	clientID, hintErr := assertionClientHint(form)
	if hintErr != nil {
		fapiError(w, http.StatusBadRequest, "invalid_client")
		return
	}
	req := FAPIExchangeRequest{ClientID: clientID, AssertionType: form.Get("client_assertion_type"), Assertion: form.Get("client_assertion"), Proof: r.Header.Get("DPoP"), Code: form.Get("code"), RedirectURI: form.Get("redirect_uri"), Verifier: form.Get("code_verifier"), RefreshToken: form.Get("refresh_token")}
	if req.ClientID == "" || len(req.ClientID) > 512 || req.AssertionType != "urn:ietf:params:oauth:client-assertion-type:jwt-bearer" || req.Assertion == "" || len(req.Assertion) > 16384 {
		fapiError(w, http.StatusBadRequest, "invalid_client")
		return
	}
	_, req.ScopeProvided = form["scope"]
	req.Scope = form.Get("scope")
	grant := form.Get("grant_type")
	if (grant == "authorization_code" && (req.Code == "" || req.RedirectURI == "" || req.RefreshToken != "" || req.ScopeProvided)) || (grant == "refresh_token" && (req.RefreshToken == "" || req.Code != "" || req.RedirectURI != "" || req.Verifier != "")) || (grant != "authorization_code" && grant != "refresh_token") {
		fapiError(w, http.StatusBadRequest, "invalid_request")
		return
	}
	// Validate mint output before the transaction commits: a malformed response
	// must not consume a code or alter replay/audit state.
	exchange := h.Exchange
	mint := exchange.Mint
	if mint == nil {
		fapiError(w, http.StatusInternalServerError, "server_error")
		return
	}
	exchange.Mint = func(ctx context.Context, g FAPIExchangeGrant) ([]byte, error) {
		result, err := mint(ctx, g)
		if err != nil {
			return nil, err
		}
		var token struct {
			AccessToken string `json:"access_token"`
			TokenType   string `json:"token_type"`
		}
		if len(result) > 65536 || json.Unmarshal(result, &token) != nil || token.AccessToken == "" || token.TokenType != "DPoP" {
			return nil, errors.New("invalid DPoP mint response")
		}
		return result, nil
	}
	var result []byte
	if grant == "authorization_code" {
		result, err = exchange.ExchangeCode(r.Context(), req)
	} else {
		result, err = exchange.ExchangeRefresh(r.Context(), req)
	}
	if writeNonceChallenge(r.Context(), w, err, p.Nonces, p.Grants.ProjectID, "token") {
		return
	}
	switch {
	case errors.Is(err, ErrInvalidClient):
		fapiError(w, http.StatusBadRequest, "invalid_client")
	case errors.Is(err, ErrInvalidDPoP):
		fapiError(w, http.StatusBadRequest, "invalid_dpop_proof")
	case errors.Is(err, ErrInvalidRefreshScope):
		fapiError(w, http.StatusBadRequest, "invalid_scope")
	case errors.Is(err, ErrInvalidCode), errors.Is(err, ErrInvalidRefresh):
		fapiError(w, http.StatusBadRequest, "invalid_grant")
	case err != nil:
		fapiError(w, http.StatusInternalServerError, "server_error")
	default:
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(result)
	}
}
