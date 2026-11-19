package mapioauth

import (
	"context"
	"crypto/ecdsa"
	"crypto/ed25519"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/rsa"
	"errors"
	"fmt"
	"net/http/httptest"
	"net/url"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/go-jose/go-jose/v4"
	"github.com/go-jose/go-jose/v4/jwt"
	"github.com/zitadel/nextgen/internal/domain"
)

type assertionFixture struct {
	store   ClientAssertions
	now     time.Time
	signers map[string]jose.Signer
	keys    map[string]jose.JSONWebKey
}

func makeAssertions(t *testing.T) assertionFixture {
	t.Helper()
	ctx := context.Background()
	store, _ := fixture(t)
	now := store.Now()
	apps := applicationStatementsFixture{client: &domain.ApplicationClient{ProjectID: "proj_A", ApplicationID: "app_A", ID: "row_A", Slug: "web", ClientID: "client_A"}, app: &domain.Application{ID: "app_A", RevisionID: "rev_A", Document: []byte(`{"slug":"shop","name":"Shop","clients":[{"slug":"web","client_id":"client_A","grant_types":["authorization_code","refresh_token"],"redirect_uris":["https://shop.example/callback"]}]}`)}}
	a := ClientAssertions{ProjectID: "proj_A", Issuer: "https://issuer.example/oauth/proj_A", Store: store, Registry: ClientRegistry{Statements: apps}, AuditKeys: func(ctx context.Context, client string, ids []string) error {
		_, err := store.DB.ExecContext(ctx, "INSERT INTO issued_tokens VALUES (?)", "key-change")
		return err
	}, AuditAuthentication: func(ctx context.Context, client, kid string) error {
		_, err := store.DB.ExecContext(ctx, "INSERT INTO issued_tokens VALUES (?)", "assertion-use")
		return err
	}}
	if err := a.CreateSchema(ctx); err != nil {
		t.Fatal(err)
	}
	rsaKey, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	ecKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	edPublic, edPrivate, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	signers := map[string]jose.Signer{}
	keys := map[string]jose.JSONWebKey{}
	for _, entry := range []struct {
		id, alg         string
		private, public any
	}{{"rsa", "PS256", rsaKey, &rsaKey.PublicKey}, {"ec", "ES256", ecKey, &ecKey.PublicKey}, {"ed", "EdDSA", edPrivate, edPublic}} {
		signer, err := jose.NewSigner(jose.SigningKey{Algorithm: jose.SignatureAlgorithm(entry.alg), Key: &jose.JSONWebKey{Key: entry.private, KeyID: entry.id}}, nil)
		if err != nil {
			t.Fatal(err)
		}
		signers[entry.id] = signer
		keys[entry.id] = jose.JSONWebKey{Key: entry.public, KeyID: entry.id, Algorithm: entry.alg, Use: "sig"}
	}
	if err := a.SetKeys(ctx, "client_A", []jose.JSONWebKey{keys["rsa"], keys["ec"], keys["ed"]}); err != nil {
		t.Fatal(err)
	}
	return assertionFixture{store: a, now: now, signers: signers, keys: keys}
}
func (f assertionFixture) claims(id string) map[string]any {
	return map[string]any{"iss": "client_A", "sub": "client_A", "aud": f.store.Issuer, "jti": id, "exp": f.now.Add(time.Minute).Unix(), "iat": f.now.Unix()}
}
func (f assertionFixture) sign(t *testing.T, key string, claims any) string {
	t.Helper()
	token, err := jwt.Signed(f.signers[key]).Claims(claims).Serialize()
	if err != nil {
		t.Fatal(err)
	}
	return token
}
func (f assertionFixture) check(raw string) error {
	return f.store.Store.Transaction(func() error {
		_, err := f.store.AuthenticateInTransaction(context.Background(), "client_A", privateKeyAssertionType, raw)
		return err
	})
}

func TestClientAssertionsAlgorithmsClaimsAndReplay(t *testing.T) {
	f := makeAssertions(t)
	for _, key := range []string{"rsa", "ec", "ed"} {
		token := f.sign(t, key, f.claims("jti-"+key))
		if err := f.check(token); err != nil {
			t.Fatalf("%s rejected: %v", key, err)
		}
		if err := f.check(token); !errors.Is(err, ErrInvalidClient) {
			t.Fatalf("%s replay accepted: %v", key, err)
		}
	}
	for _, caseFn := range []func(map[string]any){
		func(c map[string]any) { c["iss"] = "foreign" }, func(c map[string]any) { c["sub"] = "foreign" }, func(c map[string]any) { c["aud"] = "https://issuer.example/oauth/proj_B" }, func(c map[string]any) { c["aud"] = []string{f.store.Issuer} }, func(c map[string]any) { delete(c, "jti") }, func(c map[string]any) { delete(c, "exp") }, func(c map[string]any) { c["exp"] = f.now.Unix() }, func(c map[string]any) { c["exp"] = f.now.Add(6 * time.Minute).Unix() }, func(c map[string]any) { c["iat"] = f.now.Add(61 * time.Second).Unix() }, func(c map[string]any) { c["nbf"] = f.now.Add(61 * time.Second).Unix() },
	} {
		claims := f.claims("invalid")
		caseFn(claims)
		if err := f.check(f.sign(t, "ec", claims)); !errors.Is(err, ErrInvalidClient) {
			t.Fatalf("invalid assertion accepted: %v", err)
		}
	}
	future := f.claims("allow-10-seconds")
	future["iat"] = f.now.Add(10 * time.Second).Unix()
	future["nbf"] = f.now.Add(10 * time.Second).Unix()
	if err := f.check(f.sign(t, "ed", future)); err != nil {
		t.Fatalf("required ten-second tolerance rejected: %v", err)
	}
	withoutIAT := f.claims("no-iat")
	delete(withoutIAT, "iat")
	if err := f.check(f.sign(t, "ed", withoutIAT)); err != nil {
		t.Fatalf("optional iat rejected: %v", err)
	}
	raw := fmt.Sprintf(`{"iss":"client_A","sub":"client_A","aud":%q,"jti":"duplicate","jti":"other","exp":%d}`, f.store.Issuer, f.now.Add(time.Minute).Unix())
	signed, err := f.signers["rsa"].Sign([]byte(raw))
	if err != nil {
		t.Fatal(err)
	}
	token, err := signed.CompactSerialize()
	if err != nil {
		t.Fatal(err)
	}
	if err = f.check(token); !errors.Is(err, ErrInvalidClient) {
		t.Fatal("duplicate claim accepted")
	}
	wrongType := f.store.Store.Transaction(func() error {
		_, err := f.store.AuthenticateInTransaction(context.Background(), "client_A", "wrong", f.sign(t, "rsa", f.claims("wrong-type")))
		return err
	})
	if !errors.Is(wrongType, ErrInvalidClient) {
		t.Fatal("wrong assertion type accepted")
	}
}

func TestClientAssertionAtomicConcurrencyAndKeyRollover(t *testing.T) {
	f := makeAssertions(t)
	ctx := context.Background()
	token := f.sign(t, "rsa", f.claims("raced"))
	var successes atomic.Int32
	var wg sync.WaitGroup
	for range 10 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			err := f.check(token)
			if err == nil {
				successes.Add(1)
			} else if !errors.Is(err, ErrInvalidClient) {
				t.Errorf("unexpected error: %v", err)
			}
		}()
	}
	wg.Wait()
	if successes.Load() != 1 {
		t.Fatalf("expected one assertion acceptance, got %d", successes.Load())
	}
	failure := errors.New("injected audit failure")
	broken := f.store
	broken.AuditAuthentication = func(context.Context, string, string) error { return failure }
	fresh := f.sign(t, "ec", f.claims("rollback"))
	err := broken.Store.Transaction(func() error {
		_, err := broken.AuthenticateInTransaction(ctx, "client_A", privateKeyAssertionType, fresh)
		return err
	})
	if !errors.Is(err, failure) {
		t.Fatal("audit failure not propagated")
	}
	if err = f.check(fresh); err != nil {
		t.Fatalf("audit failure retained replay entry: %v", err)
	}
	if err = f.store.SetKeys(ctx, "client_A", []jose.JSONWebKey{f.keys["rsa"], f.keys["ec"]}); err != nil {
		t.Fatal(err)
	}
	if err = f.check(f.sign(t, "ed", f.claims("retired"))); !errors.Is(err, ErrInvalidClient) {
		t.Fatal("retired key accepted")
	}
	if err = f.store.SetKeys(ctx, "client_A", []jose.JSONWebKey{f.keys["ed"], f.keys["ec"]}); err == nil {
		t.Fatal("retired key reactivated")
	}
	if err = f.store.SetKeys(ctx, "client_A", []jose.JSONWebKey{f.keys["rsa"], f.keys["ec"]}); err != nil {
		t.Fatal(err)
	}
	if err = f.store.RevokeKeys(ctx, "client_A"); err != nil {
		t.Fatal(err)
	}
	if err = f.check(f.sign(t, "ec", f.claims("revoked"))); !errors.Is(err, ErrInvalidClient) {
		t.Fatal("revoked key accepted")
	}
	if err = f.store.RevokeKeys(ctx, "client_A"); err != nil {
		t.Fatal(err)
	}
}

func TestClientAssertionsProjectIsolationAndKeyValidation(t *testing.T) {
	f := makeAssertions(t)
	ctx := context.Background()
	source := f.store.Registry.Statements.(applicationStatementsFixture)
	otherClient := *source.client
	otherClient.ProjectID = "proj_B"
	source.client = &otherClient
	other := f.store
	other.ProjectID = "proj_B"
	other.Issuer = "https://issuer.example/oauth/proj_B"
	other.Registry = ClientRegistry{Statements: source}
	if err := other.SetKeys(ctx, "client_A", []jose.JSONWebKey{f.keys["rsa"]}); err != nil {
		t.Fatal(err)
	}
	sameJTI := f.claims("same-jti")
	tokenA := f.sign(t, "rsa", sameJTI)
	if err := f.check(tokenA); err != nil {
		t.Fatal(err)
	}
	sameJTI["aud"] = other.Issuer
	tokenB := f.sign(t, "rsa", sameJTI)
	if err := f.check(tokenB); !errors.Is(err, ErrInvalidClient) {
		t.Fatal("foreign issuer accepted")
	}
	if err := other.Store.Transaction(func() error {
		_, err := other.AuthenticateInTransaction(ctx, "client_A", privateKeyAssertionType, tokenB)
		return err
	}); err != nil {
		t.Fatalf("same client ID/JTI should remain project-scoped: %v", err)
	}
	weak, err := rsa.GenerateKey(rand.Reader, 1024)
	if err != nil {
		t.Fatal(err)
	}
	invalid := []jose.JSONWebKey{{Key: &weak.PublicKey, KeyID: "weak", Algorithm: "PS256", Use: "sig"}, {Key: []byte("symmetric-secret"), KeyID: "symmetric", Algorithm: "HS256", Use: "sig"}, {Key: f.keys["rsa"].Key, KeyID: "algorithm-confusion", Algorithm: "RS256", Use: "sig"}, {Key: f.keys["rsa"].Key, KeyID: "encryption-use", Algorithm: "PS256", Use: "enc"}, {Key: f.keys["rsa"].Key, KeyID: "bad id", Algorithm: "PS256", Use: "sig"}}
	for _, key := range invalid {
		if err := f.store.SetKeys(ctx, "client_A", []jose.JSONWebKey{key}); err == nil {
			t.Fatalf("unsafe key %q accepted", key.KeyID)
		}
	}
	if err := f.store.SetKeys(ctx, "client_A", []jose.JSONWebKey{f.keys["rsa"], f.keys["rsa"]}); err == nil {
		t.Fatal("duplicate kid accepted")
	}
	broken := f.store
	failure := errors.New("injected key audit failure")
	broken.AuditKeys = func(context.Context, string, []string) error { return failure }
	if err := broken.SetKeys(ctx, "client_A", []jose.JSONWebKey{f.keys["ec"]}); !errors.Is(err, failure) {
		t.Fatal("key rotation did not fail on audit")
	}
	if err := f.check(f.sign(t, "ed", f.claims("after-key-audit-failure"))); err != nil {
		t.Fatalf("failed key rotation was not rolled back: %v", err)
	}
}

func TestClientAssertionRejectsUntrustedJOSEHeaders(t *testing.T) {
	f := makeAssertions(t)
	ctx := context.Background()
	private, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	key := jose.JSONWebKey{Key: &private.PublicKey, KeyID: "header-key", Algorithm: "ES256", Use: "sig"}
	if err = f.store.SetKeys(ctx, "client_A", []jose.JSONWebKey{key}); err != nil {
		t.Fatal(err)
	}
	signer, err := jose.NewSigner(jose.SigningKey{Algorithm: jose.ES256, Key: &jose.JSONWebKey{Key: private, KeyID: key.KeyID}}, (&jose.SignerOptions{}).WithHeader("jku", "https://attacker.example/keys"))
	if err != nil {
		t.Fatal(err)
	}
	raw, err := jwt.Signed(signer).Claims(f.claims("jku")).Serialize()
	if err != nil {
		t.Fatal(err)
	}
	if err = f.check(raw); !errors.Is(err, ErrInvalidClient) {
		t.Fatal("untrusted JKU accepted")
	}
}

func TestPARAuthenticatorRejectsMixedAndDuplicateCredentials(t *testing.T) {
	f := makeAssertions(t)
	ctx := context.Background()
	token := f.sign(t, "ec", f.claims("par-credentials"))
	form := url.Values{"client_id": {"client_A"}, "client_assertion_type": {privateKeyAssertionType}, "client_assertion": {token}}
	request := httptest.NewRequest("POST", "https://issuer.example/par", nil)
	request.Header.Set("Authorization", "Basic invalid")
	if err := f.store.Store.Transaction(func() error { _, err := f.store.PARAuthenticator()(ctx, request, form); return err }); !errors.Is(err, ErrInvalidClient) {
		t.Fatal("mixed client authentication accepted")
	}
	request.Header.Del("Authorization")
	duplicate := url.Values{"client_id": {"client_A", "client_A"}, "client_assertion_type": {privateKeyAssertionType}, "client_assertion": {token}}
	if err := f.store.Store.Transaction(func() error { _, err := f.store.PARAuthenticator()(ctx, request, duplicate); return err }); !errors.Is(err, ErrInvalidClient) {
		t.Fatal("duplicate client ID accepted")
	}
	if err := f.store.Store.Transaction(func() error {
		id, err := f.store.PARAuthenticator()(ctx, request, form)
		if err == nil && id != "client_A" {
			t.Error("wrong authenticated client")
		}
		return err
	}); err != nil {
		t.Fatalf("valid assertion lost on rejection: %v", err)
	}
}
