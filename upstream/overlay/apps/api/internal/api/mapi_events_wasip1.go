//go:build wasip1 && mapi_events

package api

import (
	"context"
	"net/http"

	generated "github.com/zitadel/nextgen/internal/api/generated"
	"github.com/zitadel/nextgen/internal/service"
)

// An empty platform project preserves pre-claim invisibility; no platform
// operator shortcut is introduced by this project-local prototype.
func configureMaPiEvents(h *Handler, server *generated.Server, mux *http.ServeMux) {
	h.eventService = service.NewEventService(h.pool, "")
	server.MountMaPiEvents(mux, "")
	server.MountMaPiEvents(mux, "/api/v1")
}
func (r cloudflareRoutes) ListEvents(ctx context.Context, p generated.ListEventsParams) (generated.ListEventsRes, error) {
	return r.handler.ListEvents(ctx, p)
}
func (r cloudflareRoutes) GetEvent(ctx context.Context, p generated.GetEventParams) (generated.GetEventRes, error) {
	return r.handler.GetEvent(ctx, p)
}
