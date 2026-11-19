//go:build wasip1 && mapi_passkey && !mapi_management && !mapi_account

package api

import (
	"context"
	generated "github.com/zitadel/nextgen/internal/api/generated"
	"github.com/zitadel/nextgen/internal/domain"
	"github.com/zitadel/nextgen/internal/service"
	defaults "github.com/zitadel/nextgen/packages/config/defaults"
	"net/http"
)

func configureMaPiPasskey(h *Handler, s *generated.Server, mux *http.ServeMux) {
	bases := domain.BuiltinSchemaBasesFor(defaults.DefaultBuiltinSchemaBase)
	h.userService = service.NewUserService(h.pool, nil, nil, nil, service.StatementsUserRefResolver{Pool: h.pool}, bases)
	h.builtinBases = bases
	s.MountMaPiPasskey(mux, "")
	s.MountMaPiPasskey(mux, "/api/v1")
}
func (r cloudflareRoutes) CreateUserPasskeyRegistration(ctx context.Context, req *generated.BeginUserPasskeyRegistrationRequest, p generated.CreateUserPasskeyRegistrationParams) (generated.CreateUserPasskeyRegistrationRes, error) {
	if !r.inProject(ctx) {
		return nil, domain.ErrAuthUnauthorized(nil)
	}
	return r.handler.CreateUserPasskeyRegistration(ctx, req, p)
}
func (r cloudflareRoutes) CompleteUserPasskeyRegistration(ctx context.Context, req *generated.FinishUserPasskeyRegistrationRequest, p generated.CompleteUserPasskeyRegistrationParams) (generated.CompleteUserPasskeyRegistrationRes, error) {
	if !r.inProject(ctx) {
		return nil, domain.ErrAuthUnauthorized(nil)
	}
	return r.handler.CompleteUserPasskeyRegistration(ctx, req, p)
}
func (r cloudflareRoutes) ListUserPasskeys(ctx context.Context, p generated.ListUserPasskeysParams) (generated.ListUserPasskeysRes, error) {
	if !r.inProject(ctx) {
		return nil, domain.ErrAuthUnauthorized(nil)
	}
	return r.handler.ListUserPasskeys(ctx, p)
}
func (r cloudflareRoutes) ListMyPasskeys(ctx context.Context, p generated.ListMyPasskeysParams) (generated.ListMyPasskeysRes, error) {
	if !r.inProject(ctx) {
		return nil, domain.ErrAuthUnauthorized(nil)
	}
	return r.handler.ListMyPasskeys(ctx, p)
}
