package mapioauth

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"

	"github.com/zitadel/nextgen/internal/mapidpop"
)

// nonceRequired is constructed only after authenticating the client or
// resource token in the enclosing operation. It carries server-derived scope,
// never an untrusted JWT claim, and contains no nonce or credential.
type nonceRequired struct{ scope mapidpop.NonceScope }

func (e *nonceRequired) Error() string                 { return "DPoP nonce required" }
func (e *nonceRequired) Unwrap() error                 { return ErrInvalidDPoP }
func newNonceRequired(scope mapidpop.NonceScope) error { return &nonceRequired{scope: scope} }

// writeNonceChallenge is called only after the failed protected transaction
// has rolled back. NonceStore.Issue performs a new audited transaction and
// returns the nonce only after commit. No replay/error details are exposed.
func writeNonceChallenge(ctx context.Context, w http.ResponseWriter, err error, nonces mapidpop.NonceStore, project, purpose string) bool {
	var need *nonceRequired
	if !errors.As(err, &need) {
		return false
	}
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Pragma", "no-cache")
	w.Header().Set("Content-Type", "application/json")
	if need.scope.ProjectID != project || need.scope.ClientID == "" || need.scope.Purpose != purpose || (purpose != "par" && purpose != "token" && purpose != "resource" && purpose != "revocation") {
		w.WriteHeader(http.StatusInternalServerError)
		_ = json.NewEncoder(w).Encode(map[string]string{"error": "server_error"})
		return true
	}
	nonce, issueErr := nonces.Issue(ctx, need.scope)
	if issueErr != nil {
		w.WriteHeader(http.StatusInternalServerError)
		_ = json.NewEncoder(w).Encode(map[string]string{"error": "server_error"})
		return true
	}
	w.Header().Set("DPoP-Nonce", nonce)
	// Exposing the header alone does not authorize CORS; the ingress must apply
	// its separately configured origin policy.
	w.Header().Set("Access-Control-Expose-Headers", "DPoP-Nonce, WWW-Authenticate")
	status := http.StatusBadRequest
	if purpose == "resource" {
		status = http.StatusUnauthorized
		w.Header().Set("WWW-Authenticate", `DPoP error="use_dpop_nonce", algs="ES256 PS256 EdDSA"`)
	}
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": "use_dpop_nonce"})
	return true
}
