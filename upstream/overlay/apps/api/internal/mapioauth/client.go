package mapioauth

import (
	"context"
	"crypto/subtle"
	"errors"
	"slices"

	"github.com/zitadel/nextgen/internal/domain"
	"github.com/zitadel/nextgen/internal/service"
	"github.com/zitadel/nextgen/internal/storage/database"
)

var ErrInvalidClient = errors.New("invalid OAuth client")

// Client is the registered client and its current application revision.
// Registration and revisions remain owned by Nextgen's ApplicationService.
type Client struct {
	ProjectID     string
	ClientID      string
	ApplicationID string
	RevisionID    string
	RedirectURIs  []string
	GrantTypes    []string
	rowID         string
}

// RegisterApplication delegates validation, credential generation, storage and
// transactional audit to Nextgen. Its returned secrets are displayed once.
func RegisterApplication(ctx context.Context, applications service.ApplicationService, projectID string, document []byte) (*service.CreateApplicationOutput, error) {
	if applications == nil || projectID == "" {
		return nil, errors.New("application service is not configured")
	}
	return applications.CreateOrRevise(ctx, projectID, document)
}

// ClientRegistry reads the pinned Nextgen application and credential tables.
// Callers should provide transaction-scoped statements for token exchanges so
// credential and application changes cannot race a code or refresh commit.
type ClientRegistry struct {
	Statements service.ApplicationStatements
	// Admit is an optional authoritative profile-membership check.
	Admit func(context.Context, string, string) error
}

// Lookup resolves a registered client's current application revision.
func (r ClientRegistry) Lookup(ctx context.Context, projectID, clientID string) (Client, error) {
	if r.Statements == nil {
		return Client{}, errors.New("application statements are not configured")
	}
	if projectID == "" || clientID == "" {
		return Client{}, ErrInvalidClient
	}
	if r.Admit != nil {
		if err := r.Admit(ctx, projectID, clientID); err != nil {
			return Client{}, err
		}
	}
	stored, err := r.Statements.GetApplicationClientByClientID(ctx, projectID, clientID)
	if err != nil {
		var notFound *database.NoRowFoundError
		if errors.As(err, &notFound) {
			return Client{}, ErrInvalidClient
		}
		return Client{}, err
	}
	application, err := r.Statements.GetApplication(ctx, database.And(
		database.Equal(database.Col(domain.ApplicationFieldProjectID), projectID),
		database.Equal(database.Col(domain.ApplicationFieldID), stored.ApplicationID),
	))
	if err != nil {
		var notFound *database.NoRowFoundError
		if errors.As(err, &notFound) {
			return Client{}, ErrInvalidClient
		}
		return Client{}, err
	}
	doc, err := domain.ParseApplicationDocument(application.Document)
	if err != nil {
		return Client{}, err
	}
	for _, definition := range doc.Clients {
		if definition.Slug == stored.Slug && definition.ClientID != nil && *definition.ClientID == clientID {
			return Client{ProjectID: projectID, ClientID: clientID, ApplicationID: application.ID, RevisionID: application.RevisionID, rowID: stored.ID,
				RedirectURIs: slices.Clone(definition.RedirectURIs), GrantTypes: slices.Clone(definition.GrantTypes)}, nil
		}
	}
	return Client{}, ErrInvalidClient
}

// Authorize requires an exact registered redirect URI and code grant.
func (r ClientRegistry) Authorize(ctx context.Context, projectID, clientID, redirectURI string) (Client, error) {
	client, err := r.Lookup(ctx, projectID, clientID)
	if err != nil {
		return Client{}, err
	}
	if !slices.Contains(client.RedirectURIs, redirectURI) || !slices.Contains(client.GrantTypes, "authorization_code") {
		return Client{}, ErrInvalidClient
	}
	return client, nil
}

// Authenticate checks the caller's credential against the upstream secret
// hashes. It compares all registered hashes to allow safe secret rotation.
func (r ClientRegistry) Authenticate(ctx context.Context, projectID, clientID, secret, grantType string) (Client, error) {
	if grantType != "authorization_code" && grantType != "refresh_token" {
		return Client{}, ErrInvalidClient
	}
	client, err := r.Lookup(ctx, projectID, clientID)
	if err != nil {
		return Client{}, err
	}
	secrets, err := r.Statements.ListApplicationClientSecrets(ctx, projectID, client.rowID)
	if err != nil {
		return Client{}, err
	}
	actual := domain.HashSecret(secret)
	valid := 0
	for _, candidate := range secrets {
		valid |= subtle.ConstantTimeCompare([]byte(actual), []byte(candidate.SecretHash))
	}
	if secret == "" || valid != 1 || !slices.Contains(client.GrantTypes, grantType) {
		return Client{}, ErrInvalidClient
	}
	return client, nil
}
