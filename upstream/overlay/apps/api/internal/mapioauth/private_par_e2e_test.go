//go:build mapi_native_e2e && !wasip1

package mapioauth

import (
	"context"
	"crypto"
	"crypto/ecdsa"
	"crypto/ed25519"
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
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/go-jose/go-jose/v4"
	"github.com/go-jose/go-jose/v4/jwt"
	"github.com/zitadel/nextgen/internal/domain"
	"github.com/zitadel/nextgen/internal/mapidpop"
	"github.com/zitadel/nextgen/internal/secrets"
	"github.com/zitadel/nextgen/internal/service"
	"github.com/zitadel/nextgen/internal/storage/dialect/sqlite"
	configdefaults "github.com/zitadel/nextgen/packages/config/defaults"
	_ "modernc.org/sqlite"
)

func TestPrivatePARRealClientAndDPoP(t *testing.T) {
	ctx := context.Background()
	db, err := sql.Open("sqlite", filepath.Join(t.TempDir(), "project.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	db.SetMaxOpenConns(1)
	native := sqlite.NewMaPiNativeTestPool(db)
	t.Cleanup(func() { native.Close(ctx) })
	if err = native.Migrate(ctx); err != nil {
		t.Fatal(err)
	}
	project := &domain.Project{ID: "proj_A", Name: "Private PAR"}
	if err = native.Statements().CreateProject(ctx, project); err != nil {
		t.Fatal(err)
	}
	schemas, err := domain.NewSchemaValidator(configdefaults.DefaultBuiltinSchemaBase)
	if err != nil {
		t.Fatal(err)
	}
	pool := service.NewPool(native)
	apps := service.NewApplicationService(pool, schemas, secrets.NewRandomSecretGenerator())
	created, err := apps.CreateOrRevise(ctx, project.ID, []byte(`{"slug":"rp","name":"RP","clients":[{"slug":"web","type":"confidential","grant_types":["authorization_code","refresh_token"],"redirect_uris":["https://rp.example/callback"]}]}`))
	if err != nil {
		t.Fatal(err)
	}
	client := created.Secrets[0].ClientID
	var mu sync.Mutex
	now := time.Unix(1800000000, 0)
	store := Store{DB: db, Now: func() time.Time { return now }, Transaction: func(fn func() error) error {
		mu.Lock()
		defer mu.Unlock()
		if _, err := db.Exec("BEGIN"); err != nil {
			return err
		}
		if err := fn(); err != nil {
			_, _ = db.Exec("ROLLBACK")
			return err
		}
		_, err := db.Exec("COMMIT")
		return err
	}}
	private, err := NewPrivatePAR(PrivatePARConfig{ProjectID: project.ID, Issuer: "https://issuer.example/oauth/proj_A", Store: store, Pool: pool})
	if err != nil {
		t.Fatal(err)
	}
	if err = private.InitializeSchema(ctx); err != nil {
		t.Fatal(err)
	}
	if err = private.InitializeSchema(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err = private.Policies.Put(ctx, client, client, []string{"payments.read"}, true, 0); err != nil {
		t.Fatal(err)
	}
	serverNonce, err := private.Nonces.Issue(ctx, mapidpop.NonceScope{ProjectID: project.ID, ClientID: client, Purpose: "par"})
	if err != nil {
		t.Fatal(err)
	}
	pub, clientKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	if err = private.Assertions.SetKeys(ctx, client, []jose.JSONWebKey{{Key: pub, KeyID: "client-key", Algorithm: "EdDSA", Use: "sig"}}); err != nil {
		t.Fatal(err)
	}
	signer, err := jose.NewSigner(jose.SigningKey{Algorithm: jose.EdDSA, Key: &jose.JSONWebKey{Key: clientKey, KeyID: "client-key"}}, nil)
	if err != nil {
		t.Fatal(err)
	}
	assertion := func(jti string) string {
		raw, err := jwt.Signed(signer).Claims(map[string]any{"iss": client, "sub": client, "aud": private.Assertions.Issuer, "jti": jti, "exp": now.Add(time.Minute).Unix()}).Serialize()
		if err != nil {
			t.Fatal(err)
		}
		return raw
	}
	proofKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	jwk := jose.JSONWebKey{Key: &proofKey.PublicKey}
	thumb, err := jwk.Thumbprint(crypto.SHA256)
	if err != nil {
		t.Fatal(err)
	}
	jkt := base64.RawURLEncoding.EncodeToString(thumb)
	proofSigner, err := jose.NewSigner(jose.SigningKey{Algorithm: jose.ES256, Key: proofKey}, (&jose.SignerOptions{}).WithHeader("typ", "dpop+jwt").WithHeader("jwk", jwk))
	if err != nil {
		t.Fatal(err)
	}
	proof := func(jti, nonce string) string {
		raw, err := jwt.Signed(proofSigner).Claims(map[string]any{"jti": jti, "htm": "POST", "htu": private.PAR.Endpoint, "iat": now.Unix(), "nonce": nonce}).Serialize()
		if err != nil {
			t.Fatal(err)
		}
		return raw
	}
	challenge := sha256.Sum256([]byte("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~"))
	form := url.Values{"client_id": {client}, "client_assertion_type": {privateKeyAssertionType}, "client_assertion": {assertion("assertion-1")}, "response_type": {"code"}, "redirect_uri": {"https://rp.example/callback"}, "scope": {"openid"}, "state": {"state"}, "nonce": {"nonce"}, "code_challenge": {base64.RawURLEncoding.EncodeToString(challenge[:])}, "code_challenge_method": {"S256"}, "dpop_jkt": {jkt}}
	request := func(values url.Values, dpop string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(http.MethodPost, private.PAR.Endpoint, strings.NewReader(values.Encode()))
		r.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		if dpop != "" {
			r.Header.Set("DPoP", dpop)
		}
		w := httptest.NewRecorder()
		(PARHTTP{PAR: private.PAR}).ServeHTTP(w, r)
		return w
	}
	if w := request(form, proof("proof-1", "wrong-nonce")); w.Code != 400 {
		t.Fatalf("invalid nonce status: %d", w.Code)
	}
	count := func(table string) int {
		var n int
		if err := db.QueryRow("SELECT count(*) FROM " + table).Scan(&n); err != nil {
			t.Fatal(err)
		}
		return n
	}
	if count("mapi_oauth_client_assertion_jtis") != 0 || count("mapi_dpop_replay") != 0 || count("mapi_oauth_par") != 0 {
		t.Fatal("failed proof retained state")
	}
	goodProof := proof("proof-1", serverNonce)
	w := request(form, goodProof)
	if w.Code != 201 {
		t.Fatalf("valid PAR: %d %s", w.Code, w.Body.String())
	}
	var response struct {
		RequestURI string `json:"request_uri"`
	}
	if err = json.Unmarshal(w.Body.Bytes(), &response); err != nil || response.RequestURI == "" {
		t.Fatal("missing PAR handle")
	}
	form.Set("client_assertion", assertion("assertion-2"))
	if w = request(form, goodProof); w.Code != 400 {
		t.Fatal("DPoP replay accepted")
	}
	// Failed DPoP rolls back the new assertion, so its valid retry is accepted.
	if w = request(form, proof("proof-2", serverNonce)); w.Code != 201 {
		t.Fatalf("retry failed: %d %s", w.Code, w.Body.String())
	}
	if w = request(form, proof("proof-3", serverNonce)); w.Code != 400 {
		t.Fatal("client assertion replay accepted")
	}
	if count("mapi_oauth_client_assertion_jtis") != 2 || count("mapi_dpop_replay") != 2 || count("mapi_oauth_par") != 2 {
		t.Fatal("unexpected state after replay tests")
	}
	abort := errors.New("login transaction failed")
	err = private.PAR.Consume(ctx, project.ID, client, response.RequestURI, func(context.Context, PushedAuthorizationRequest) error { return abort })
	if !errors.Is(err, abort) {
		t.Fatal("expected consume failure")
	}
	err = private.PAR.Consume(ctx, project.ID, client, response.RequestURI, func(_ context.Context, p PushedAuthorizationRequest) error {
		if p.DPoPJKT != jkt || p.ClientID != client {
			t.Error("binding not preserved")
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if err = private.PAR.Consume(ctx, project.ID, client, response.RequestURI, func(context.Context, PushedAuthorizationRequest) error { return nil }); !errors.Is(err, ErrInvalidPAR) {
		t.Fatal("PAR handle replay accepted")
	}
	// RFC 9449 permits a JKT commitment without a PAR proof, and FAPI
	// permits a code without key binding. The token endpoint must still
	// verify a proof before issuing a DPoP-bound token in either case.
	form.Set("client_assertion", assertion("assertion-jkt-only"))
	w = request(form, "")
	if w.Code != 201 {
		t.Fatalf("JKT-only PAR rejected: %d %s", w.Code, w.Body.String())
	}
	var jktOnly struct {
		RequestURI string `json:"request_uri"`
	}
	if err = json.Unmarshal(w.Body.Bytes(), &jktOnly); err != nil {
		t.Fatal(err)
	}
	if err = private.PAR.Consume(ctx, project.ID, client, jktOnly.RequestURI, func(_ context.Context, p PushedAuthorizationRequest) error {
		if p.DPoPJKT != jkt {
			t.Error("JKT commitment lost")
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	form.Set("client_assertion", assertion("assertion-unbound"))
	form.Del("dpop_jkt")
	w = request(form, "")
	if w.Code != 201 {
		t.Fatalf("unbound PAR rejected: %d %s", w.Code, w.Body.String())
	}
	var unbound struct {
		RequestURI string `json:"request_uri"`
	}
	if err = json.Unmarshal(w.Body.Bytes(), &unbound); err != nil {
		t.Fatal(err)
	}
	if err = private.PAR.Consume(ctx, project.ID, client, unbound.RequestURI, func(_ context.Context, p PushedAuthorizationRequest) error {
		if p.DPoPJKT != "" {
			t.Error("unbound request unexpectedly bound")
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	// Compose real client assertion, nonce and DPoP verification with the
	// grant store. The signer and session callbacks are synthetic: this test
	// does not claim that FAPI signed access tokens are implemented.
	tokenNonce, err := private.Nonces.Issue(ctx, mapidpop.NonceScope{ProjectID: project.ID, ClientID: client, Purpose: "token"})
	if err != nil {
		t.Fatal(err)
	}
	tokenProof := func(id, nonce string) string {
		raw, err := jwt.Signed(proofSigner).Claims(map[string]any{"jti": id, "htm": "POST", "htu": private.Assertions.Issuer + "/token", "iat": now.Unix(), "nonce": nonce}).Serialize()
		if err != nil {
			t.Fatal(err)
		}
		return raw
	}
	if _, err = db.Exec(`CREATE TABLE fapi_exchange_test_audit (client TEXT NOT NULL)`); err != nil {
		t.Fatal(err)
	}
	failure := errors.New("injected audit failure")
	failAudit := true
	exchange := FAPIExchange{Private: private,
		CheckSession: func(_ context.Context, projectID, userID, sessionID string) error {
			if projectID != project.ID || userID != "user" || sessionID != "session" {
				return ErrInvalidLogin
			}
			return nil
		},
		Mint: func(_ context.Context, g FAPIExchangeGrant) ([]byte, error) {
			if g.DPoPJKT != jkt {
				return nil, errors.New("binding lost")
			}
			return []byte("synthetic-result"), nil
		},
		Audit: func(ctx context.Context, g FAPIExchangeGrant) error {
			if _, err := db.ExecContext(ctx, `INSERT INTO fapi_exchange_test_audit VALUES (?)`, g.ClientID); err != nil {
				return err
			}
			if failAudit {
				return failure
			}
			return nil
		},
	}
	exchange.AuditReuse = exchange.Audit
	codeGrant := AuthorizationCode{ProjectID: project.ID, ClientID: client, RedirectURI: "https://rp.example/callback", UserID: "user", SessionID: "session", Scope: "openid", Nonce: "nonce", CodeChallenge: base64.RawURLEncoding.EncodeToString(challenge[:]), ExpiresAt: now.Add(30 * time.Second), PolicyVersion: 1}
	var code string
	if err = store.Transaction(func() error {
		var e error
		code, e = private.Grants.IssueCodeInTransaction(ctx, codeGrant, jkt)
		return e
	}); err != nil {
		t.Fatal(err)
	}
	exchangeRequest := FAPIExchangeRequest{ClientID: client, AssertionType: privateKeyAssertionType, Assertion: assertion("exchange-assertion"), Proof: tokenProof("exchange-proof", tokenNonce), Code: code, RedirectURI: codeGrant.RedirectURI, Verifier: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~"}
	if result, err := exchange.ExchangeCode(ctx, exchangeRequest); !errors.Is(err, failure) || result != nil {
		t.Fatalf("failed transaction returned result: %q %v", result, err)
	}
	if count("fapi_exchange_test_audit") != 0 {
		t.Fatal("failed exchange audit persisted")
	}
	failAudit = false
	if result, err := exchange.ExchangeCode(ctx, exchangeRequest); err != nil || string(result) != "synthetic-result" {
		t.Fatalf("valid retry: %q %v", result, err)
	}
	exchangeRequest.Assertion = assertion("exchange-assertion-2")
	exchangeRequest.Proof = tokenProof("exchange-proof-2", tokenNonce)
	if _, err := exchange.ExchangeCode(ctx, exchangeRequest); !errors.Is(err, ErrInvalidCode) {
		t.Fatalf("code replay: %v", err)
	}
	refreshGrant := FAPIRefresh{RefreshGrant: RefreshGrant{ProjectID: project.ID, ClientID: client, UserID: "user", SessionID: "session", Scope: "openid offline_access", ExpiresAt: now.Add(time.Hour)}, DPoPJKT: jkt, PolicyVersion: 1}
	var refresh string
	if err = store.Transaction(func() error {
		var e error
		refresh, e = private.Grants.IssueRefreshInTransaction(ctx, refreshGrant)
		return e
	}); err != nil {
		t.Fatal(err)
	}
	exchangeRequest.Assertion = assertion("refresh-after-code-reuse")
	exchangeRequest.Proof = tokenProof("refresh-after-code-reuse", tokenNonce)
	exchangeRequest.RefreshToken = refresh
	if result, err := exchange.ExchangeRefresh(ctx, exchangeRequest); err != nil || string(result) != "synthetic-result" {
		t.Fatalf("refresh exchange: %q %v", result, err)
	}
	exchangeRequest.Assertion = assertion("exchange-assertion-3")
	if _, err := exchange.ExchangeRefresh(ctx, exchangeRequest); !errors.Is(err, ErrInvalidDPoP) {
		t.Fatalf("DPoP replay: %v", err)
	}
	exchangeRequest.Proof = tokenProof("exchange-proof-3", tokenNonce)
	if _, err := exchange.ExchangeRefresh(ctx, exchangeRequest); err != nil {
		t.Fatalf("fresh refresh proof: %v", err)
	}
	var leaks int
	if err = db.QueryRow(`SELECT count(*) FROM events WHERE payload LIKE ? OR payload LIKE ?`, "%"+form.Get("client_assertion")+"%", "%"+goodProof+"%").Scan(&leaks); err != nil || leaks != 0 {
		t.Fatal("credentials leaked to audit")
	}
	exerciseFAPIAccess(t, private, pool, db, now, client, jkt, assertion, proofSigner, base64.RawURLEncoding.EncodeToString(challenge[:]))
	exerciseFAPINonceHTTP(t, private, db, form, proof, assertion, &now, exchange, tokenProof, codeGrant, jkt)
	exerciseJKTOnly(t, private, db, &now, client, jkt, assertion, proofSigner)
	exerciseFAPIPolicies(t, private, db, client)
	exerciseFAPIGenerationFence(t, private, db, now, client, jkt, assertion, proofSigner)
	exerciseFAPIReload(t, private, db, &now, client, assertion)
	badRedirect := url.Values{"client_id": {client}, "client_assertion_type": {privateKeyAssertionType}, "client_assertion": {assertion("invalid-redirect-assertion")}, "response_type": {"code"}, "redirect_uri": {"https://unregistered.example/callback"}, "scope": {"openid"}, "code_challenge": {base64.RawURLEncoding.EncodeToString(challenge[:])}, "code_challenge_method": {"S256"}}
	if w := request(badRedirect, ""); w.Code != http.StatusBadRequest || !strings.Contains(w.Body.String(), "invalid_request") {
		t.Fatalf("unregistered redirect error: %d %s", w.Code, w.Body.String())
	}

}
