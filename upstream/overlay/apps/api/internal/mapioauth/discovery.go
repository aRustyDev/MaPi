package mapioauth

import (
	"encoding/json"
	"net/http"
	"net/url"
)

// Discovery is the private, opt-in OIDC metadata handler. Do not publish it
// until the advertised profile, cross-project routing and hosted conformance
// have been verified. Every endpoint is relative to this exact project issuer.
func (c *Composition) Discovery(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	issuer, err := url.Parse(c.Issuer)
	if err != nil || r.Method != http.MethodGet || r.Host != issuer.Host || r.URL.Path != issuer.Path+"/.well-known/openid-configuration" || r.URL.RawQuery != "" {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{
		"issuer": c.Issuer, "authorization_endpoint": c.Issuer + "/authorize", "token_endpoint": c.Issuer + "/token", "jwks_uri": c.Issuer + "/jwks", "userinfo_endpoint": c.Issuer + "/userinfo", "revocation_endpoint": c.Issuer + "/revoke", "end_session_endpoint": c.Issuer + "/end_session",
		"response_types_supported": []string{"code"}, "response_modes_supported": []string{"query"}, "grant_types_supported": []string{"authorization_code", "refresh_token"}, "subject_types_supported": []string{"public"}, "id_token_signing_alg_values_supported": []string{"RS256"}, "scopes_supported": []string{"openid", "offline_access"}, "token_endpoint_auth_methods_supported": []string{"client_secret_basic", "client_secret_post"}, "revocation_endpoint_auth_methods_supported": []string{"client_secret_basic", "client_secret_post"}, "code_challenge_methods_supported": []string{"S256"}, "claims_supported": []string{"iss", "sub", "aud", "exp", "iat", "auth_time", "nonce", "sid", "at_hash"},
	})
}
