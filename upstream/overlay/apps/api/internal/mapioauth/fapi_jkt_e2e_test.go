//go:build mapi_native_e2e && !wasip1

package mapioauth

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/go-jose/go-jose/v4"
	"github.com/go-jose/go-jose/v4/jwt"
	"github.com/zitadel/nextgen/internal/mapidpop"
)

// End-to-end native primitive chain with a real registered client and signed
// assertions/proofs. The session callback is a synthetic stand-in; the local
// workerd counterpart uses a real upstream password-created session.
func exerciseJKTOnly(t *testing.T, p *PrivatePAR, db *sql.DB, now *time.Time, client, jkt string, assertion func(string) string, signer jose.Signer) {
	t.Helper()
	ctx := context.Background()
	verifier := "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~"
	sum := sha256.Sum256([]byte(verifier))
	form := url.Values{"client_id": {client}, "client_assertion_type": {privateKeyAssertionType}, "client_assertion": {assertion("jkt-only-client")}, "response_type": {"code"}, "redirect_uri": {"https://rp.example/callback"}, "scope": {"openid payments.read"}, "state": {"jkt-state"}, "nonce": {"jkt-nonce"}, "code_challenge": {base64.RawURLEncoding.EncodeToString(sum[:])}, "code_challenge_method": {"S256"}, "dpop_jkt": {jkt}}
	proof := func(s jose.Signer, id, endpoint, nonce string) string {
		v, e := jwt.Signed(s).Claims(map[string]any{"jti": id, "htm": "POST", "htu": endpoint, "iat": now.Unix(), "nonce": nonce}).Serialize()
		if e != nil {
			t.Fatal(e)
		}
		return v
	}
	post := func(h http.Handler, endpoint string, v url.Values, raw string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(http.MethodPost, endpoint, strings.NewReader(v.Encode()))
		r.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		if raw != "" {
			r.Header.Set("DPoP", raw)
		}
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		return w
	}
	par := FAPIPARHTTP{Private: p}
	form.Set("dpop_jkt", "")
	if w := post(par, p.PAR.Endpoint, form, ""); w.Code != 400 {
		t.Fatal("empty JKT accepted")
	}
	form.Set("dpop_jkt", jkt)
	emptyHeader := httptest.NewRequest(http.MethodPost, p.PAR.Endpoint, strings.NewReader(form.Encode()))
	emptyHeader.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	emptyHeader.Header.Set("DPoP", "")
	wEmpty := httptest.NewRecorder()
	par.ServeHTTP(wEmpty, emptyHeader)
	if wEmpty.Code != 400 {
		t.Fatal("empty DPoP header accepted")
	}
	form.Set("dpop_jkt", strings.Repeat("!", 43))
	if w := post(par, p.PAR.Endpoint, form, ""); w.Code != 400 {
		t.Fatal("malformed JKT accepted")
	}
	form.Set("dpop_jkt", jkt)
	parNonce, e := p.Nonces.Issue(ctx, mapidpop.NonceScope{ProjectID: p.PAR.ProjectID, ClientID: client, Purpose: "par"})
	if e != nil {
		t.Fatal(e)
	}
	other := sha256.Sum256([]byte("wrong key"))
	wrongJKT := base64.RawURLEncoding.EncodeToString(other[:])
	form.Set("dpop_jkt", wrongJKT)
	w := post(par, p.PAR.Endpoint, form, proof(signer, "jkt-mismatch", p.PAR.Endpoint, parNonce))
	if w.Code != 400 || w.Header().Get("DPoP-Nonce") != "" {
		t.Fatalf("mismatched PAR: %d %s", w.Code, w.Body.String())
	}
	form.Set("dpop_jkt", jkt)
	w = post(par, p.PAR.Endpoint, form, "")
	if w.Code != 201 || w.Header().Get("DPoP-Nonce") != "" {
		t.Fatalf("proofless PAR: %d %s", w.Code, w.Body.String())
	}
	var pr struct {
		RequestURI string `json:"request_uri"`
	}
	if json.Unmarshal(w.Body.Bytes(), &pr) != nil || pr.RequestURI == "" {
		t.Fatal("PAR handle missing")
	}
	if _, e = db.Exec(`CREATE TABLE fapi_jkt_test_audit (action TEXT NOT NULL)`); e != nil {
		t.Fatal(e)
	}
	fail := false
	login := FAPILogin{Store: p.Store, ProjectID: p.PAR.ProjectID, LoginTTL: time.Minute, CodeTTL: time.Minute, Codes: p.Grants, CheckClient: p.PAR.CheckClient, PolicyVersion: p.PAR.PolicyVersion, Session: func(_ context.Context, project, cookie string) (LoginIdentity, error) {
		if project != p.PAR.ProjectID || cookie != "synthetic-session" {
			return LoginIdentity{}, ErrInvalidLogin
		}
		return LoginIdentity{ProjectID: project, UserID: "user", SessionID: "session"}, nil
	}, Audit: func(ctx context.Context, action string, _ AuthorizationCode, _ string) error {
		if _, e := db.ExecContext(ctx, `INSERT INTO fapi_jkt_test_audit VALUES (?)`, action); e != nil {
			return e
		}
		if fail {
			return errors.New("injected audit failure")
		}
		return nil
	}}
	begin := func() (string, string, error) {
		var handle, binding string
		err := p.PAR.Consume(ctx, p.PAR.ProjectID, client, pr.RequestURI, func(ctx context.Context, r PushedAuthorizationRequest) error {
			if r.DPoPJKT != jkt {
				return errors.New("lost PAR JKT")
			}
			var e error
			handle, binding, e = login.BeginInTransaction(ctx, r)
			return e
		})
		return handle, binding, err
	}
	count := func(table string) int {
		var n int
		if err := db.QueryRow("SELECT count(*) FROM " + table).Scan(&n); err != nil {
			t.Fatal(err)
		}
		return n
	}
	fail = true
	if _, _, e = begin(); e == nil || count("fapi_jkt_test_audit") != 0 {
		t.Fatal("PAR/login audit rollback")
	}
	fail = false
	handle, binding, e := begin()
	if e != nil {
		t.Fatal(e)
	}
	if _, _, e = begin(); !errors.Is(e, ErrInvalidPAR) {
		t.Fatal("PAR replay accepted")
	}
	fail = true
	if _, e = login.Complete(ctx, handle, binding, "synthetic-session"); e == nil || count("fapi_jkt_test_audit") != 1 {
		t.Fatal("code audit rollback")
	}
	fail = false
	completed, e := login.Complete(ctx, handle, binding, "synthetic-session")
	if e != nil {
		t.Fatal(e)
	}
	if _, e = login.Complete(ctx, handle, binding, "synthetic-session"); e == nil {
		t.Fatal("login replay accepted")
	}
	tokenNonce, e := p.Nonces.Issue(ctx, mapidpop.NonceScope{ProjectID: p.PAR.ProjectID, ClientID: client, Purpose: "token"})
	if e != nil {
		t.Fatal(e)
	}
	endpoint := p.Assertions.Issuer + "/token"
	exchange := FAPIExchange{Private: p, CheckSession: func(_ context.Context, project, user, session string) error {
		if project != p.PAR.ProjectID || user != "user" || session != "session" {
			return ErrInvalidLogin
		}
		return nil
	}, Mint: func(_ context.Context, g FAPIExchangeGrant) ([]byte, error) {
		if g.DPoPJKT != jkt || g.Scope != "openid payments.read" {
			return nil, errors.New("lost code binding or granted scope")
		}
		return []byte(`{"access_token":"synthetic","token_type":"DPoP"}`), nil
	}, Audit: func(ctx context.Context, _ FAPIExchangeGrant) error {
		if _, e := db.ExecContext(ctx, `INSERT INTO fapi_jkt_test_audit VALUES ('token')`); e != nil {
			return e
		}
		if fail {
			return errors.New("injected token audit failure")
		}
		return nil
	}}
	exchange.AuditReuse = exchange.Audit
	tf := url.Values{"grant_type": {"authorization_code"}, "client_id": {client}, "client_assertion_type": {privateKeyAssertionType}, "client_assertion": {assertion("jkt-token")}, "code": {completed.Code}, "redirect_uri": {"https://rp.example/callback"}, "code_verifier": {verifier}}
	token := FAPITokenHTTP{Exchange: exchange}
	if w = post(token, endpoint, tf, ""); w.Code != 400 {
		t.Fatal("token without proof accepted")
	}
	wrongKey, e := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if e != nil {
		t.Fatal(e)
	}
	wrongSigner, e := jose.NewSigner(jose.SigningKey{Algorithm: jose.ES256, Key: wrongKey}, (&jose.SignerOptions{}).WithHeader("typ", "dpop+jwt").WithHeader("jwk", jose.JSONWebKey{Key: &wrongKey.PublicKey}))
	if e != nil {
		t.Fatal(e)
	}
	w = post(token, endpoint, tf, proof(wrongSigner, "jkt-wrong-proof", endpoint, tokenNonce))
	if w.Code != 400 || w.Header().Get("DPoP-Nonce") != "" {
		t.Fatal("wrong proof key accepted")
	}
	raw := proof(signer, "jkt-good-proof", endpoint, tokenNonce)
	before := count("fapi_jkt_test_audit")
	fail = true
	w = post(token, endpoint, tf, raw)
	if w.Code != 500 || count("fapi_jkt_test_audit") != before {
		t.Fatal("token audit rollback")
	}
	fail = false
	w = post(token, endpoint, tf, raw)
	if w.Code != 200 {
		t.Fatalf("token retry: %d %s", w.Code, w.Body.String())
	}
	tf.Set("client_assertion", assertion("jkt-token-proof-replay"))
	w = post(token, endpoint, tf, raw)
	if w.Code != 400 || !strings.Contains(w.Body.String(), "invalid_dpop_proof") {
		t.Fatal("token DPoP proof replay accepted")
	}
	tf.Set("client_assertion", assertion("jkt-token-replay"))
	w = post(token, endpoint, tf, proof(signer, "jkt-replay", endpoint, tokenNonce))
	if w.Code != 400 {
		t.Fatal("code replay accepted")
	}
}
