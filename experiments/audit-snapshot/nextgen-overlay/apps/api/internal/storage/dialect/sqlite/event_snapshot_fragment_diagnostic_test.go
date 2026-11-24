//go:build sqlite_integration

package sqlite

import (
	"bytes"
	"context"
	"database/sql"
	"strings"
	"testing"

	"github.com/zitadel/nextgen/internal/domain"
	"github.com/zitadel/nextgen/internal/storage/events"
)

type fragmentDiagnosticRecorder struct {
	queryExecutor
	fragments int
}

func (r *fragmentDiagnosticRecorder) QueryRow(ctx context.Context, q string, args ...any) *sql.Row {
	if strings.Contains(q, "substr(CAST(") {
		r.fragments++
	}
	return r.queryExecutor.QueryRow(ctx, q, args...)
}

func TestDiagnosticSQLiteFragmentedValidTimestamp(t *testing.T) {
	ctx := t.Context()
	project := "diagnostic-fragmented-timestamp"
	defer testPool.sqlDB.ExecContext(ctx, "DELETE FROM events WHERE project_id=?", project)
	value := bytes.Repeat([]byte{'0'}, 131073)
	result, err := testPool.sqlDB.ExecContext(ctx, `INSERT INTO events (project_id,id,event_type,category,occurred_at,created_at) VALUES (?,?,?,?,?,?)`, project, "event-a", string(domain.EventTypeUserCreated), string(domain.EventCategoryEntity), value, 1)
	if err != nil {
		t.Fatal(err)
	}
	rowid, err := result.LastInsertId()
	if err != nil {
		t.Fatal(err)
	}
	original, err := testPool.Statements().ListEvents(ctx, events.ListOptions(project, 1))
	if err != nil {
		t.Fatalf("original scan: %v", err)
	}
	if len(original.Items) != 1 || original.Items[0].OccurredAt.UnixNano() != 0 {
		t.Fatal("unexpected original event")
	}
	recorder := &fragmentDiagnosticRecorder{queryExecutor: db{sqlDB: testPool.sqlDB}}
	validator := newEventStatements(recorder)
	if err := validator.diagnosticValidateEventRow(ctx, rowid); err != nil {
		t.Fatalf("diagnostic scan: %v", err)
	}
	if recorder.fragments != 3 {
		t.Fatalf("got %d fragment queries, want 3", recorder.fragments)
	}
}
