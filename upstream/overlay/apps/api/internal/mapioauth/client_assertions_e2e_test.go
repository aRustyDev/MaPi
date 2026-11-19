//go:build mapi_native_e2e && !wasip1

package mapioauth

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"database/sql"
	"errors"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/go-jose/go-jose/v4"
	"github.com/go-jose/go-jose/v4/jwt"
	"github.com/zitadel/nextgen/internal/audit"
	"github.com/zitadel/nextgen/internal/domain"
	"github.com/zitadel/nextgen/internal/secrets"
	"github.com/zitadel/nextgen/internal/service"
	"github.com/zitadel/nextgen/internal/storage/dialect/sqlite"
	configdefaults "github.com/zitadel/nextgen/packages/config/defaults"
	_ "modernc.org/sqlite"
)

func TestClientAssertionRealApplicationAndAuditTransaction(t *testing.T) {
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
	project := &domain.Project{ID: "proj_A", Name: "Assertion test"}
	if err = pool.Statements().CreateProject(ctx, project); err != nil {
		t.Fatal(err)
	}
	schemas, err := domain.NewSchemaValidator(configdefaults.DefaultBuiltinSchemaBase)
	if err != nil {
		t.Fatal(err)
	}
	apps := service.NewApplicationService(service.NewPool(pool), schemas, secrets.NewRandomSecretGenerator())
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
	stmts := pool.Statements()
	a := ClientAssertions{ProjectID: project.ID, Issuer: "https://issuer.example/oauth/proj_A", Store: store, Registry: ClientRegistry{Statements: stmts}}
	a.AuditKeys = func(ctx context.Context, client string, kids []string) error {
		return audit.Emit(ctx, stmts, audit.EmitSpec{Type: domain.EventType("mapi.oauth.client_assertion.keys_changed"), Category: domain.EventCategoryAdmin, ProjectID: project.ID, EntityType: "oauth_client", EntityID: client, Payload: map[string]any{"kids": kids}})
	}
	a.AuditAuthentication = func(ctx context.Context, client, kid string) error {
		return audit.Emit(ctx, stmts, audit.EmitSpec{Type: domain.EventType("mapi.oauth.client_assertion.authenticated"), Category: domain.EventCategoryAuth, ProjectID: project.ID, EntityType: "oauth_client", EntityID: client, Payload: map[string]string{"kid": kid}})
	}
	if err = store.Transaction(func() error { return a.CreateSchema(ctx) }); err != nil {
		t.Fatal(err)
	}
	pub, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	if err = a.SetKeys(ctx, client, []jose.JSONWebKey{{Key: pub, KeyID: "key-1", Algorithm: "EdDSA", Use: "sig"}}); err != nil {
		t.Fatal(err)
	}
	signer, err := jose.NewSigner(jose.SigningKey{Algorithm: jose.EdDSA, Key: &jose.JSONWebKey{Key: private, KeyID: "key-1"}}, nil)
	if err != nil {
		t.Fatal(err)
	}
	raw, err := jwt.Signed(signer).Claims(map[string]any{"iss": client, "sub": client, "aud": a.Issuer, "jti": "synthetic-one-time-id", "exp": now.Add(time.Minute).Unix()}).Serialize()
	if err != nil {
		t.Fatal(err)
	}
	form := url.Values{"client_id": {client}, "client_assertion_type": {privateKeyAssertionType}, "client_assertion": {raw}}
	authenticate := a.PARAuthenticator()
	failure := errors.New("downstream PAR mutation failed")
	err = store.Transaction(func() error {
		id, err := authenticate(ctx, httptest.NewRequest("POST", "https://issuer.example/par", nil), form)
		if err != nil {
			return err
		}
		if id != client {
			t.Fatal("wrong client")
		}
		return failure
	})
	if !errors.Is(err, failure) {
		t.Fatal("downstream failure not returned")
	}
	var count int
	if err = db.QueryRow(`SELECT count(*) FROM mapi_oauth_client_assertion_jtis`).Scan(&count); err != nil || count != 0 {
		t.Fatalf("replay marker survived rollback: %d %v", count, err)
	}
	if err = db.QueryRow(`SELECT count(*) FROM events WHERE event_type='mapi.oauth.client_assertion.authenticated'`).Scan(&count); err != nil || count != 0 {
		t.Fatalf("audit survived rollback: %d %v", count, err)
	}
	if err = store.Transaction(func() error {
		_, err := authenticate(ctx, httptest.NewRequest("POST", "https://issuer.example/par", nil), form)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	if err = store.Transaction(func() error {
		_, err := authenticate(ctx, httptest.NewRequest("POST", "https://issuer.example/par", nil), form)
		return err
	}); !errors.Is(err, ErrInvalidClient) {
		t.Fatal("replayed assertion accepted")
	}
	if err = db.QueryRow(`SELECT count(*) FROM events WHERE event_type='mapi.oauth.client_assertion.authenticated'`).Scan(&count); err != nil || count != 1 {
		t.Fatalf("missing audit: %d %v", count, err)
	}
	var leak int
	if err = db.QueryRow(`SELECT count(*) FROM events WHERE payload LIKE ? OR metadata LIKE ?`, "%"+raw+"%", "%"+raw+"%").Scan(&leak); err != nil || leak != 0 {
		t.Fatal("assertion leaked into audit")
	}
}
