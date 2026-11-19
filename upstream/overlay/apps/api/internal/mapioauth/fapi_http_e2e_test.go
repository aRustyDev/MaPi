//go:build mapi_native_e2e && !wasip1

package mapioauth

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/zitadel/nextgen/internal/mapidpop"
)

// Called by the native full-stack fixture; all assertions and DPoP proofs are
// signed by real keys registered with a real upstream application/client.
func exerciseFAPINonceHTTP(t *testing.T, p *PrivatePAR, db *sql.DB, form url.Values, proof func(string, string) string, assertion func(string) string, now *time.Time, exchange FAPIExchange, tokenProof func(string, string) string, codeGrant AuthorizationCode, jkt string) {
	t.Helper()
	values := url.Values{}
	for k, v := range form {
		values[k] = append([]string(nil), v...)
	}
	values.Set("client_assertion", assertion("http-par-assertion"))
	post := func(handler http.Handler, endpoint string, v url.Values, dpop string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(http.MethodPost, endpoint, strings.NewReader(v.Encode()))
		r.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		if dpop != "" {
			r.Header.Set("DPoP", dpop)
		}
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		return w
	}
	challenge := func(w *httptest.ResponseRecorder) string {
		t.Helper()
		var body map[string]string
		if w.Code != 400 || json.Unmarshal(w.Body.Bytes(), &body) != nil || body["error"] != "use_dpop_nonce" || w.Header().Get("Cache-Control") != "no-store" {
			t.Fatalf("nonce challenge: %d %s", w.Code, w.Body.String())
		}
		n := w.Header().Get("DPoP-Nonce")
		if len(n) != 43 {
			t.Fatalf("missing server nonce: %q", n)
		}
		return n
	}
	h := FAPIPARHTTP{Private: p}
	// Client authentication happens before challenge; a malformed nonce is not
	// distinguished from a missing nonce and neither consumes the assertion.
	w := post(h, p.PAR.Endpoint, values, proof("http-proof", ""))
	n := challenge(w)
	w = post(h, p.PAR.Endpoint, values, proof("http-proof", "malformed"))
	_ = challenge(w)
	w = post(h, p.PAR.Endpoint, values, proof("http-proof", n))
	if w.Code != 201 {
		t.Fatalf("challenge retry: %d %s", w.Code, w.Body.String())
	}
	values.Set("client_assertion", assertion("http-par-replay"))
	w = post(h, p.PAR.Endpoint, values, proof("http-proof", n))
	if w.Code != 400 || w.Header().Get("DPoP-Nonce") != "" || !strings.Contains(w.Body.String(), "invalid_dpop_proof") {
		t.Fatalf("replay leaked nonce or accepted: %d %s", w.Code, w.Body.String())
	}
	// Nonces issued for another project, client or purpose cannot satisfy PAR.
	for _, foreign := range []mapidpop.NonceScope{
		{ProjectID: "other-project", ClientID: values.Get("client_id"), Purpose: "par"},
		{ProjectID: p.PAR.ProjectID, ClientID: "other-client", Purpose: "par"},
		{ProjectID: p.PAR.ProjectID, ClientID: values.Get("client_id"), Purpose: "token"},
	} {
		other, err := p.Nonces.Issue(context.Background(), foreign)
		if err != nil {
			t.Fatal(err)
		}
		values.Set("client_assertion", assertion("http-other-scope"))
		w = post(h, p.PAR.Endpoint, values, proof("http-other-scope", other))
		_ = challenge(w)
	}
	// Expiry is checked against server time even if the new proof itself is fresh.
	*now = now.Add(p.Nonces.TTL + time.Second)
	values.Set("client_assertion", assertion("http-expired"))
	w = post(h, p.PAR.Endpoint, values, proof("http-expired", n))
	_ = challenge(w)
	values.Set("client_assertion", "bogus")
	w = post(h, p.PAR.Endpoint, values, proof("http-unauth", ""))
	if w.Header().Get("DPoP-Nonce") != "" || !strings.Contains(w.Body.String(), "invalid_client") {
		t.Fatalf("unauthenticated challenge: %d %s", w.Code, w.Body.String())
	}
	// Issuance is independently transactional and an audit failure must not
	// expose a nonce or retain the generated nonce row.
	before := 0
	if err := db.QueryRow("SELECT count(*) FROM mapi_dpop_nonces").Scan(&before); err != nil {
		t.Fatal(err)
	}
	broken := *p
	broken.Nonces.Audit = func(context.Context, mapidpop.NonceScope) error { return errors.New("test audit failure") }
	values.Set("client_assertion", assertion("http-audit"))
	w = post(FAPIPARHTTP{Private: &broken}, p.PAR.Endpoint, values, proof("http-audit", ""))
	if w.Code != 500 || w.Header().Get("DPoP-Nonce") != "" {
		t.Fatalf("failed issuance: %d %s", w.Code, w.Body.String())
	}
	after := 0
	if err := db.QueryRow("SELECT count(*) FROM mapi_dpop_nonces").Scan(&after); err != nil || before != after {
		t.Fatal("failed nonce issue persisted")
	}
	// Exercise the resource-server challenge boundary separately. No public
	// resource ingress is mounted by this test.
	wr := httptest.NewRecorder()
	scope := mapidpop.NonceScope{ProjectID: p.PAR.ProjectID, ClientID: values.Get("client_id"), Purpose: "resource"}
	if !writeNonceChallenge(context.Background(), wr, newNonceRequired(scope), p.Nonces, p.PAR.ProjectID, "resource") || wr.Code != 401 || !strings.Contains(wr.Header().Get("WWW-Authenticate"), `DPoP error="use_dpop_nonce"`) || wr.Header().Get("DPoP-Nonce") == "" {
		t.Fatal("bad resource challenge")
	}
	// Token code is issued in a real transaction; retry uses the same signed
	// client assertion after the nonce error rolled back its replay record.
	codeGrant.ExpiresAt = now.Add(time.Minute)
	currentPolicy, err := p.Policies.Get(context.Background(), values.Get("client_id"))
	if err != nil {
		t.Fatal(err)
	}
	codeGrant.PolicyVersion = currentPolicy.Version
	var code string
	if err := p.Grants.Store.Transaction(func() error {
		var e error
		code, e = p.Grants.IssueCodeInTransaction(context.Background(), codeGrant, jkt)
		return e
	}); err != nil {
		t.Fatal(err)
	}
	exchange.Mint = func(context.Context, FAPIExchangeGrant) ([]byte, error) {
		return []byte(`{"access_token":"synthetic","token_type":"DPoP"}`), nil
	}
	tokenForm := url.Values{"grant_type": {"authorization_code"}, "client_id": {values.Get("client_id")}, "client_assertion_type": {privateKeyAssertionType}, "client_assertion": {assertion("http-token-assertion")}, "code": {code}, "redirect_uri": {codeGrant.RedirectURI}, "code_verifier": {"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~"}}
	tokenEndpoint := p.Assertions.Issuer + "/token"
	mismatch := url.Values{}
	for key, values := range tokenForm {
		mismatch[key] = append([]string(nil), values...)
	}
	mismatch.Set("client_id", "different-client")
	if failed := post(FAPITokenHTTP{Exchange: exchange}, tokenEndpoint, mismatch, tokenProof("http-token-mismatch", "")); failed.Code != 400 || !strings.Contains(failed.Body.String(), "invalid_client") {
		t.Fatal("mismatched asserted client accepted")
	}
	tokenForm.Del("client_id") // RFC 7523 client assertion identifies the client.
	forged := url.Values{}
	for key, values := range tokenForm {
		forged[key] = append([]string(nil), values...)
	}
	parts := strings.Split(forged.Get("client_assertion"), ".")
	first := "A"
	if strings.HasPrefix(parts[2], first) {
		first = "B"
	}
	parts[2] = first + parts[2][1:]
	forged.Set("client_assertion", strings.Join(parts, "."))
	if failed := post(FAPITokenHTTP{Exchange: exchange}, tokenEndpoint, forged, tokenProof("http-token-forged", "")); failed.Code != 400 || !strings.Contains(failed.Body.String(), "invalid_client") {
		t.Fatal("unsigned client lookup hint authenticated")
	}
	w = post(FAPITokenHTTP{Exchange: exchange}, tokenEndpoint, tokenForm, tokenProof("http-token-proof", ""))
	n = challenge(w)
	missingVerifier := url.Values{}
	for key, values := range tokenForm {
		missingVerifier[key] = append([]string(nil), values...)
	}
	missingVerifier.Del("code_verifier")
	if failed := post(FAPITokenHTTP{Exchange: exchange}, tokenEndpoint, missingVerifier, tokenProof("http-token-proof", n)); failed.Code != 400 || !strings.Contains(failed.Body.String(), "invalid_grant") {
		t.Fatal("missing verifier did not return invalid_grant")
	}
	// The failed verifier cannot consume the code, assertion or DPoP proof.
	w = post(FAPITokenHTTP{Exchange: exchange}, tokenEndpoint, tokenForm, tokenProof("http-token-proof", n))
	if w.Code != 200 {
		t.Fatalf("token retry: %d %s", w.Code, w.Body.String())
	}
	var refresh string
	if err = p.Store.Transaction(func() error {
		var e error
		refresh, e = p.Grants.IssueRefreshInTransaction(context.Background(), FAPIRefresh{RefreshGrant: RefreshGrant{ProjectID: p.Grants.ProjectID, ClientID: values.Get("client_id"), UserID: "user", SessionID: "session", Scope: "openid offline_access", ExpiresAt: p.Store.Now().Add(time.Hour)}, DPoPJKT: jkt, PolicyVersion: currentPolicy.Version})
		return e
	}); err != nil {
		t.Fatal(err)
	}
	var mintedScope string
	exchange.Mint = func(_ context.Context, g FAPIExchangeGrant) ([]byte, error) {
		mintedScope = g.Scope
		return []byte(`{"access_token":"synthetic","token_type":"DPoP"}`), nil
	}
	refreshForm := url.Values{"grant_type": {"refresh_token"}, "client_assertion_type": {privateKeyAssertionType}, "client_assertion": {assertion("http-refresh-scope-assertion")}, "refresh_token": {refresh}, "scope": {"openid payments.write"}}
	if failed := post(FAPITokenHTTP{Exchange: exchange}, tokenEndpoint, refreshForm, tokenProof("http-refresh-scope-proof", n)); failed.Code != 400 || !strings.Contains(failed.Body.String(), "invalid_scope") {
		t.Fatalf("expanded refresh scope status %d %s", failed.Code, failed.Body.String())
	}
	refreshForm.Set("scope", "offline_access openid")
	if result := post(FAPITokenHTTP{Exchange: exchange}, tokenEndpoint, refreshForm, tokenProof("http-refresh-scope-proof", n)); result.Code != 200 || mintedScope != "openid offline_access" {
		t.Fatalf("refresh scope retry %d %s", result.Code, result.Body.String())
	}
}
