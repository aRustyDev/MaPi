//go:build wasip1 && mapi_release_deployment

package api

import (
	"context"
	generated "github.com/zitadel/nextgen/internal/api/generated"
	"github.com/zitadel/nextgen/internal/domain"
	"github.com/zitadel/nextgen/internal/service"
	"net/http"
)

func configureMaPiReleaseDeployment(h *Handler, server *generated.Server, mux *http.ServeMux) {
	h.deploymentService = service.NewDeploymentService(h.pool, service.NewVariableService(h.pool, h.keyService))
	server.MountMaPiReleaseDeployment(mux, "")
	server.MountMaPiReleaseDeployment(mux, "/api/v1")
}

func (r cloudflareRoutes) CreateRelease(ctx context.Context, req *generated.CreateReleaseRequest, p generated.CreateReleaseParams) (generated.CreateReleaseRes, error) {
	if !r.inProject(ctx) {
		return nil, domain.ErrAuthUnauthorized(nil)
	}
	return r.handler.CreateRelease(ctx, req, p)
}

func (r cloudflareRoutes) ListReleases(ctx context.Context, p generated.ListReleasesParams) (generated.ListReleasesRes, error) {
	if !r.inProject(ctx) {
		return nil, domain.ErrAuthUnauthorized(nil)
	}
	return r.handler.ListReleases(ctx, p)
}

func (r cloudflareRoutes) GetRelease(ctx context.Context, p generated.GetReleaseParams) (generated.GetReleaseRes, error) {
	if !r.inProject(ctx) {
		return nil, domain.ErrAuthUnauthorized(nil)
	}
	return r.handler.GetRelease(ctx, p)
}

func (r cloudflareRoutes) RevokeRelease(ctx context.Context, p generated.RevokeReleaseParams) (generated.RevokeReleaseRes, error) {
	if !r.inProject(ctx) {
		return nil, domain.ErrAuthUnauthorized(nil)
	}
	return r.handler.RevokeRelease(ctx, p)
}

func (r cloudflareRoutes) CreateDeployment(ctx context.Context, req *generated.CreateDeploymentRequest, p generated.CreateDeploymentParams) (generated.CreateDeploymentRes, error) {
	if !r.inProject(ctx) {
		return nil, domain.ErrAuthUnauthorized(nil)
	}
	return r.handler.CreateDeployment(ctx, req, p)
}

func (r cloudflareRoutes) ListDeployments(ctx context.Context, p generated.ListDeploymentsParams) (generated.ListDeploymentsRes, error) {
	if !r.inProject(ctx) {
		return nil, domain.ErrAuthUnauthorized(nil)
	}
	return r.handler.ListDeployments(ctx, p)
}

func (r cloudflareRoutes) GetDeployment(ctx context.Context, p generated.GetDeploymentParams) (generated.GetDeploymentRes, error) {
	if !r.inProject(ctx) {
		return nil, domain.ErrAuthUnauthorized(nil)
	}
	return r.handler.GetDeployment(ctx, p)
}

func (r cloudflareRoutes) ListDeploymentVariables(ctx context.Context, p generated.ListDeploymentVariablesParams) (generated.ListDeploymentVariablesRes, error) {
	if !r.inProject(ctx) {
		return nil, domain.ErrAuthUnauthorized(nil)
	}
	return r.handler.ListDeploymentVariables(ctx, p)
}

func (r cloudflareRoutes) RollbackDeployment(ctx context.Context, req generated.OptRollbackDeploymentRequest, p generated.RollbackDeploymentParams) (generated.RollbackDeploymentRes, error) {
	if !r.inProject(ctx) {
		return nil, domain.ErrAuthUnauthorized(nil)
	}
	return r.handler.RollbackDeployment(ctx, req, p)
}
