//go:build wasip1 && mapi_teams

package api

import (
	"context"
	generated "github.com/zitadel/nextgen/internal/api/generated"
	"github.com/zitadel/nextgen/internal/domain"
	"github.com/zitadel/nextgen/internal/service"
	"net/http"
)

// Isolated test adapter, not an exposed route or a cross-project authority.
func configureMaPiTeams(h *Handler, s *generated.Server, mux *http.ServeMux) {
	h.teamService = service.NewTeamService(h.pool)
	s.MountMaPiTeams(mux, "")
	s.MountMaPiTeams(mux, "/api/v1")
}
func (r cloudflareRoutes) CreateTeam(ctx context.Context, req *generated.CreateTeamRequest, p generated.CreateTeamParams) (generated.CreateTeamRes, error) {
	if !r.inProject(ctx) {
		return nil, domain.ErrAuthUnauthorized(nil)
	}
	return r.handler.CreateTeam(ctx, req, p)
}
func (r cloudflareRoutes) QueryTeams(ctx context.Context, req *generated.QueryTeamsRequest, p generated.QueryTeamsParams) (generated.QueryTeamsRes, error) {
	if !r.inProject(ctx) {
		return nil, domain.ErrAuthUnauthorized(nil)
	}
	return r.handler.QueryTeams(ctx, req, p)
}
func (r cloudflareRoutes) GetTeam(ctx context.Context, p generated.GetTeamParams) (generated.GetTeamRes, error) {
	if !r.inProject(ctx) {
		return nil, domain.ErrAuthUnauthorized(nil)
	}
	return r.handler.GetTeam(ctx, p)
}
func (r cloudflareRoutes) UpdateTeam(ctx context.Context, req *generated.UpdateTeamRequest, p generated.UpdateTeamParams) (generated.UpdateTeamRes, error) {
	if !r.inProject(ctx) {
		return nil, domain.ErrAuthUnauthorized(nil)
	}
	return r.handler.UpdateTeam(ctx, req, p)
}
func (r cloudflareRoutes) DeactivateTeam(ctx context.Context, p generated.DeactivateTeamParams) (generated.DeactivateTeamRes, error) {
	if !r.inProject(ctx) {
		return nil, domain.ErrAuthUnauthorized(nil)
	}
	return r.handler.DeactivateTeam(ctx, p)
}
