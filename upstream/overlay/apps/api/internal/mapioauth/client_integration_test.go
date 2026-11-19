package mapioauth

import (
	"context"
	"errors"
	"testing"

	"github.com/zitadel/nextgen/internal/domain"
	"github.com/zitadel/nextgen/internal/secrets"
	"github.com/zitadel/nextgen/internal/service"
	"github.com/zitadel/nextgen/internal/storage/dialect/sqlite"
	configdefaults "github.com/zitadel/nextgen/packages/config/defaults"
)

func TestRegisteredUpstreamApplicationClient(t *testing.T) {
	ctx := context.Background()
	connected, err := (sqlite.Config{Path: ":memory:"}).Connect(ctx)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { connected.Close(ctx) })
	if err := connected.Migrate(ctx); err != nil {
		t.Fatal(err)
	}
	pool := connected.(*sqlite.Pool)
	if err := pool.Statements().CreateProject(ctx, &domain.Project{ID: "proj_A", Name: "Test"}); err != nil {
		t.Fatal(err)
	}
	validator, err := domain.NewSchemaValidator(configdefaults.DefaultBuiltinSchemaBase)
	if err != nil {
		t.Fatal(err)
	}
	applications := service.NewApplicationService(service.NewPool(pool), validator, secrets.NewRandomSecretGenerator())
	document := []byte(`{"slug":"shop","name":"Shop","clients":[{"slug":"web","type":"confidential","grant_types":["authorization_code","refresh_token"],"redirect_uris":["https://shop.example/callback"]}]}`)
	created, err := RegisterApplication(ctx, applications, "proj_A", document)
	if err != nil {
		t.Fatal(err)
	}
	if len(created.Secrets) != 1 || created.Secrets[0].Secret == "" || created.Secrets[0].ClientID == "" {
		t.Fatal("upstream did not generate a client secret")
	}
	credentials := created.Secrets[0]
	registry := ClientRegistry{Statements: pool.Statements()}
	if _, err := registry.Authorize(ctx, "proj_A", credentials.ClientID, "https://shop.example/callback"); err != nil {
		t.Fatalf("registered redirect rejected: %v", err)
	}
	if _, err := registry.Authenticate(ctx, "proj_A", credentials.ClientID, credentials.Secret, "authorization_code"); err != nil {
		t.Fatalf("registered credential rejected: %v", err)
	}
	if _, err := registry.Authenticate(ctx, "proj_A", credentials.ClientID, credentials.Secret, "refresh_token"); err != nil {
		t.Fatalf("registered refresh grant rejected: %v", err)
	}
	if _, err := registry.Authenticate(ctx, "proj_A", credentials.ClientID, "wrong", "authorization_code"); !errors.Is(err, ErrInvalidClient) {
		t.Fatalf("wrong secret accepted: %v", err)
	}
	if _, err := registry.Authenticate(ctx, "proj_B", credentials.ClientID, credentials.Secret, "authorization_code"); !errors.Is(err, ErrInvalidClient) {
		t.Fatalf("cross-project credential accepted: %v", err)
	}
}
