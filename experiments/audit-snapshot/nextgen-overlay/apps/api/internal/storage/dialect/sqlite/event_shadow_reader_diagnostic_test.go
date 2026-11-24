//go:build sqlite_integration

package sqlite

import (
	"context"
	"reflect"
	"strings"
	"testing"

	"github.com/zitadel/nextgen/internal/domain"
	"github.com/zitadel/nextgen/internal/storage/database"
	"github.com/zitadel/nextgen/internal/storage/events"
)

// This distinct native test uses actual pinned event statements and the SQL
// compiler. It does not test a user, owner authority, bounded transfer,
// asynchronous snapshot lifecycle, Workerd, or any interrupted bridge case.
func TestDiagnosticShadowEventReaderPinnedStatements(t *testing.T) {
	ctx := context.Background()
	sqlDB := testPool.sqlDB
	var ddl string
	if err := sqlDB.QueryRowContext(ctx, "SELECT sql FROM sqlite_schema WHERE type='table' AND name='events'").Scan(&ddl); err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(ddl, "CREATE TABLE events ") {
		t.Fatal("unexpected event schema")
	}
	for _, q := range []string{
		strings.Replace(ddl, "CREATE TABLE events ", "CREATE TABLE mapi_shadow_events ", 1),
		"CREATE TABLE mapi_shadow_after(event_rowid INTEGER PRIMARY KEY)",
		`CREATE VIEW mapi_shadow_snapshot AS SELECT s.* FROM mapi_shadow_events s UNION ALL
		 SELECT e.* FROM events e WHERE NOT EXISTS (SELECT 1 FROM mapi_shadow_after a WHERE a.event_rowid=e.rowid)
		 AND NOT EXISTS (SELECT 1 FROM mapi_shadow_events s WHERE s.rowid=e.rowid)`,
	} {
		if _, err := sqlDB.ExecContext(ctx, q); err != nil {
			t.Fatal(err)
		}
	}
	t.Cleanup(func() {
		_, _ = sqlDB.ExecContext(ctx, "DROP VIEW mapi_shadow_snapshot")
		_, _ = sqlDB.ExecContext(ctx, "DROP TABLE mapi_shadow_after")
		_, _ = sqlDB.ExecContext(ctx, "DROP TABLE mapi_shadow_events")
		_, _ = sqlDB.ExecContext(ctx, "DELETE FROM events WHERE project_id IN ('diag-shadow-a','diag-shadow-b','diag-shadow-error')")
	})
	for _, e := range []struct {
		project, id, category string
		created               int64
	}{
		{"diag-shadow-a", "evt-a", "identity", 3}, {"diag-shadow-a", "evt-b", "identity", 4},
		{"diag-shadow-a", "evt-c", "other", 5}, {"diag-shadow-b", "evt-b", "identity", 4},
	} {
		_, err := sqlDB.ExecContext(ctx, `INSERT INTO events(project_id,id,event_type,category,occurred_at,created_at,payload,metadata) VALUES(?,?,?,?,?,?,?,?)`, e.project, e.id, string(domain.EventTypeUserCreated), e.category, e.created, e.created, `{}`, `{}`)
		if err != nil {
			t.Fatal(err)
		}
	}
	base := newEventStatements(db{sqlDB: sqlDB})
	options := events.ListOptions("diag-shadow-a", 0) // unpaged: not a bridge-cursor test
	options.Pagination.OrderBy = events.CreatedAtAsc()
	before, err := base.ListEvents(ctx, options)
	if err != nil {
		t.Fatal(err)
	}
	match := database.Equal(database.Col(domain.EventFieldCategory), "identity")
	scannedBefore, err := base.ScanEvents(ctx, options, match)
	if err != nil {
		t.Fatal(err)
	}
	getBefore, err := base.GetEventByID(ctx, "diag-shadow-a", "evt-a")
	if err != nil {
		t.Fatal(err)
	}
	// Save two rows before modifying or deleting them, and mark the new row as
	// post-snapshot. This test constructs the view, not the live COW protocol.
	for _, q := range []string{
		`INSERT INTO mapi_shadow_events(rowid,project_id,id,event_type,category,occurred_at,created_at,team_id,actor_id,actor_type,entity_type,entity_id,user_id,client_id,token_id,delegation_type,delegation_id,grantor,fingerprint,request_id,session_id,flow_id,operation_status,status_class,payload,metadata)
		 SELECT rowid,project_id,id,event_type,category,occurred_at,created_at,team_id,actor_id,actor_type,entity_type,entity_id,user_id,client_id,token_id,delegation_type,delegation_id,grantor,fingerprint,request_id,session_id,flow_id,operation_status,status_class,payload,metadata FROM events WHERE project_id='diag-shadow-a' AND id IN ('evt-a','evt-b')`,
		`UPDATE events SET category='changed' WHERE project_id='diag-shadow-a' AND id='evt-a'`,
		`DELETE FROM events WHERE project_id='diag-shadow-a' AND id='evt-b'`,
		`INSERT INTO events(project_id,id,event_type,category,occurred_at,created_at) VALUES('diag-shadow-a','evt-new','user.created','identity',7,7)`,
		`INSERT INTO mapi_shadow_after SELECT rowid FROM events WHERE project_id='diag-shadow-a' AND id='evt-new'`,
	} {
		if _, err := sqlDB.ExecContext(ctx, q); err != nil {
			t.Fatal(err)
		}
	}
	reader, err := newDiagnosticShadowEventReader(db{sqlDB: sqlDB}, "diag-shadow-a")
	if err != nil {
		t.Fatal(err)
	}
	got, err := reader.ListEvents(ctx, options)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(got.Items, before.Items) {
		t.Fatal("shadow list changed snapshot rows")
	}
	scanned, err := reader.ScanEvents(ctx, options, match)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(scanned, scannedBefore) {
		t.Fatal("shadow scan changed results")
	}
	gotOne, err := reader.GetEventByID(ctx, "diag-shadow-a", "evt-a")
	if err != nil || !reflect.DeepEqual(gotOne, getBefore) {
		t.Fatalf("shadow get mismatch: %v", err)
	}
	foreign := events.ListOptions("diag-shadow-b", 0)
	foreignRows, err := reader.ListEvents(ctx, foreign)
	if err != nil || len(foreignRows.Items) != 0 {
		t.Fatalf("foreign list returned data: %v", err)
	}
	foreignScanned, err := reader.ScanEvents(ctx, foreign, nil)
	if err != nil || len(foreignScanned) != 0 {
		t.Fatalf("foreign scan returned data: %v", err)
	}
	if _, err := reader.GetEventByID(ctx, "diag-shadow-b", "evt-b"); err == nil {
		t.Fatal("foreign get succeeded")
	}
	// The pinned scanner's error for a syntactically valid SQLite TEXT value
	// that cannot be converted to an integer must remain visible.
	_, err = sqlDB.ExecContext(ctx, `INSERT INTO events(project_id,id,event_type,category,occurred_at,created_at) VALUES('diag-shadow-error','evt-error','user.created','identity','not-an-integer',9)`)
	if err != nil {
		t.Fatal(err)
	}
	errorOptions := events.ListOptions("diag-shadow-error", 0)
	_, expectedError := base.ListEvents(ctx, errorOptions)
	errorReader, err := newDiagnosticShadowEventReader(db{sqlDB: sqlDB}, "diag-shadow-error")
	if err != nil {
		t.Fatal(err)
	}
	_, actualError := errorReader.ListEvents(ctx, errorOptions)
	if expectedError == nil || actualError == nil || expectedError.Error() != actualError.Error() {
		t.Fatalf("scanner error mismatch: expected %v, got %v", expectedError, actualError)
	}
}
