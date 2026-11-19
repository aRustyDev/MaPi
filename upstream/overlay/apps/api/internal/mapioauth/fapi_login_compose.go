package mapioauth

import (
	"context"
	"errors"
	"time"

	"github.com/zitadel/nextgen/internal/audit"
	"github.com/zitadel/nextgen/internal/domain"
	"github.com/zitadel/nextgen/internal/service"
)

// ComposePrivateFAPILogin binds the unmounted bridge to authoritative upstream
// session validation and transactional audit. The caller must ensure Store and
// Pool use the same transaction owner; no HTTP routes are registered here.
func ComposePrivateFAPILogin(p *PrivatePAR, pool *service.DB, tokens service.TokenService) (FAPILogin, error) {
	if p == nil || pool == nil || tokens == nil || p.Store.DB == nil || p.Store.Transaction == nil || p.Store.Now == nil || p.PAR.ProjectID == "" || p.PAR.ProjectID != p.Grants.ProjectID || p.PAR.CheckClient == nil {
		return FAPILogin{}, errors.New("private FAPI login composition incomplete")
	}
	sessions := service.NewSessionService(pool, service.StatementsUserRefResolver{Pool: pool}, service.SessionConfig{DefaultTTL: domain.SessionDefaultTTL, MaxTTL: 720 * time.Hour})
	stmts := pool.Statements()
	login := FAPILogin{Store: p.Store, ProjectID: p.PAR.ProjectID, LoginTTL: 5 * time.Minute, CodeTTL: time.Minute, Codes: p.Grants, CheckClient: p.PAR.CheckClient, PolicyVersion: p.PAR.PolicyVersion, Session: NextgenSessionValidator(tokens, sessions, p.Store.Now)}
	login.Audit = func(ctx context.Context, operation string, g AuthorizationCode, _ string) error {
		if operation != "login_started" && operation != "code_issued" {
			return errors.New("unknown FAPI login audit event")
		}
		spec := audit.EmitSpec{Type: domain.EventType("mapi.fapi." + operation), Category: domain.EventCategoryAuth, ProjectID: g.ProjectID, EntityType: "oauth_client", EntityID: g.ClientID, UserID: g.UserID}
		if g.SessionID != "" {
			spec.SessionID = &g.SessionID
		}
		return audit.Emit(ctx, stmts, spec)
	}
	return login, nil
}
