//go:build mapi_native_e2e && !wasip1

package mapioauth

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/rsa"
	"database/sql"
	"encoding/json"
	"errors"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/go-jose/go-jose/v4"
	"github.com/go-jose/go-jose/v4/jwt"
	"github.com/zitadel/nextgen/internal/cache"
	"github.com/zitadel/nextgen/internal/domain"
	"github.com/zitadel/nextgen/internal/secrets"
	"github.com/zitadel/nextgen/internal/service"
	"github.com/zitadel/nextgen/internal/storage/dialect/sqlite"
	configdefaults "github.com/zitadel/nextgen/packages/config/defaults"
	"github.com/zitadel/oidc/v3/pkg/op"
	_ "modernc.org/sqlite"
)

func TestIsolatedProfilesRealServices(t *testing.T) {
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
	project := &domain.Project{ID: "proj_profiles", Name: "Profiles"}
	if err = native.Statements().CreateProject(ctx, project); err != nil {
		t.Fatal(err)
	}
	pool := service.NewPool(native)
	schemas, err := domain.NewSchemaValidator(configdefaults.DefaultBuiltinSchemaBase)
	if err != nil {
		t.Fatal(err)
	}
	master, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	masters, err := domain.NewMasterKeys([]domain.MasterKey{domain.NewMasterKey("test-master", *master, true)})
	if err != nil {
		t.Fatal(err)
	}
	crypters, err := cache.NewMeteredLRU[service.CrypterCacheKey, op.Crypto](cache.NameCrypter, 8)
	if err != nil {
		t.Fatal(err)
	}
	signing, err := cache.NewMeteredLRU[service.SigningKeyCacheKey, domain.SigningKey](cache.NameSigningKey, 8)
	if err != nil {
		t.Fatal(err)
	}
	keys := service.NewKeyService(pool, *masters, crypters, signing)
	mc, err := keys.GetMasterKeyCrypter(ctx)
	if err != nil {
		t.Fatal(err)
	}
	ks, err := project.GenerateNewKeySet(mc, func(prefix domain.ResourcePrefix) (string, error) {
		return native.Statements().NewManagedID(string(prefix))
	})
	if err != nil {
		t.Fatal(err)
	}
	ks.Activate(nil)
	for _, key := range []*domain.EncryptionKey{ks.KeyEncryptionKey, ks.TokenEncryptionKey, ks.SecretEncryptionKey, ks.CookieEncryptionKey} {
		if err = keys.SaveEncryptionKey(ctx, native.Statements(), key); err != nil {
			t.Fatal(err)
		}
	}
	now := time.Unix(1800000000, 0)
	var mu sync.Mutex
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
	profiles, err := ComposeIsolatedProfiles(Config{ProjectID: project.ID, Origin: "https://issuer.example", Store: store, Pool: pool, Keys: keys, Tokens: service.NewTokenService(keys, pool), Schemas: schemas})
	if err != nil {
		t.Fatal(err)
	}
	if err = profiles.InitializeSchema(ctx); err != nil {
		t.Fatal(err)
	}
	if err = profiles.InitializeSchema(ctx); err != nil {
		t.Fatal(err)
	}
	apps := service.NewApplicationService(pool, schemas, secrets.NewRandomSecretGenerator())
	create := func(slug string) (string, string) {
		t.Helper()
		doc := `{"slug":"` + slug + `","name":"RP","clients":[{"slug":"web","type":"confidential","grant_types":["authorization_code","refresh_token"],"redirect_uris":["https://rp.example/callback"]}]}`
		app, e := apps.CreateOrRevise(ctx, project.ID, []byte(doc))
		if e != nil {
			t.Fatal(e)
		}
		return app.Secrets[0].ClientID, app.Secrets[0].Secret
	}
	bearerID, bearerSecret := create("bearer-rp")
	fapiID, fapiSecret := create("fapi-rp")
	if _, err = profiles.Bearer.Provider.Registry.Lookup(ctx, project.ID, bearerID); !errors.Is(err, ErrInvalidClient) {
		t.Fatalf("unassigned client admitted: %v", err)
	}
	rollbackID, _ := create("rollback-rp")
	assignment := profiles.Clients
	assignment.Audit = func(context.Context, string, string) error { return errors.New("synthetic audit failure") }
	if err = assignment.Assign(ctx, rollbackID, "fapi"); err == nil {
		t.Fatal("failed audit accepted")
	}
	if _, err = profiles.Private.Assertions.Registry.Lookup(ctx, project.ID, rollbackID); !errors.Is(err, ErrInvalidClient) {
		t.Fatalf("assignment survived rollback: %v", err)
	}
	if err = profiles.Clients.Assign(ctx, bearerID, "bearer"); err != nil {
		t.Fatal(err)
	}
	if err = profiles.Clients.Assign(ctx, fapiID, "fapi"); err != nil {
		t.Fatal(err)
	}
	if err = profiles.Clients.Assign(ctx, bearerID, "bearer"); err != nil {
		t.Fatal(err)
	}
	if err = profiles.Clients.Assign(ctx, bearerID, "fapi"); !errors.Is(err, ErrInvalidClient) {
		t.Fatalf("profile reassignment accepted: %v", err)
	}
	if _, err = profiles.Bearer.Provider.Registry.Authenticate(ctx, project.ID, bearerID, bearerSecret, "authorization_code"); err != nil {
		t.Fatal(err)
	}
	if _, err = profiles.Bearer.Provider.Registry.Authenticate(ctx, project.ID, fapiID, fapiSecret, "authorization_code"); !errors.Is(err, ErrInvalidClient) {
		t.Fatalf("FAPI secret accepted by bearer: %v", err)
	}
	if _, err = profiles.Private.Assertions.Registry.Lookup(ctx, project.ID, bearerID); !errors.Is(err, ErrInvalidClient) {
		t.Fatalf("bearer accepted by FAPI: %v", err)
	}
	if _, err = profiles.Private.Assertions.Registry.Lookup(ctx, project.ID, fapiID); err != nil {
		t.Fatal(err)
	}
	if err = profiles.Bearer.Login.Bridge.CheckClient(ctx, project.ID, fapiID, "https://rp.example/callback", "openid"); !errors.Is(err, ErrInvalidClient) {
		t.Fatalf("cross-profile login: %v", err)
	}
	pub, secret, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	jwk := jose.JSONWebKey{Key: pub, KeyID: "test-key", Algorithm: "EdDSA", Use: "sig"}
	if err = profiles.Private.Assertions.SetKeys(ctx, bearerID, []jose.JSONWebKey{jwk}); !errors.Is(err, ErrInvalidClient) {
		t.Fatalf("FAPI registered bearer keys: %v", err)
	}
	if err = profiles.Private.Assertions.SetKeys(ctx, fapiID, []jose.JSONWebKey{jwk}); err != nil {
		t.Fatal(err)
	}
	signer, err := jose.NewSigner(jose.SigningKey{Algorithm: jose.EdDSA, Key: &jose.JSONWebKey{Key: secret, KeyID: "test-key"}}, nil)
	if err != nil {
		t.Fatal(err)
	}
	makeAssertion := func(issuer, id string) string {
		t.Helper()
		raw, err := jwt.Signed(signer).Claims(map[string]any{"iss": fapiID, "sub": fapiID, "aud": issuer, "jti": id, "exp": now.Add(time.Minute).Unix()}).Serialize()
		if err != nil {
			t.Fatal(err)
		}
		return raw
	}
	authenticate := func(assertion string) error {
		return store.Transaction(func() error {
			_, err := profiles.Private.Assertions.AuthenticateInTransaction(ctx, fapiID, privateKeyAssertionType, assertion)
			return err
		})
	}
	if err = authenticate(makeAssertion(profiles.Bearer.Issuer, "wrong-issuer")); !errors.Is(err, ErrInvalidClient) {
		t.Fatalf("bearer issuer assertion accepted by FAPI: %v", err)
	}
	if err = authenticate(makeAssertion(profiles.Private.Assertions.Issuer, "correct-issuer")); err != nil {
		t.Fatal(err)
	}
	if _, err = profiles.Bearer.Admin.EnsureSigningKey(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err = profiles.FAPI.Keys.Rotate(ctx, false); err != nil {
		t.Fatal(err)
	}
	bkeys, err := profiles.Bearer.Tokens.Keys.PublicKeys(ctx)
	if err != nil {
		t.Fatal(err)
	}
	fkeys, err := profiles.FAPI.Keys.PublicKeys(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(bkeys.Keys) != 1 || len(fkeys.Keys) != 1 || bkeys.Keys[0].Algorithm != "RS256" || fkeys.Keys[0].Algorithm != "ES256" || bkeys.Keys[0].KeyID == fkeys.Keys[0].KeyID {
		t.Fatalf("key rings not distinct: %#v %#v", bkeys, fkeys)
	}
	checkDiscovery := func(issuer string, fapi bool) {
		t.Helper()
		req := httptest.NewRequest("GET", issuer+"/.well-known/openid-configuration", nil)
		w := httptest.NewRecorder()
		if fapi {
			profiles.FAPIDiscovery(w, req)
		} else {
			profiles.Bearer.Discovery(w, req)
		}
		var doc map[string]any
		if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &doc) != nil || doc["issuer"] != issuer || doc["token_endpoint"] != issuer+"/token" || doc["jwks_uri"] != issuer+"/jwks" {
			t.Fatalf("invalid discovery: %d %s", w.Code, w.Body.String())
		}
		methods := doc["token_endpoint_auth_methods_supported"].([]any)
		if fapi && (len(methods) != 1 || methods[0] != "private_key_jwt") {
			t.Fatal(methods)
		}
		if !fapi && strings.Contains(w.Body.String(), "private_key_jwt") {
			t.Fatal("bearer advertises FAPI")
		}
	}
	checkDiscovery(profiles.Bearer.Issuer, false)
	checkDiscovery(profiles.Private.Assertions.Issuer, true)
	if profiles.Bearer.Issuer == profiles.Private.Assertions.Issuer {
		t.Fatal("issuer collision")
	}
	if _, err = profiles.Private.Policies.Put(ctx, bearerID, bearerID, nil, true, 0); !errors.Is(err, ErrInvalidClient) {
		t.Fatalf("bearer policy admitted to FAPI: %v", err)
	}
	policy, err := profiles.Private.Policies.Put(ctx, fapiID, fapiID, nil, true, 0)
	if err != nil {
		t.Fatal(err)
	}
	// Both token issuers use a real migrated Nextgen session with a verified
	// credential; signing uses separate project-key-encrypted key rings.
	stamp := now.Add(-time.Second).UnixNano()
	for _, query := range []struct {
		sql  string
		args []any
	}{
		{`INSERT INTO users(project_id,id,schema_url,status,created_at,updated_at) VALUES(?,?,?,'active',?,?)`, []any{project.ID, "user", "synthetic", stamp, stamp}},
		{`INSERT INTO sessions(project_id,id,created_at,updated_at,time_to_live,user_id) VALUES(?,?,?,?,?,?)`, []any{project.ID, "session", stamp, stamp, int64(time.Hour), "user"}},
		{`INSERT INTO checks(project_id,id,session_id,type,last_verified_at) VALUES(?,?,?,?,?)`, []any{project.ID, "check", "session", int(domain.AuthCheckTypePassword), stamp}},
	} {
		if _, err = db.ExecContext(ctx, query.sql, query.args...); err != nil {
			t.Fatal(err)
		}
	}
	var bearerAccess, fapiAccess string
	err = store.Transaction(func() error {
		b, err := profiles.Bearer.Tokens.MintCodeTokens(ctx, AuthorizationCode{ProjectID: project.ID, ClientID: bearerID, UserID: "user", SessionID: "session", Scope: "openid", Nonce: "nonce"})
		if err != nil {
			return err
		}
		bearerAccess = b.AccessToken
		raw, err := profiles.FAPI.Tokens.Mint(ctx, FAPIExchangeGrant{ProjectID: project.ID, ClientID: fapiID, UserID: "user", SessionID: "session", Scope: "openid", Nonce: "nonce", DPoPJKT: strings.Repeat("A", 43), PolicyVersion: policy.Version})
		if err != nil {
			return err
		}
		var f fapiAccessResponse
		if err = json.Unmarshal(raw, &f); err != nil {
			return err
		}
		fapiAccess = f.AccessToken
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if err = profiles.Bearer.Tokens.ValidateAccess(ctx, bearerAccess, bearerID); err != nil {
		t.Fatalf("own bearer access rejected: %v", err)
	}
	if err = profiles.Bearer.Tokens.ValidateAccess(ctx, fapiAccess, fapiID); !errors.Is(err, ErrInvalidAccess) {
		t.Fatalf("FAPI access accepted by bearer: %v", err)
	}
	if _, err = profiles.FAPI.Tokens.signedAccess(ctx, bearerAccess, bearerID); !errors.Is(err, ErrInvalidAccess) {
		t.Fatalf("bearer access accepted by FAPI: %v", err)
	}
	if _, err = profiles.FAPI.Tokens.signedAccess(ctx, fapiAccess, fapiID); err != nil {
		t.Fatalf("own FAPI access rejected: %v", err)
	}
	if _, err = profiles.FAPI.Tokens.signedAccess(ctx, fapiAccess, bearerID); !errors.Is(err, ErrInvalidAccess) {
		t.Fatalf("wrong FAPI audience accepted: %v", err)
	}
	jkt := strings.Repeat("A", 43)
	var bearerRefresh, fapiRefresh string
	err = store.Transaction(func() error {
		var e error
		bearerRefresh, e = store.IssueRefresh(ctx, RefreshGrant{ProjectID: project.ID, ClientID: bearerID, UserID: "user", SessionID: "session", Scope: "openid offline_access", ExpiresAt: now.Add(time.Hour)})
		if e != nil {
			return e
		}
		fapiRefresh, e = profiles.Private.Grants.IssueRefreshInTransaction(ctx, FAPIRefresh{RefreshGrant: RefreshGrant{ProjectID: project.ID, ClientID: fapiID, UserID: "user", SessionID: "session", Scope: "openid offline_access", ExpiresAt: now.Add(time.Hour)}, DPoPJKT: jkt, PolicyVersion: policy.Version})
		return e
	})
	if err != nil {
		t.Fatal(err)
	}
	noop := func(context.Context, RefreshGrant) error { return nil }
	if _, err = store.RotateRefresh(ctx, fapiRefresh, project.ID, fapiID, noop, noop); !errors.Is(err, ErrInvalidRefresh) {
		t.Fatalf("FAPI refresh in bearer store: %v", err)
	}
	err = store.Transaction(func() error {
		_, e := profiles.Private.Grants.RefreshInTransaction(ctx, bearerRefresh, bearerID, jkt)
		return e
	})
	if !errors.Is(err, ErrInvalidRefresh) {
		t.Fatalf("bearer refresh in FAPI store: %v", err)
	}
	replacement, err := store.RotateRefresh(ctx, bearerRefresh, project.ID, bearerID, noop, noop)
	if err != nil || replacement == bearerRefresh {
		t.Fatalf("bearer rotation: %v", err)
	}
	if _, err = store.RotateRefresh(ctx, bearerRefresh, project.ID, bearerID, noop, noop); !errors.Is(err, ErrRefreshReuse) {
		t.Fatalf("bearer replay accepted: %v", err)
	}
	if _, err = store.RotateRefresh(ctx, replacement, project.ID, bearerID, noop, noop); !errors.Is(err, ErrInvalidRefresh) {
		t.Fatalf("bearer family survived reuse: %v", err)
	}
	for i := 0; i < 2; i++ {
		err = store.Transaction(func() error {
			_, e := profiles.Private.Grants.RefreshInTransaction(ctx, fapiRefresh, fapiID, jkt)
			return e
		})
		if err != nil {
			t.Fatalf("FAPI nonrotating refresh %d: %v", i, err)
		}
	}
}
