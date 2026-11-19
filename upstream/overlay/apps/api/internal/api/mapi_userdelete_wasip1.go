//go:build wasip1 && mapi_userdelete && !mapi_account && !mapi_management

package api

import (
	"context"
	generated "github.com/zitadel/nextgen/internal/api/generated"
	"github.com/zitadel/nextgen/internal/domain"
	"github.com/zitadel/nextgen/internal/service"
	defaults "github.com/zitadel/nextgen/packages/config/defaults"
	"net/http"
)

// Test-only: cross-project ownership and grant state must be authoritative
// before user deletion can be exposed on one-object-per-project storage.
func configureMaPiUserDelete(h *Handler, s *generated.Server, mux *http.ServeMux) {
	bases := domain.BuiltinSchemaBasesFor(defaults.DefaultBuiltinSchemaBase)
	h.userService = service.NewUserService(h.pool, nil, nil, nil, service.StatementsUserRefResolver{Pool: h.pool}, bases)
	h.builtinBases = bases
	s.MountMaPiUserDelete(mux, "")
	s.MountMaPiUserDelete(mux, "/api/v1")
}
func (r cloudflareRoutes) DeleteUser(ctx context.Context, p generated.DeleteUserParams) (generated.DeleteUserRes, error) {
	if !r.inProject(ctx) {
		return nil, domain.ErrAuthUnauthorized(nil)
	}
	return r.handler.DeleteUser(ctx, p)
}
func (r cloudflareRoutes) GetUser(ctx context.Context, p generated.GetUserParams) (generated.GetUserRes, error) {
	if !r.inProject(ctx) {
		return nil, domain.ErrAuthUnauthorized(nil)
	}
	return r.handler.GetUser(ctx, p)
}
