//go:build wasip1 && mapi_account && !mapi_management

package api

import (
	"context"
	"net/http"

	generated "github.com/zitadel/nextgen/internal/api/generated"
	"github.com/zitadel/nextgen/internal/crypto"
	"github.com/zitadel/nextgen/internal/domain"
	"github.com/zitadel/nextgen/internal/policy"
	"github.com/zitadel/nextgen/internal/service"
	defaults "github.com/zitadel/nextgen/packages/config/defaults"
)

// configureMaPiAccount is opt-in and does not install public ingress. Project
// hasher and policy dependencies are the same instances used by the reactor.
func configureMaPiAccount(h *Handler, server *generated.Server, mux *http.ServeMux, hashers *crypto.HasherFactory) error {
	if hashers == nil {
		return domain.ErrInternal(nil)
	}
	bases := domain.BuiltinSchemaBasesFor(defaults.DefaultBuiltinSchemaBase)
	engine, err := policy.New()
	if err != nil {
		return err
	}
	policies := service.NewPolicyService(h.pool, engine)
	passwords, err := service.NewPasswordPolicy(engine, policies, hashers.Default(), h.pool)
	if err != nil {
		return err
	}
	schema := domain.WithBuiltinSchemaAliases(h.pool.Statements(), bases)
	h.userService = service.NewUserService(h.pool, schema, service.NewProjectHasherResolver(h.pool, hashers), passwords, service.StatementsUserRefResolver{Pool: h.pool}, bases)
	h.builtinBases = bases
	server.MountMaPiAccount(mux, "")
	server.MountMaPiAccount(mux, "/api/v1")
	return nil
}
func (r cloudflareRoutes) GetUser(ctx context.Context, p generated.GetUserParams) (generated.GetUserRes, error) {
	if !r.inProject(ctx) {
		return nil, domain.ErrAuthUnauthorized(nil)
	}
	return r.handler.GetUser(ctx, p)
}
func (r cloudflareRoutes) UpdateUser(ctx context.Context, req *generated.PatchUserRequest, p generated.UpdateUserParams) (generated.UpdateUserRes, error) {
	if !r.inProject(ctx) {
		return nil, domain.ErrAuthUnauthorized(nil)
	}
	return r.handler.UpdateUser(ctx, req, p)
}
func (r cloudflareRoutes) GetUserPasswordState(ctx context.Context, p generated.GetUserPasswordStateParams) (generated.GetUserPasswordStateRes, error) {
	if !r.inProject(ctx) {
		return nil, domain.ErrAuthUnauthorized(nil)
	}
	return r.handler.GetUserPasswordState(ctx, p)
}
func (r cloudflareRoutes) SetUserPassword(ctx context.Context, req *generated.SetUserPasswordRequest, p generated.SetUserPasswordParams) (generated.SetUserPasswordRes, error) {
	if !r.inProject(ctx) {
		return nil, domain.ErrAuthUnauthorized(nil)
	}
	return r.handler.SetUserPassword(ctx, req, p)
}
func (r cloudflareRoutes) GetMyUser(ctx context.Context, p generated.GetMyUserParams) (generated.GetMyUserRes, error) {
	if !r.inProject(ctx) {
		return nil, domain.ErrAuthUnauthorized(nil)
	}
	return r.handler.GetMyUser(ctx, p)
}
func (r cloudflareRoutes) UpdateMyUser(ctx context.Context, req *generated.PatchMyUserRequest, p generated.UpdateMyUserParams) (generated.UpdateMyUserRes, error) {
	if !r.inProject(ctx) {
		return nil, domain.ErrAuthUnauthorized(nil)
	}
	return r.handler.UpdateMyUser(ctx, req, p)
}
func (r cloudflareRoutes) GetMyPasswordState(ctx context.Context, p generated.GetMyPasswordStateParams) (generated.GetMyPasswordStateRes, error) {
	if !r.inProject(ctx) {
		return nil, domain.ErrAuthUnauthorized(nil)
	}
	return r.handler.GetMyPasswordState(ctx, p)
}
