package mapioauth

import (
	"context"
	"errors"
	"net/url"
	"slices"
	"strings"
	"time"

	"github.com/zitadel/nextgen/internal/audit"
	"github.com/zitadel/nextgen/internal/domain"
	"github.com/zitadel/nextgen/internal/secrets"
	"github.com/zitadel/nextgen/internal/service"
	"github.com/zitadel/oidc/v3/pkg/oidc"
)

// Config binds the experimental issuer to a single authoritative project. The
// caller must ensure Store and every Pool statement use the same storage
// connection/transaction. On Workers this requires the DO transaction bridge.
type Config struct {
	ProjectID string
	Origin    string
	Store     Store
	Pool      *service.DB
	Keys      service.KeyService
	Tokens    service.TokenService
	Schemas   service.BuiltinSchemaProvider
}

// Composition is intentionally not mounted. Provider endpoints and discovery remain private until the full
// advertised profile and security properties pass conformance tests.
type Composition struct {
	Admin    Admin
	Provider *Provider
	Login    LoginHTTP
	Logout   LogoutHTTP
	Tokens   TokenIssuer
	Issuer   string
}

// Compose wires the real Nextgen application, key, session, token and audit
// services to the transaction-scoped issuer primitives. It performs no
// migrations and registers no HTTP routes.
func Compose(c Config) (*Composition, error) {
	origin, err := url.Parse(c.Origin)
	if err != nil || origin.Scheme != "https" || origin.Host == "" || origin.User != nil || origin.Path != "" || origin.RawQuery != "" || origin.Fragment != "" || c.ProjectID == "" || url.PathEscape(c.ProjectID) != c.ProjectID || c.Store.DB == nil || c.Store.Transaction == nil || c.Store.Now == nil || c.Pool == nil || c.Keys == nil || c.Tokens == nil || c.Schemas == nil {
		return nil, errors.New("invalid project issuer configuration")
	}
	stmts := c.Pool.Statements()
	registry := ClientRegistry{Statements: stmts}
	keys := SigningKeys{Store: c.Store, Keys: c.Keys, ProjectID: c.ProjectID}
	keys.AuditRotation = func(ctx context.Context, id string) error {
		return audit.Emit(ctx, stmts, audit.EmitSpec{Type: domain.EventType("mapi.oauth.signing_key.rotated"), Category: domain.EventCategoryAdmin, ProjectID: c.ProjectID, EntityType: "oauth_signing_key", EntityID: id})
	}
	sessions := service.NewSessionService(c.Pool, service.StatementsUserRefResolver{Pool: c.Pool}, service.SessionConfig{DefaultTTL: domain.SessionDefaultTTL, MaxTTL: 720 * time.Hour})
	issuer := c.Origin + "/oauth/" + c.ProjectID
	tokenIssuer := TokenIssuer{Issuer: issuer, Keys: keys, Sessions: stmts, Store: c.Store, Lifetime: 5 * time.Minute, RefreshLifetime: 24 * time.Hour}
	tokenIssuer.AuditMint = func(ctx context.Context, project, user, session, id string) error {
		return audit.Emit(ctx, stmts, audit.EmitSpec{Type: domain.EventTypeAuthTokenIssued, Category: domain.EventCategoryAuth, ProjectID: project, EntityType: "oauth_access_token", EntityID: id, UserID: user, SessionID: &session, Payload: domain.AuthTokenIssuedPayload{}})
	}
	bridge := LoginBridge{Store: c.Store, ProjectID: c.ProjectID, LoginTTL: 5 * time.Minute, CodeTTL: time.Minute}
	bridge.CheckClient = func(ctx context.Context, project, clientID, redirect, scope string) error {
		if project != c.ProjectID || (scope != "openid" && scope != "openid offline_access") {
			return ErrInvalidClient
		}
		client, err := registry.Authorize(ctx, project, clientID, redirect)
		if err != nil {
			return err
		}
		if strings.Contains(scope, "offline_access") && !slices.Contains(client.GrantTypes, "refresh_token") {
			return ErrInvalidClient
		}
		return nil
	}
	bridge.Session = NextgenSessionValidator(c.Tokens, sessions, c.Store.Now)
	bridge.Audit = func(ctx context.Context, g AuthorizationCode) error {
		return audit.Emit(ctx, stmts, audit.EmitSpec{Type: domain.EventType("mapi.oauth.code.issued"), Category: domain.EventCategoryAuth, ProjectID: g.ProjectID, EntityType: "oauth_code", UserID: g.UserID, SessionID: &g.SessionID})
	}
	login := LoginHTTP{Bridge: bridge, Origin: c.Origin}
	provider := &Provider{ProjectID: c.ProjectID, LoginOrigin: c.Origin, Registry: registry, Store: c.Store, BeginLogin: login.Begin, PublicKeys: keys.PublicKeys, MintCodeTokens: tokenIssuer.MintCodeTokens, MintRefreshTokens: tokenIssuer.MintRefreshTokens}
	provider.UserInfoToken = func(ctx context.Context, token string) (*oidc.UserInfo, error) {
		identity, err := tokenIssuer.Access(ctx, token, "")
		if err != nil {
			return nil, err
		}
		if _, err := registry.Lookup(ctx, c.ProjectID, identity.ClientID); err != nil {
			return nil, err
		}
		return &oidc.UserInfo{Subject: identity.Subject}, nil
	}
	provider.RevokeToken = func(ctx context.Context, client, secret, token string) error {
		authenticate := func(ctx context.Context) error {
			_, err := registry.Authenticate(ctx, c.ProjectID, client, secret, "authorization_code")
			return err
		}
		if strings.Count(token, ".") == 2 {
			return tokenIssuer.RevokeAccess(ctx, token, client, authenticate, func(ctx context.Context, i AccessIdentity) error {
				return audit.Emit(ctx, stmts, audit.EmitSpec{Type: domain.EventTypeAuthTokenRevoked, Category: domain.EventCategoryAuth, ProjectID: c.ProjectID, EntityType: "oauth_access_token", UserID: i.Subject, SessionID: &i.SessionID, Payload: domain.AuthTokenRevokedPayload{}})
			})
		}
		return c.Store.RevokeRefresh(ctx, token, c.ProjectID, client, authenticate, func(ctx context.Context, g RefreshGrant) error {
			return audit.Emit(ctx, stmts, audit.EmitSpec{Type: domain.EventTypeAuthTokenRevoked, Category: domain.EventCategoryAuth, ProjectID: c.ProjectID, EntityType: "oauth_refresh_family", UserID: g.UserID, SessionID: &g.SessionID, Payload: domain.AuthTokenRevokedPayload{}})
		})
	}
	provider.AuditReuse = func(ctx context.Context, g RefreshGrant) error {
		return audit.Emit(ctx, stmts, audit.EmitSpec{Type: domain.EventType("mapi.oauth.refresh.reuse"), Category: domain.EventCategoryAuth, ProjectID: g.ProjectID, EntityType: "oauth_refresh_family", UserID: g.UserID, SessionID: &g.SessionID})
	}
	applications := service.NewApplicationService(c.Pool, c.Schemas, secrets.NewRandomSecretGenerator())
	admin := Admin{ProjectID: c.ProjectID, Store: c.Store, Projects: stmts, Applications: applications, SigningKeys: keys, Registry: registry}
	admin.AuditClientCredential = func(ctx context.Context, client, action string) error {
		return audit.Emit(ctx, stmts, audit.EmitSpec{Type: domain.EventType("mapi.oauth.client_credential." + action), Category: domain.EventCategoryAdmin, ProjectID: c.ProjectID, EntityType: "oauth_client", EntityID: client})
	}
	admin.AuditLogoutURI = func(ctx context.Context, client, uri string) error {
		return audit.Emit(ctx, stmts, audit.EmitSpec{Type: domain.EventType("mapi.oauth.logout_uri.registered"), Category: domain.EventCategoryAdmin, ProjectID: c.ProjectID, EntityType: "oauth_client", EntityID: client, Payload: map[string]string{"uri": uri}})
	}
	logout := LogoutHTTP{ProjectID: c.ProjectID, Origin: c.Origin, Store: c.Store, Registry: registry, Tokens: tokenIssuer, Session: bridge.Session, DeleteSession: func(ctx context.Context, project, id string) error {
		return sessions.Delete(ctx, service.DeleteSessionInput{ProjectID: project, SessionID: id})
	}}
	return &Composition{Admin: admin, Provider: provider, Login: login, Logout: logout, Tokens: tokenIssuer, Issuer: issuer}, nil
}
