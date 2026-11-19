package api

import (
	"context"
	generated "github.com/zitadel/nextgen/internal/api/generated"
	"net/http"

	"github.com/zitadel/nextgen/internal/cloudflarewasm"
)

// Ping executes SQL against the owning Durable Object, rather than merely
// checking that database/sql can obtain a Go-side connection.
type cloudflarePinger struct{}

func (cloudflarePinger) Ping(ctx context.Context) error {
	db := cloudflarewasm.Open()
	defer db.Close()
	var value int
	return db.QueryRowContext(ctx, "SELECT 1").Scan(&value)
}

func (r cloudflareRoutes) GetLive(ctx context.Context) (generated.GetLiveRes, error) {
	return r.handler.GetLive(ctx)
}

func (r cloudflareRoutes) GetReady(ctx context.Context) (generated.GetReadyRes, error) {
	return r.handler.GetReady(ctx)
}

// The upstream handler implements conditional requests, gzip, CORS, and the
// exact pinned OpenAPI document independently of the authenticated API chain.
func mountCloudflareOpenAPI(mux *http.ServeMux) {
	mux.Handle("/api/v1/openapi.json", openAPIDocumentHandler())
}
