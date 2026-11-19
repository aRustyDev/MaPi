package mapioauth

import (
	"context"
	"errors"
	"testing"

	"github.com/zitadel/nextgen/internal/domain"
	"github.com/zitadel/nextgen/internal/service"
	"github.com/zitadel/nextgen/internal/storage/database"
)

type applicationStatementsFixture struct {
	service.ApplicationStatements
	client  *domain.ApplicationClient
	app     *domain.Application
	secrets []*domain.ApplicationClientSecret
}

func (f applicationStatementsFixture) GetApplicationClientByClientID(_ context.Context, projectID, clientID string) (*domain.ApplicationClient, error) {
	if projectID != f.client.ProjectID || clientID != f.client.ClientID {
		return nil, database.NewNoRowFoundError(errors.New("missing client"))
	}
	return f.client, nil
}

func (f applicationStatementsFixture) GetApplication(_ context.Context, _ database.Filter[domain.ApplicationField]) (*domain.Application, error) {
	return f.app, nil
}

func (f applicationStatementsFixture) ListApplicationClientSecrets(_ context.Context, projectID, id string) ([]*domain.ApplicationClientSecret, error) {
	if projectID != f.client.ProjectID || id != f.client.ID {
		return nil, errors.New("wrong client secret lookup")
	}
	return f.secrets, nil
}

func TestClientRegistryAuthorizesAndAuthenticates(t *testing.T) {
	fixture := applicationStatementsFixture{
		client:  &domain.ApplicationClient{ProjectID: "proj_A", ApplicationID: "app_A", ID: "row_A", Slug: "web", ClientID: "client_A"},
		app:     &domain.Application{ID: "app_A", RevisionID: "rev_A", Document: []byte(`{"slug":"shop","name":"Shop","clients":[{"slug":"web","client_id":"client_A","grant_types":["authorization_code","refresh_token"],"redirect_uris":["https://shop.example/callback"]}]}`)},
		secrets: []*domain.ApplicationClientSecret{{SecretHash: domain.HashSecret("secret-old")}, {SecretHash: domain.HashSecret("secret-new")}},
	}
	registry := ClientRegistry{Statements: fixture}
	ctx := context.Background()
	client, err := registry.Authorize(ctx, "proj_A", "client_A", "https://shop.example/callback")
	if err != nil || client.RevisionID != "rev_A" {
		t.Fatalf("authorization failed: %+v %v", client, err)
	}
	for _, uri := range []string{"https://shop.example/callback/", "https://shop.example/callback?other=1", "https://evil.example/callback"} {
		if _, err := registry.Authorize(ctx, "proj_A", "client_A", uri); !errors.Is(err, ErrInvalidClient) {
			t.Fatalf("unregistered redirect %q accepted: %v", uri, err)
		}
	}
	if _, err := registry.Authorize(ctx, "proj_B", "client_A", "https://shop.example/callback"); !errors.Is(err, ErrInvalidClient) {
		t.Fatalf("cross-project client accepted: %v", err)
	}
	for _, secret := range []string{"secret-old", "secret-new"} {
		if _, err := registry.Authenticate(ctx, "proj_A", "client_A", secret, "authorization_code"); err != nil {
			t.Fatalf("registered secret refused: %v", err)
		}
	}
	for _, test := range []struct{ secret, grant string }{{"wrong", "authorization_code"}, {"", "authorization_code"}, {"secret-old", "client_credentials"}} {
		if _, err := registry.Authenticate(ctx, "proj_A", "client_A", test.secret, test.grant); !errors.Is(err, ErrInvalidClient) {
			t.Fatalf("invalid credential or grant accepted: %v", err)
		}
	}
	fixture.app.Document = []byte(`{"slug":"shop","clients":[{"slug":"other","client_id":"client_A","grant_types":["authorization_code"],"redirect_uris":["https://shop.example/callback"]}]}`)
	if _, err := registry.Lookup(ctx, "proj_A", "client_A"); !errors.Is(err, ErrInvalidClient) {
		t.Fatalf("revision without matching client accepted: %v", err)
	}
}
