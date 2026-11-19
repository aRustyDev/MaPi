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
	created, err := apps.CreateOrRevise(ctx, project.ID, []byte(`{"slug":"rp","name":"RP","clients":[{"slug":"web","type":"confidential","grant_types":["authorization_code"],"redirect_uris":["https://rp.example/callback"]}]}`))
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
	var leaks int
	if err = db.QueryRow(`SELECT count(*) FROM events WHERE payload LIKE ? OR payload LIKE ?`, "%"+form.Get("client_assertion")+"%", "%"+goodProof+"%").Scan(&leaks); err != nil || leaks != 0 {
		t.Fatal("credentials leaked to audit")
	}
}
