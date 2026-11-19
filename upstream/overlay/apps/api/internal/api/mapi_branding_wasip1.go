//go:build wasip1 && mapi_branding

package api

import (
	"context"
	"net/http"

	generated "github.com/zitadel/nextgen/internal/api/generated"
	"github.com/zitadel/nextgen/internal/domain"
	"github.com/zitadel/nextgen/internal/service"
)

// Test-only adapter. It does not expose management ingress.
func configureMaPiBranding(h *Handler, server *generated.Server, mux *http.ServeMux) {
	h.brandingService = service.NewBrandingService(h.pool)
	server.MountMaPiBranding(mux, "")
	server.MountMaPiBranding(mux, "/api/v1")
}

func (r cloudflareRoutes) PublishBranding(ctx context.Context, req *generated.Branding, p generated.PublishBrandingParams) (generated.PublishBrandingRes, error) {
	if !r.inProject(ctx) {
		return nil, domain.ErrAuthUnauthorized(nil)
	}
	return r.handler.PublishBranding(ctx, req, p)
}
func (r cloudflareRoutes) ListBranding(ctx context.Context, p generated.ListBrandingParams) (generated.ListBrandingRes, error) {
	if !r.inProject(ctx) {
		return nil, domain.ErrAuthUnauthorized(nil)
	}
	return r.handler.ListBranding(ctx, p)
}
func (r cloudflareRoutes) GetBranding(ctx context.Context, p generated.GetBrandingParams) (generated.GetBrandingRes, error) {
	if !r.inProject(ctx) {
		return nil, domain.ErrAuthUnauthorized(nil)
	}
	return r.handler.GetBranding(ctx, p)
}
