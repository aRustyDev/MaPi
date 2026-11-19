//go:build wasip1 && mapi_invitations

package api

import (
	"context"
	generated "github.com/zitadel/nextgen/internal/api/generated"
	"github.com/zitadel/nextgen/internal/domain"
	"github.com/zitadel/nextgen/internal/service"
	"net/http"
)

// Test-only platform identity and Console URL; do not deploy this adapter.
func configureMaPiInvitations(h *Handler, s *generated.Server, mux *http.ServeMux) {
	h.invitationService = service.NewInvitationService(h.pool, h.keyService, "https://console.example.test", "proj_platform")
	s.MountMaPiInvitations(mux, "")
	s.MountMaPiInvitations(mux, "/api/v1")
}
func (r cloudflareRoutes) CreateInvitation(ctx context.Context, req generated.CreateInvitationRequest, p generated.CreateInvitationParams) (generated.CreateInvitationRes, error) {
	if !r.inProject(ctx) {
		return nil, domain.ErrAuthUnauthorized(nil)
	}
	return r.handler.CreateInvitation(ctx, req, p)
}
func (r cloudflareRoutes) ListInvitations(ctx context.Context, p generated.ListInvitationsParams) (generated.ListInvitationsRes, error) {
	if !r.inProject(ctx) {
		return nil, domain.ErrAuthUnauthorized(nil)
	}
	return r.handler.ListInvitations(ctx, p)
}
func (r cloudflareRoutes) GetInvitation(ctx context.Context, p generated.GetInvitationParams) (generated.GetInvitationRes, error) {
	if !r.inProject(ctx) {
		return nil, domain.ErrAuthUnauthorized(nil)
	}
	return r.handler.GetInvitation(ctx, p)
}
func (r cloudflareRoutes) CancelInvitation(ctx context.Context, p generated.CancelInvitationParams) (generated.CancelInvitationRes, error) {
	if !r.inProject(ctx) {
		return nil, domain.ErrAuthUnauthorized(nil)
	}
	return r.handler.CancelInvitation(ctx, p)
}
