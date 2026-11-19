package mapioauth

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"database/sql"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/zitadel/nextgen/internal/cache"
	"github.com/zitadel/nextgen/internal/domain"
	"github.com/zitadel/nextgen/internal/secrets"
	"github.com/zitadel/nextgen/internal/service"
	"github.com/zitadel/nextgen/internal/storage/dialect/sqlite"
	configdefaults "github.com/zitadel/nextgen/packages/config/defaults"
	"github.com/zitadel/oidc/v3/pkg/op"
	_ "modernc.org/sqlite"
)

func TestAdminFreshInstallUpstreamServicesAndRetries(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "project.sqlite")
	connected, err := (sqlite.Config{Path: path}).Connect(ctx)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { connected.Close(ctx) })
	if err = connected.Migrate(ctx); err != nil {
		t.Fatal(err)
	}
	pool := connected.(*sqlite.Pool)
	project := &domain.Project{ID: "proj_A", Name: "Project"}
	if err = pool.Statements().CreateProject(ctx, project); err != nil {
		t.Fatal(err)
	}
	master, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	masters, err := domain.NewMasterKeys([]domain.MasterKey{domain.NewMasterKey("master-test", *master, true)})
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
	keyService := service.NewKeyService(service.NewPool(pool), *masters, crypters, signing)
	masterCrypter, err := keyService.GetMasterKeyCrypter(ctx)
	if err != nil {
		t.Fatal(err)
	}
	keyset, err := project.GenerateNewKeySet(masterCrypter, func(prefix domain.ResourcePrefix) (string, error) {
		return pool.Statements().NewManagedID(string(prefix))
	})
	if err != nil {
		t.Fatal(err)
	}
	keyset.Activate(nil)
	for _, key := range []*domain.EncryptionKey{keyset.KeyEncryptionKey, keyset.TokenEncryptionKey, keyset.SecretEncryptionKey, keyset.CookieEncryptionKey} {
		if err := keyService.SaveEncryptionKey(ctx, pool.Statements(), key); err != nil {
			t.Fatal(err)
		}
	}
	validator, err := domain.NewSchemaValidator(configdefaults.DefaultBuiltinSchemaBase)
	if err != nil {
		t.Fatal(err)
	}
	applications := service.NewApplicationService(service.NewPool(pool), validator, secrets.NewRandomSecretGenerator())
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	db.SetMaxOpenConns(1)
	t.Cleanup(func() { db.Close() })
	var mu sync.Mutex
	store := Store{DB: db, Now: time.Now, Transaction: func(fn func() error) error {
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
	admin := Admin{ProjectID: project.ID, Store: store, Projects: pool.Statements(), Applications: applications, SigningKeys: SigningKeys{ProjectID: project.ID, Keys: keyService, AuditRotation: func(ctx context.Context, kid string) error {
		_, err := db.ExecContext(ctx, "INSERT INTO admin_test_audit VALUES(?)", kid)
		return err
	}}}
	if _, err = db.Exec("CREATE TABLE admin_test_audit(kid TEXT NOT NULL)"); err != nil {
		t.Fatal(err)
	}
	// Fail late in migration, proving the earlier tables and version marker roll back.
	if _, err = db.Exec("CREATE VIEW mapi_oauth_signing_keys AS SELECT 1 AS project_id"); err != nil {
		t.Fatal(err)
	}
	if err = admin.InitializeSchema(ctx); err == nil {
		t.Fatal("expected schema failure")
	}
	var count int
	if err = db.QueryRow("SELECT COUNT(*) FROM sqlite_master WHERE name='mapi_oauth_schema'").Scan(&count); err != nil || count != 0 {
		t.Fatalf("schema transaction persisted: %d %v", count, err)
	}
	if _, err = db.Exec("DROP VIEW mapi_oauth_signing_keys"); err != nil {
		t.Fatal(err)
	}
	if err = admin.InitializeSchema(ctx); err != nil {
		t.Fatal(err)
	}
	if err = admin.InitializeSchema(ctx); err != nil {
		t.Fatalf("retry: %v", err)
	}
	// Racing first-boot retries must converge on one committed key and audit.
	ids := make(chan string, 3)
	errs := make(chan error, 3)
	var callers sync.WaitGroup
	for range 3 {
		callers.Add(1)
		go func() { defer callers.Done(); id, err := admin.EnsureSigningKey(ctx); ids <- id; errs <- err }()
	}
	callers.Wait()
	close(ids)
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatalf("key initialization: %v", err)
		}
	}
	var first string
	for id := range ids {
		if first == "" {
			first = id
		} else if id != first {
			t.Fatalf("key initialization produced distinct keys")
		}
	}
	again, err := admin.EnsureSigningKey(ctx)
	if err != nil || again != first {
		t.Fatalf("key init not idempotent: %s %v", again, err)
	}
	if err = db.QueryRow("SELECT COUNT(*) FROM admin_test_audit").Scan(&count); err != nil || count != 1 {
		t.Fatalf("unexpected audit count: %d %v", count, err)
	}
	rotated, err := admin.RotateSigningKey(ctx)
	if err != nil || rotated == first {
		t.Fatalf("rotation failed: %s %v", rotated, err)
	}
	document := []byte(`{"slug":"shop","name":"Shop","clients":[{"slug":"web","type":"confidential","grant_types":["authorization_code","refresh_token"],"redirect_uris":["https://shop.example/callback"]}]}`)
	created, err := admin.RegisterApplication(ctx, document)
	if err != nil {
		t.Fatal(err)
	}
	if len(created.Secrets) != 1 {
		t.Fatalf("expected one secret")
	}
	cred := created.Secrets[0]
	if _, err = (ClientRegistry{Statements: pool.Statements()}).Authenticate(ctx, project.ID, cred.ClientID, cred.Secret, "authorization_code"); err != nil {
		t.Fatalf("registered client failed authentication: %v", err)
	}
	if err = db.QueryRow("SELECT COUNT(*) FROM events WHERE project_id = ?", project.ID).Scan(&count); err != nil || count == 0 {
		t.Fatalf("upstream application audit missing: %d %v", count, err)
	}
	// A v1 database upgrades the revocation table and marker atomically.
	if _, err = db.Exec("DROP TABLE mapi_oauth_revoked_access"); err != nil {
		t.Fatal(err)
	}
	if _, err = db.Exec("DROP TABLE mapi_oauth_logout_uris"); err != nil {
		t.Fatal(err)
	}
	if _, err = db.Exec("DROP TABLE mapi_oauth_client_epochs"); err != nil {
		t.Fatal(err)
	}
	if _, err = db.Exec("UPDATE mapi_oauth_schema SET version=1 WHERE singleton=1"); err != nil {
		t.Fatal(err)
	}
	if _, err = db.Exec("CREATE VIEW mapi_oauth_revoked_access AS SELECT 1 AS project_id"); err != nil {
		t.Fatal(err)
	}
	if err = admin.InitializeSchema(ctx); err == nil {
		t.Fatal("expected v1 upgrade failure")
	}
	var version int
	if err = db.QueryRow("SELECT version FROM mapi_oauth_schema").Scan(&version); err != nil || version != 1 {
		t.Fatalf("failed upgrade persisted: %d %v", version, err)
	}
	if _, err = db.Exec("DROP VIEW mapi_oauth_revoked_access"); err != nil {
		t.Fatal(err)
	}
	if err = admin.InitializeSchema(ctx); err != nil {
		t.Fatalf("v1 upgrade: %v", err)
	}
	if err = db.QueryRow("SELECT version FROM mapi_oauth_schema").Scan(&version); err != nil || version != 4 {
		t.Fatalf("schema version: %d %v", version, err)
	}
	if _, err = db.Exec("UPDATE mapi_oauth_schema SET version=999 WHERE singleton=1"); err != nil {
		t.Fatal(err)
	}
	if err = admin.InitializeSchema(ctx); err == nil {
		t.Fatal("unknown future schema accepted")
	}
	if _, err = admin.EnsureSigningKey(ctx); err == nil {
		t.Fatal("key creation with unknown schema accepted")
	}
}
