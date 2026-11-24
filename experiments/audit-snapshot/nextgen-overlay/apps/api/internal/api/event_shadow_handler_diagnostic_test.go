//go:build mapi_shadow_diagnostic && !wasip1

package api

import (
	"context"
	"database/sql"
	"errors"
	"testing"
	"time"

	generated "github.com/zitadel/nextgen/internal/api/generated"
	"github.com/zitadel/nextgen/internal/domain"
	"github.com/zitadel/nextgen/internal/service"
	"github.com/zitadel/nextgen/internal/storage/database"
	"github.com/zitadel/nextgen/internal/storage/dialect/sqlite"
	"github.com/zitadel/nextgen/internal/storage/events"
)

// This fixture exercises the actual handler, authz gate, EventService and
// SQLite statements against a manually prepared shadow view. Its identity,
// permissions and project claims are test doubles: it does not verify a
// bearer token, the COW lifecycle, Workerd, or bounded response memory.
type shadowHandlerReader interface {
	ListEvents(context.Context, *database.ListOptions[domain.EventField]) (*database.ListResult[*domain.Event], error)
	ScanEvents(context.Context, *database.ListOptions[domain.EventField], database.Filter[domain.EventField]) ([]events.Scanned, error)
	GetEventByID(context.Context, string, string) (*domain.Event, error)
}

type shadowHandlerStatements struct {
	service.AllStatements
	auth    stubAuthzStmts
	reader  shadowHandlerReader
	claimed bool
}

func (*shadowHandlerStatements) IsStatements() {}
func (s *shadowHandlerStatements) ActiveSystemCatalogID(ctx context.Context) (string, error) {
	return s.auth.ActiveSystemCatalogID(ctx)
}
func (s *shadowHandlerStatements) HasAuthzProjectFoothold(ctx context.Context, p, h string, k domain.AuthzPrincipalType, id string) (bool, error) {
	return s.auth.HasAuthzProjectFoothold(ctx, p, h, k, id)
}
func (s *shadowHandlerStatements) CheckAuthz(ctx context.Context, p domain.AuthzCheckParams) (bool, bool, error) {
	return s.auth.CheckAuthz(ctx, p)
}
func (s *shadowHandlerStatements) CheckAuthzProjects(ctx context.Context, p domain.AuthzCheckParams, ids []string) ([]domain.AuthzCheckResult, error) {
	return s.auth.CheckAuthzProjects(ctx, p, ids)
}
func (s *shadowHandlerStatements) CheckPlatformOperator(ctx context.Context, p domain.AuthzPlatformCheckParams) (bool, error) {
	return s.auth.CheckPlatformOperator(ctx, p)
}
func (s *shadowHandlerStatements) ListAuthzObjectIDs(ctx context.Context, p domain.AuthzListObjectsParams) ([]string, error) {
	return s.auth.ListAuthzObjectIDs(ctx, p)
}
func (s *shadowHandlerStatements) GetProjectByID(_ context.Context, id string) (*domain.Project, error) {
	return &domain.Project{ID: id}, nil
}
func (s *shadowHandlerStatements) GetActiveOwningTeamGrant(_ context.Context, _ string) (*domain.AuthzAssignment, error) {
	if !s.claimed {
		return nil, new(database.NoRowFoundError)
	}
	return &domain.AuthzAssignment{}, nil
}
func (s *shadowHandlerStatements) EventsSettledBefore(context.Context, string) (time.Time, error) {
	return time.Time{}, nil
}
func (s *shadowHandlerStatements) ListEvents(ctx context.Context, o *database.ListOptions[domain.EventField]) (*database.ListResult[*domain.Event], error) {
	return s.reader.ListEvents(ctx, o)
}
func (s *shadowHandlerStatements) ScanEvents(ctx context.Context, o *database.ListOptions[domain.EventField], match database.Filter[domain.EventField]) ([]events.Scanned, error) {
	return s.reader.ScanEvents(ctx, o, match)
}
func (s *shadowHandlerStatements) GetEventByID(ctx context.Context, p, id string) (*domain.Event, error) {
	return s.reader.GetEventByID(ctx, p, id)
}

type shadowHandlerPool struct{ statements service.AllStatements }

func (p shadowHandlerPool) Statements() service.AllStatements { return p.statements }
func (shadowHandlerPool) Transaction(context.Context, func(context.Context, service.Statementer[service.AllStatements]) error) error {
	return errors.New("unexpected transaction")
}

func TestDiagnosticShadowHandlerAuthorizationAndClaim(t *testing.T) {
	db, err := sql.Open("sqlite", ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	db.SetMaxOpenConns(1)
	const schema = `CREATE TABLE events (
		project_id TEXT NOT NULL, id TEXT NOT NULL, event_type TEXT NOT NULL, category TEXT NOT NULL,
		occurred_at INTEGER NOT NULL, created_at INTEGER NOT NULL, team_id TEXT, actor_id TEXT, actor_type TEXT,
		entity_type TEXT, entity_id TEXT, user_id TEXT, client_id TEXT NOT NULL DEFAULT '', token_id TEXT NOT NULL DEFAULT '',
		delegation_type TEXT NOT NULL DEFAULT '', delegation_id TEXT NOT NULL DEFAULT '', grantor TEXT NOT NULL DEFAULT '', fingerprint TEXT NOT NULL DEFAULT '',
		request_id TEXT, session_id TEXT, flow_id TEXT, operation_status TEXT, status_class TEXT,
		payload TEXT NOT NULL DEFAULT '{}', metadata TEXT NOT NULL DEFAULT '{}', PRIMARY KEY(project_id,id))`
	for _, statement := range []string{schema,
		`CREATE TABLE mapi_shadow_events AS SELECT * FROM events WHERE 0`,
		`CREATE TABLE mapi_shadow_after(event_rowid INTEGER PRIMARY KEY)`,
		`CREATE VIEW mapi_shadow_snapshot AS SELECT s.* FROM mapi_shadow_events s UNION ALL SELECT e.* FROM events e WHERE NOT EXISTS (SELECT 1 FROM mapi_shadow_after a WHERE a.event_rowid=e.rowid) AND NOT EXISTS (SELECT 1 FROM mapi_shadow_events s WHERE s.project_id=e.project_id AND s.id=e.id)`,
		`INSERT INTO events(project_id,id,event_type,category,occurred_at,created_at,payload) VALUES ('proj_a','evt_a','user.created','entity',1000000000,2000000000,'{"schema_id":"schema_a","attribute_keys":["email"]}'), ('proj_b','evt_b','user.created','entity',1000000000,2000000000,'{"schema_id":"schema_b","attribute_keys":["email"]}')`,
		`INSERT INTO mapi_shadow_events SELECT * FROM events WHERE project_id='proj_a'`,
		`DELETE FROM events WHERE project_id='proj_a'`,
	} {
		if _, err := db.Exec(statement); err != nil {
			t.Fatal(err)
		}
	}
	reader, err := sqlite.DiagnosticShadowReaderFromSQL(db, "proj_a")
	if err != nil {
		t.Fatal(err)
	}
	stmts := &shadowHandlerStatements{auth: stubAuthzStmts{granted: []string{"proj_a"}}, reader: reader, claimed: true}
	pool := service.NewPool(shadowHandlerPool{statements: stmts})
	h := &Handler{pool: pool, eventService: service.NewEventService(pool, "")}
	operator := WithScopeContext(context.Background(), ScopeContext{ProjectID: "proj_a", Scope: []string{"project.write", "project.read"}, PrincipalType: domain.AuthzPrincipalTypeSKProj, PrincipalID: "proj_a"})
	preview := WithScopeContext(context.Background(), ScopeContext{ProjectID: "proj_a", Scope: []string{"project.read"}, PrincipalType: domain.AuthzPrincipalTypeSKProj, PrincipalID: "proj_a"})
	result, err := h.ListEvents(operator, generated.ListEventsParams{ProjectID: "proj_a"})
	if err != nil {
		t.Fatalf("authorized list failed: %v", err)
	}
	page, ok := result.(*generated.ListEventsResponse)
	if !ok || len(page.Events) != 1 {
		t.Fatalf("unexpected authorized page: %#v", result)
	}
	item, ok := page.Events[0].GetUserCreatedEvent()
	if !ok || item.ID != "evt_a" {
		t.Fatal("the original shadow event was not returned")
	}
	got, err := h.GetEvent(operator, generated.GetEventParams{ProjectID: "proj_a", EventID: "evt_a"})
	if err != nil || got == nil {
		t.Fatalf("authorized get failed: %v", err)
	}
	if _, err := h.ListEvents(operator, generated.ListEventsParams{ProjectID: "proj_b"}); err == nil {
		t.Fatal("foreign project list accepted")
	}
	if _, err := h.GetEvent(operator, generated.GetEventParams{ProjectID: "proj_b", EventID: "evt_b"}); err == nil {
		t.Fatal("foreign project get accepted")
	}
	if _, err := h.ListEvents(preview, generated.ListEventsParams{ProjectID: "proj_a"}); err == nil {
		t.Fatal("preview list accepted")
	}
	if _, err := h.ListEvents(context.Background(), generated.ListEventsParams{ProjectID: "proj_a"}); err == nil {
		t.Fatal("missing scope accepted")
	}
	stmts.claimed = false
	result, err = h.ListEvents(operator, generated.ListEventsParams{ProjectID: "proj_a"})
	if err != nil {
		t.Fatalf("unclaimed list failed: %v", err)
	}
	page, ok = result.(*generated.ListEventsResponse)
	if !ok || len(page.Events) != 0 {
		t.Fatal("unclaimed project exposed audit events")
	}
	if _, err := h.GetEvent(operator, generated.GetEventParams{ProjectID: "proj_a", EventID: "evt_a"}); err == nil {
		t.Fatal("unclaimed project exposed an event")
	}
}
