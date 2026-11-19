package mapioauth

import (
	"context"
	"errors"
	"time"

	"github.com/zitadel/nextgen/internal/audit"
	"github.com/zitadel/nextgen/internal/domain"
	"github.com/zitadel/nextgen/internal/service"
)

// PrivateFAPI is deliberately unmounted. Pool statements, the key service and
// Private.Store must share the same authoritative project transaction.
type PrivateFAPI struct {
	Keys       FAPISigningKeys
	Tokens     FAPIAccessIssuer
	Exchange   FAPIExchange
	Revocation FAPIRevoker
}

func ComposePrivateFAPI(p *PrivatePAR, pool *service.DB, keys service.KeyService) (*PrivateFAPI, error) {
	if p == nil || pool == nil || keys == nil || p.Store.DB == nil || p.Grants.ProjectID == "" {
		return nil, errors.New("private FAPI composition incomplete")
	}
	project := p.Grants.ProjectID
	stmts := pool.Statements()
	signing := FAPISigningKeys{Store: p.Store, Keys: keys, ProjectID: project, AuditRotation: func(ctx context.Context, kid string) error {
		return audit.Emit(ctx, stmts, audit.EmitSpec{Type: domain.EventType("mapi.fapi.signing_key.rotated"), Category: domain.EventCategoryAdmin, ProjectID: project, EntityType: "oauth_signing_key", EntityID: kid})
	}}
	tokens := FAPIAccessIssuer{Private: p, Keys: signing, Sessions: stmts, Registry: ClientRegistry{Statements: stmts}, Lifetime: 5 * time.Minute, RefreshLifetime: 24 * time.Hour}
	tokens.AuditMint = func(ctx context.Context, g FAPIExchangeGrant, id string) error {
		return audit.Emit(ctx, stmts, audit.EmitSpec{Type: domain.EventTypeAuthTokenIssued, Category: domain.EventCategoryAuth, ProjectID: project, EntityType: "fapi_access_token", EntityID: id, UserID: g.UserID, SessionID: &g.SessionID, Payload: domain.AuthTokenIssuedPayload{}})
	}
	tokens.AuditIDToken = func(ctx context.Context, g FAPIExchangeGrant, id string) error {
		return audit.Emit(ctx, stmts, audit.EmitSpec{Type: domain.EventTypeAuthTokenIssued, Category: domain.EventCategoryAuth, ProjectID: project, EntityType: "fapi_id_token", EntityID: id, UserID: g.UserID, SessionID: &g.SessionID, Payload: domain.AuthTokenIssuedPayload{}})
	}
	tokens.AuditAccess = func(ctx context.Context, id AccessIdentity) error {
		return audit.Emit(ctx, stmts, audit.EmitSpec{Type: domain.EventType("mapi.fapi.access.validated"), Category: domain.EventCategoryAuth, ProjectID: project, EntityType: "fapi_access_token", UserID: id.Subject, SessionID: &id.SessionID})
	}
	exchange := FAPIExchange{Private: p, CheckSession: func(ctx context.Context, project, user, session string) error {
		_, err := tokens.session(ctx, project, user, session)
		return err
	}, Mint: tokens.Mint, Audit: func(ctx context.Context, g FAPIExchangeGrant) error {
		return audit.Emit(ctx, stmts, audit.EmitSpec{Type: domain.EventType("mapi.fapi.token.exchanged"), Category: domain.EventCategoryAuth, ProjectID: project, EntityType: "oauth_client", EntityID: g.ClientID, UserID: g.UserID, SessionID: &g.SessionID})
	}}
	exchange.AuditReuse = func(ctx context.Context, g FAPIExchangeGrant) error {
		return audit.Emit(ctx, stmts, audit.EmitSpec{Type: domain.EventType("mapi.fapi.code.reused"), Category: domain.EventCategoryAuth, ProjectID: project, EntityType: "oauth_client", EntityID: g.ClientID, UserID: g.UserID, SessionID: &g.SessionID})
	}
	if !tokens.valid() {
		return nil, errors.New("private FAPI issuer invalid")
	}
	revocation := FAPIRevoker{Issuer: tokens, Audit: func(ctx context.Context, id AccessIdentity) error {
		return audit.Emit(ctx, stmts, audit.EmitSpec{Type: domain.EventTypeAuthTokenRevoked, Category: domain.EventCategoryAuth, ProjectID: project, EntityType: "fapi_access_token", UserID: id.Subject, SessionID: &id.SessionID, Payload: domain.AuthTokenRevokedPayload{}})
	}, AuditRefresh: func(ctx context.Context, id AccessIdentity) error {
		return audit.Emit(ctx, stmts, audit.EmitSpec{Type: domain.EventTypeAuthTokenRevoked, Category: domain.EventCategoryAuth, ProjectID: project, EntityType: "fapi_refresh_token", UserID: id.Subject, SessionID: &id.SessionID, Payload: domain.AuthTokenRevokedPayload{}})
	}}
	return &PrivateFAPI{Keys: signing, Tokens: tokens, Exchange: exchange, Revocation: revocation}, nil
}
