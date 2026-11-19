//go:build mapi_native_e2e && !wasip1

package mapioauth

import (
	"context"
	"database/sql"
	"errors"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/zitadel/nextgen/internal/domain"
	"github.com/zitadel/nextgen/internal/secrets"
	"github.com/zitadel/nextgen/internal/service"
	"github.com/zitadel/nextgen/internal/storage/dialect/sqlite"
	configdefaults "github.com/zitadel/nextgen/packages/config/defaults"
	"github.com/zitadel/oidc/v3/pkg/op"
	_ "modernc.org/sqlite"
)

// Real pinned SQLite statements share one transaction with the MaPi store.
func TestClientCredentialRotationAndRevocation(t *testing.T) {
	ctx := context.Background()
	db, err := sql.Open("sqlite", filepath.Join(t.TempDir(), "project.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	db.SetMaxOpenConns(1)
	pool := sqlite.NewMaPiNativeTestPool(db)
	t.Cleanup(func() { pool.Close(ctx) })
	if err = pool.Migrate(ctx); err != nil {
		t.Fatal(err)
	}
	project := &domain.Project{ID: "proj_A", Name: "Credential test"}
	if err = pool.Statements().CreateProject(ctx, project); err != nil {
		t.Fatal(err)
	}
	validator, err := domain.NewSchemaValidator(configdefaults.DefaultBuiltinSchemaBase)
	if err != nil {
		t.Fatal(err)
	}
	apps := service.NewApplicationService(service.NewPool(pool), validator, secrets.NewRandomSecretGenerator())
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
	var wrapping [32]byte
	for n := range wrapping {
		wrapping[n] = byte(n)
	}
	keys := SigningKeys{ProjectID: project.ID, Store: store, Keys: testProjectKeys{project: project.ID, crypter: op.NewAES256GCMCrypto(wrapping, "enc_key_test")}, AuditRotation: func(context.Context, string) error { return nil }}
	admin := Admin{ProjectID: project.ID, Store: store, Projects: pool.Statements(), Applications: apps, Registry: ClientRegistry{Statements: pool.Statements()}, SigningKeys: keys, AuditClientCredential: func(ctx context.Context, client, action string) error {
		_, err := db.ExecContext(ctx, "INSERT INTO credential_audit VALUES (?,?)", client, action)
		return err
	}}
	if _, err = db.Exec("CREATE TABLE credential_audit(client_id TEXT, action TEXT)"); err != nil {
		t.Fatal(err)
	}
	if err = admin.InitializeSchema(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err = admin.EnsureSigningKey(ctx); err != nil {
		t.Fatal(err)
	}
	created, err := admin.RegisterApplication(ctx, []byte(`{"slug":"shop","name":"Shop","clients":[{"slug":"web","type":"confidential","grant_types":["authorization_code","refresh_token"],"redirect_uris":["https://shop.example/callback"]}]}`))
	if err != nil {
		t.Fatal(err)
	}
	credential := created.Secrets[0]
	registry := admin.Registry
	authenticate := func(secret string) error {
		_, err := registry.Authenticate(ctx, project.ID, credential.ClientID, secret, "authorization_code")
		return err
	}
	if err = authenticate(credential.Secret); err != nil {
		t.Fatal(err)
	}
	_, template := fixture(t)
	grant := AuthorizationCode{ProjectID: project.ID, ClientID: credential.ClientID, RedirectURI: "https://shop.example/callback", UserID: "user_A", SessionID: "sess_A", Scope: "openid offline_access", Nonce: "nonce", CodeChallenge: template.CodeChallenge, ExpiresAt: now.Add(time.Minute)}
	code, err := store.Issue(ctx, grant)
	if err != nil {
		t.Fatal(err)
	}
	user := grant.UserID
	sessions := &testSessions{session: &domain.Session{ProjectID: project.ID, ID: grant.SessionID, UserID: &user, ExpiresAt: now.Add(time.Hour), Factors: []domain.AuthFactor{domain.SetAuthFactorPassword(now.Add(-time.Minute))}}}
	issuer := TokenIssuer{Issuer: "https://issuer.example/oauth/proj_A", Keys: keys, Sessions: sessions, Store: store, Lifetime: time.Minute, RefreshLifetime: time.Hour, AuditMint: func(context.Context, string, string, string, string) error { return nil }}
	var access, refresh string
	if err = store.Transaction(func() error {
		token, err := issuer.MintCodeTokens(ctx, grant)
		if err == nil {
			access, refresh = token.AccessToken, token.RefreshToken
		}
		return err
	}); err != nil {
		t.Fatal(err)
	}
	fail := errors.New("audit failure")
	broken := admin
	broken.AuditClientCredential = func(context.Context, string, string) error { return fail }
	if _, err = broken.RotateClientSecret(ctx, credential.ClientID); !errors.Is(err, fail) {
		t.Fatalf("rotation did not fail: %v", err)
	}
	if err = authenticate(credential.Secret); err != nil {
		t.Fatalf("old credential lost on rollback: %v", err)
	}
	if err = issuer.ValidateAccess(ctx, access, credential.ClientID); err != nil {
		t.Fatalf("access invalidated on rollback: %v", err)
	}
	rotated, err := admin.RotateClientSecret(ctx, credential.ClientID)
	if err != nil {
		t.Fatal(err)
	}
	if err = authenticate(credential.Secret); !errors.Is(err, ErrInvalidClient) {
		t.Fatal("old credential accepted")
	}
	if err = authenticate(rotated.Secret); err != nil {
		t.Fatalf("new credential rejected: %v", err)
	}
	if err = issuer.ValidateAccess(ctx, access, credential.ClientID); !errors.Is(err, ErrInvalidAccess) {
		t.Fatal("old access still valid")
	}
	if err = store.Consume(ctx, code, project.ID, credential.ClientID, grant.RedirectURI, verifier, func(context.Context, AuthorizationCode) error { return nil }); !errors.Is(err, ErrInvalidCode) {
		t.Fatal("old code still valid")
	}
	if _, err = store.RotateRefresh(ctx, refresh, project.ID, credential.ClientID, func(context.Context, RefreshGrant) error { return nil }, func(context.Context, RefreshGrant) error { return nil }); !errors.Is(err, ErrInvalidRefresh) {
		t.Fatal("old refresh still valid")
	}
	// Repeating a rotation after a lost response restores control and invalidates
	// the first returned secret; revocation then disables the final secret.
	replacement, err := admin.RotateClientSecret(ctx, credential.ClientID)
	if err != nil {
		t.Fatal(err)
	}
	if err = authenticate(rotated.Secret); !errors.Is(err, ErrInvalidClient) {
		t.Fatal("previous rotated credential accepted")
	}
	if err = authenticate(replacement.Secret); err != nil {
		t.Fatal(err)
	}
	if err = admin.RevokeClientSecrets(ctx, credential.ClientID); err != nil {
		t.Fatal(err)
	}
	if err = admin.RevokeClientSecrets(ctx, credential.ClientID); err != nil {
		t.Fatal(err)
	}
	if err = authenticate(replacement.Secret); !errors.Is(err, ErrInvalidClient) {
		t.Fatal("revoked credential accepted")
	}
	var count int
	if err = db.QueryRow("SELECT COUNT(*) FROM credential_audit").Scan(&count); err != nil || count != 3 {
		t.Fatalf("audit count %d: %v", count, err)
	}
}
