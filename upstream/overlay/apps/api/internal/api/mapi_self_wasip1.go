//go:build wasip1 && mapi_self && !mapi_account && !mapi_management && !mapi_passkey

package api

import (
	"context"
	generated "github.com/zitadel/nextgen/internal/api/generated"
	"github.com/zitadel/nextgen/internal/domain"
	"github.com/zitadel/nextgen/internal/service"
	defaults "github.com/zitadel/nextgen/packages/config/defaults"
	"net/http"
)

// Test-only adapter; Ogen auth and the session-CSRF middleware are unchanged.
func configureMaPiSelf(h *Handler, s *generated.Server, mux *http.ServeMux) {
	bases := domain.BuiltinSchemaBasesFor(defaults.DefaultBuiltinSchemaBase)
	h.userService = service.NewUserService(h.pool, nil, nil, nil, service.StatementsUserRefResolver{Pool: h.pool}, bases)
	h.builtinBases = bases
	s.MountMaPiSelf(mux, "")
	s.MountMaPiSelf(mux, "/api/v1")
}
func (r cloudflareRoutes) GetMyUserSchema(ctx context.Context, p generated.GetMyUserSchemaParams) (generated.GetMyUserSchemaRes, error) {
	if !r.inProject(ctx) {
		return nil, domain.ErrAuthUnauthorized(nil)
	}
	return r.handler.GetMyUserSchema(ctx, p)
}
func (r cloudflareRoutes) ListMyTeams(ctx context.Context, p generated.ListMyTeamsParams) (generated.ListMyTeamsRes, error) {
	if !r.inProject(ctx) {
		return nil, domain.ErrAuthUnauthorized(nil)
	}
	return r.handler.ListMyTeams(ctx, p)
}
func (r cloudflareRoutes) ListMyIdentityLinks(ctx context.Context, p generated.ListMyIdentityLinksParams) (generated.ListMyIdentityLinksRes, error) {
	if !r.inProject(ctx) {
		return nil, domain.ErrAuthUnauthorized(nil)
	}
	return r.handler.ListMyIdentityLinks(ctx, p)
}
func (r cloudflareRoutes) ListUserTeams(ctx context.Context, p generated.ListUserTeamsParams) (generated.ListUserTeamsRes, error) {
	if !r.inProject(ctx) {
		return nil, domain.ErrAuthUnauthorized(nil)
	}
	return r.handler.ListUserTeams(ctx, p)
}
func (r cloudflareRoutes) ListUserIdentityLinks(ctx context.Context, p generated.ListUserIdentityLinksParams) (generated.ListUserIdentityLinksRes, error) {
	if !r.inProject(ctx) {
		return nil, domain.ErrAuthUnauthorized(nil)
	}
	return r.handler.ListUserIdentityLinks(ctx, p)
}
