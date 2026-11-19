//go:build wasip1 && mapi_release_variables

package api

import (
	"context"
	generated "github.com/zitadel/nextgen/internal/api/generated"
	"github.com/zitadel/nextgen/internal/domain"
	"github.com/zitadel/nextgen/internal/service"
	"net/http"
)

func configureMaPiReleaseVariables(h *Handler, server *generated.Server, mux *http.ServeMux) {
	h.variableService = service.NewVariableService(h.pool, h.keyService)
	server.MountMaPiReleaseVariables(mux, "")
	server.MountMaPiReleaseVariables(mux, "/api/v1")
}

func (r cloudflareRoutes) ListVariables(ctx context.Context, p generated.ListVariablesParams) (generated.ListVariablesRes, error) {
	if !r.inProject(ctx) {
		return nil, domain.ErrAuthUnauthorized(nil)
	}
	return r.handler.ListVariables(ctx, p)
}

func (r cloudflareRoutes) SetVariables(ctx context.Context, req generated.UpdateVariablesRequest, p generated.SetVariablesParams) (generated.SetVariablesRes, error) {
	if !r.inProject(ctx) {
		return nil, domain.ErrAuthUnauthorized(nil)
	}
	return r.handler.SetVariables(ctx, req, p)
}

func (r cloudflareRoutes) GetVariable(ctx context.Context, p generated.GetVariableParams) (generated.GetVariableRes, error) {
	if !r.inProject(ctx) {
		return nil, domain.ErrAuthUnauthorized(nil)
	}
	return r.handler.GetVariable(ctx, p)
}

func (r cloudflareRoutes) DeleteVariable(ctx context.Context, p generated.DeleteVariableParams) (generated.DeleteVariableRes, error) {
	if !r.inProject(ctx) {
		return nil, domain.ErrAuthUnauthorized(nil)
	}
	return r.handler.DeleteVariable(ctx, p)
}
