//go:build wasip1 && mapi_session_extra

package api

import (
	"context"

	generated "github.com/zitadel/nextgen/internal/api/generated"
	"github.com/zitadel/nextgen/internal/domain"
)

// These handlers retain the existing object's project fence for this test-only
// adapter. Cross-project status differences are documented by the test.
func (r cloudflareRoutes) CreateSession(ctx context.Context, req *generated.CreateSessionRequest) (generated.CreateSessionRes, error) {
	if !r.inProject(ctx) {
		return nil, domain.ErrProjectMismatch()
	}
	return r.handler.CreateSession(ctx, req)
}

func (r cloudflareRoutes) GetSession(ctx context.Context, params generated.GetSessionParams) (generated.GetSessionRes, error) {
	if !r.inProject(ctx) {
		return nil, domain.ErrAuthUnauthorized(nil)
	}
	return r.handler.GetSession(ctx, params)
}

func (r cloudflareRoutes) QuerySessions(ctx context.Context, req *generated.QuerySessionsRequest, params generated.QuerySessionsParams) (generated.QuerySessionsRes, error) {
	if !r.inProject(ctx) {
		return nil, domain.ErrAuthUnauthorized(nil)
	}
	return r.handler.QuerySessions(ctx, req, params)
}
