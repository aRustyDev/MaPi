//go:build sqlite_integration

package sqlite

import (
	"errors"
	"strings"
	"testing"

	"github.com/zitadel/nextgen/internal/domain"
	"github.com/zitadel/nextgen/internal/storage/events"
)

func TestDiagnosticFragmentValidatorAgainstSQLiteScan(t *testing.T) {
	for _, tc := range []struct {
		name   string
		losing bool
	}{{"lookahead", false}, {"losing-range", true}} {
		t.Run(tc.name, func(t *testing.T) {
			ctx := t.Context()
			project := "fragment-validator-" + tc.name
			defer testPool.sqlDB.ExecContext(ctx, "DELETE FROM events WHERE project_id=?", project)
			for _, v := range []struct {
				id, category string
				when         int64
				occurred     any
			}{{"a", "entity", 1, 1}, {"b", map[bool]string{true: "auth", false: "entity"}[tc.losing], 2, 1e22}} {
				_, err := testPool.sqlDB.ExecContext(ctx, `INSERT INTO events (project_id,id,event_type,category,occurred_at,created_at) VALUES (?,?,?,?,?,?)`, project, v.id, string(domain.EventTypeUserCreated), v.category, v.occurred, v.when)
				if err != nil {
					t.Fatal(err)
				}
			}
			opts := events.ListOptions(project, 1)
			statements := testPool.Statements()
			var original error
			if tc.losing {
				_, original = events.ListEach(ctx, statements.ListEvents, opts, domain.EventFieldCategory, []string{"entity", "auth"})
			} else {
				_, original = statements.ListEvents(ctx, opts)
			}
			if original == nil || !strings.Contains(original.Error(), "occurred_at") {
				t.Fatalf("expected original occurred_at conversion failure: %v", original)
			}
			query := `SELECT rowid FROM events WHERE project_id=? ORDER BY created_at,id`
			rows, err := testPool.sqlDB.QueryContext(ctx, query, project)
			if err != nil {
				t.Fatal(err)
			}
			var ids []int64
			for rows.Next() {
				var row int64
				if err := rows.Scan(&row); err != nil {
					t.Fatal(err)
				}
				ids = append(ids, row)
			}
			if err := rows.Close(); err != nil {
				t.Fatal(err)
			}
			validator := newEventStatements(db{sqlDB: testPool.sqlDB})
			if len(ids) != 2 {
				t.Fatalf("got %d rows", len(ids))
			}
			if err := validator.diagnosticValidateEventRow(ctx, ids[0]); err != nil {
				t.Fatalf("valid first row: %v", err)
			}
			got := validator.diagnosticValidateEventRow(ctx, ids[1])
			var failure *snapshotScanFailure
			if !errors.As(got, &failure) || failure.column != 4 || failure.name != "occurred_at" {
				t.Fatalf("wrong diagnostic first failure: %v", got)
			}
		})
	}
}
