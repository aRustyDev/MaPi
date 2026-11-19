//go:build wasip1 && mapi_management

package api

import (
	"context"
	"net/http"

	generated "github.com/zitadel/nextgen/internal/api/generated"
	"github.com/zitadel/nextgen/internal/domain"
	"github.com/zitadel/nextgen/internal/service"
	defaults "github.com/zitadel/nextgen/packages/config/defaults"
)

// These routes only read users. Their user service dependencies for user writes
// are deliberately not wired; adding mutation routes requires full services.
func configureMaPiManagement(h *Handler, server *generated.Server, mux *http.ServeMux) {
	bases := domain.BuiltinSchemaBasesFor(defaults.DefaultBuiltinSchemaBase)
	h.userService = service.NewUserService(h.pool, nil, nil, nil, service.StatementsUserRefResolver{Pool: h.pool}, bases)
	h.builtinBases = bases
	server.MountMaPiManagement(mux, "")
	server.MountMaPiManagement(mux, "/api/v1")
}
func (r cloudflareRoutes) QueryUsers(ctx context.Context, req *generated.QueryUsersRequest, p generated.QueryUsersParams) (generated.QueryUsersRes, error) {
	return r.handler.QueryUsers(ctx, req, p)
}
func (r cloudflareRoutes) GetUser(ctx context.Context, p generated.GetUserParams) (generated.GetUserRes, error) {
	return r.handler.GetUser(ctx, p)
}
