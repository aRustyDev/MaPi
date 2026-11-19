package api

import (
	"context"
	"net/http"
	"time"

	generated "github.com/zitadel/nextgen/internal/api/generated"
	"github.com/zitadel/nextgen/internal/api/middleware"
	"github.com/zitadel/nextgen/internal/domain"
	"github.com/zitadel/nextgen/internal/service"
)

func CloudflareHandler(projectID string, pool *service.DB, attempts service.AuthAttemptService, sessions service.SessionService, keys service.KeyService, tokens service.TokenService, releases service.ReleaseService, runtime *service.RuntimeResolver, flows service.FlowService, projects service.ProjectService) (http.Handler, error) {
	h := &Handler{
		pool: pool, authAttemptService: attempts, sessionService: sessions,
		keyService: keys, tokenService: tokens, releaseService: releases, runtime: runtime,
		flowService: flows, projectService: projects,
	}
	h.WithReadinessCheck(cloudflarePinger{})
	routes := cloudflareRoutes{handler: h, projectID: projectID}
	server, err := generated.NewServer(routes, NewSecurityHandler(tokens), generated.WithErrorHandler(OgenErrorHandler(time.Second)))
	if err != nil {
		return nil, err
	}
	mux := http.NewServeMux()
	mountCloudflareOpenAPI(mux)
	server.MountMaPi(mux, "/api/v1")
	server.MountMaPi(mux, "")
	return middleware.Chain(mux, WithRecover, WithRequestHostMiddleware,
		WithLoopbackSessionCookie, middleware.WithUserAgentMiddleware,
		WithSessionStateNoStore, WithCSRFRequest), nil
}

// Embed the upstream stubs and link only the operations mounted in the PoC.
type cloudflareRoutes struct {
	generated.UnimplementedHandler
	handler   *Handler
	projectID string
}

func (r cloudflareRoutes) inProject(ctx context.Context) bool {
	scope, ok := GetScopeContext(ctx)
	return ok && scope.ProjectID == r.projectID
}

func (r cloudflareRoutes) CreateFlow(ctx context.Context, req *generated.CreateFlowRequest, params generated.CreateFlowParams) (generated.CreateFlowRes, error) {
	if r.handler.flowService == nil || string(req.ProjectID) != r.projectID {
		return nil, domain.ErrFlowNotFound()
	}
	return r.handler.CreateFlow(ctx, req, params)
}

func (r cloudflareRoutes) GetFlowStep(ctx context.Context, params generated.GetFlowStepParams) (generated.GetFlowStepRes, error) {
	if r.handler.flowService == nil {
		return nil, domain.ErrFlowNotFound()
	}
	state, err := r.handler.openState(ctx, params.Zflow)
	if err != nil {
		return nil, err
	}
	if state.ProjectID != r.projectID {
		return nil, domain.ErrFlowNotFound()
	}
	return r.handler.GetFlowStep(ctx, params)
}

func (r cloudflareRoutes) SubmitFlowStep(ctx context.Context, req *generated.FlowSubmitRequest, params generated.SubmitFlowStepParams) (generated.SubmitFlowStepRes, error) {
	if r.handler.flowService == nil {
		return nil, domain.ErrFlowNotFound()
	}
	state, err := r.handler.openState(ctx, params.Zflow)
	if err != nil {
		return nil, err
	}
	if state.ProjectID != r.projectID {
		return nil, domain.ErrFlowNotFound()
	}
	return r.handler.SubmitFlowStep(ctx, req, params)
}

func (r cloudflareRoutes) CreateAuthAttempt(ctx context.Context, req *generated.CreateAuthAttemptRequest) (generated.CreateAuthAttemptRes, error) {
	if !r.inProject(ctx) {
		return nil, domain.ErrProjectMismatch()
	}
	return r.handler.CreateAuthAttempt(ctx, req)
}

func (r cloudflareRoutes) CreateAuthAttemptChallenge(ctx context.Context, req *generated.IssueChallengeRequest, params generated.CreateAuthAttemptChallengeParams) (generated.CreateAuthAttemptChallengeRes, error) {
	if !r.inProject(ctx) {
		return nil, domain.ErrProjectMismatch()
	}
	return r.handler.CreateAuthAttemptChallenge(ctx, req, params)
}

func (r cloudflareRoutes) VerifyAuthAttemptChallenge(ctx context.Context, req *generated.VerifyChallengeRequest, params generated.VerifyAuthAttemptChallengeParams) (generated.VerifyAuthAttemptChallengeRes, error) {
	if !r.inProject(ctx) {
		return nil, domain.ErrProjectMismatch()
	}
	return r.handler.VerifyAuthAttemptChallenge(ctx, req, params)
}

func (r cloudflareRoutes) CreateAuthAttemptHandoff(ctx context.Context, params generated.CreateAuthAttemptHandoffParams) (generated.CreateAuthAttemptHandoffRes, error) {
	if !r.inProject(ctx) {
		return nil, domain.ErrProjectMismatch()
	}
	return r.handler.CreateAuthAttemptHandoff(ctx, params)
}

func (r cloudflareRoutes) ExchangeHandoff(ctx context.Context, req *generated.ExchangeRequest, params generated.ExchangeHandoffParams) (generated.ExchangeHandoffRes, error) {
	if !r.inProject(ctx) {
		return nil, domain.ErrProjectMismatch()
	}
	return r.handler.ExchangeHandoff(ctx, req, params)
}

func (r cloudflareRoutes) GetMySession(ctx context.Context, params generated.GetMySessionParams) (generated.GetMySessionRes, error) {
	if !r.inProject(ctx) {
		return nil, domain.ErrAuthUnauthorized(nil)
	}
	return r.handler.GetMySession(ctx, params)
}

func (r cloudflareRoutes) GetMySessionCsrfToken(ctx context.Context, params generated.GetMySessionCsrfTokenParams) (generated.GetMySessionCsrfTokenRes, error) {
	if !r.inProject(ctx) {
		return nil, domain.ErrAuthUnauthorized(nil)
	}
	return r.handler.GetMySessionCsrfToken(ctx, params)
}

func (r cloudflareRoutes) RevokeMySession(ctx context.Context, params generated.RevokeMySessionParams) (generated.RevokeMySessionRes, error) {
	if !r.inProject(ctx) {
		return nil, domain.ErrAuthUnauthorized(nil)
	}
	return r.handler.RevokeMySession(ctx, params)
}

func (r cloudflareRoutes) RevokeSession(ctx context.Context, params generated.RevokeSessionParams) (generated.RevokeSessionRes, error) {
	if !r.inProject(ctx) {
		return nil, domain.ErrProjectMismatch()
	}
	return r.handler.RevokeSession(ctx, params)
}
