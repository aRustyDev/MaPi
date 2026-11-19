package mapioauth

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"testing"

	"github.com/zitadel/nextgen/internal/cache"
	"github.com/zitadel/nextgen/internal/domain"
	"github.com/zitadel/nextgen/internal/service"
	"github.com/zitadel/nextgen/internal/storage/dialect/sqlite"
	"github.com/zitadel/oidc/v3/pkg/op"
)

// Exercise the actual Nextgen project key chain, rather than a replacement
// cryptosystem, while the MaPi SQLite table remains independently versioned.
func TestSigningKeysWithUpstreamKeyService(t *testing.T) {
	ctx := context.Background()
	connected, err := (sqlite.Config{Path: ":memory:"}).Connect(ctx)
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
	store, _ := fixture(t)
	ring := SigningKeys{Store: store, Keys: keyService, ProjectID: project.ID, AuditRotation: func(context.Context, string) error { return nil }}
	if err := ring.CreateSchema(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := ring.Rotate(ctx, false); err != nil {
		t.Fatal(err)
	}
	signer, err := ring.signer(ctx, "JWT")
	if err != nil {
		t.Fatalf("unwrapping with upstream service: %v", err)
	}
	if _, err = signer.Sign([]byte("message")); err != nil {
		t.Fatal(err)
	}
	ring.ProjectID = "proj_B"
	if _, err := ring.signer(ctx, "JWT"); err == nil {
		t.Fatal("cross-project key access accepted")
	}
}
