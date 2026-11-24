//go:build sqlite_integration

package sqlite

import (
	"strings"
	"testing"

	"github.com/zitadel/nextgen/internal/domain"
	"github.com/zitadel/nextgen/internal/storage/database"
	"github.com/zitadel/nextgen/internal/storage/events"
)

func TestEventRowValidationLookaheadAndRangePrecedence(t *testing.T) {
	for _, tc := range []struct {
		name string
		rows []struct {
			id, category      string
			occurred, created any
		}
		each      bool
		wantValue string
	}{
		{"lookahead row", []struct {
			id, category      string
			occurred, created any
		}{{"a", "entity", 1, 1}, {"b", "entity", 1e22, 2}}, false, "1e+22"},
		{"losing merge range", []struct {
			id, category      string
			occurred, created any
		}{{"a", "entity", 1, 1}, {"b", "auth", 1e22, 2}}, true, "1e+22"},
		{"first ordered invalid row", []struct {
			id, category      string
			occurred, created any
		}{{"a", "entity", 1e22, 1}, {"b", "entity", 2e22, 2}}, false, "1e+22"},
		{"first invalid column", []struct {
			id, category      string
			occurred, created any
		}{{"a", "entity", 1e22, 2e22}}, false, "1e+22"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ctx := t.Context()
			project := "validation-" + tc.name
			defer testPool.sqlDB.ExecContext(ctx, "DELETE FROM events WHERE project_id=?", project)
			for _, e := range tc.rows {
				_, err := testPool.sqlDB.ExecContext(ctx, `INSERT INTO events (project_id,id,event_type,category,occurred_at,created_at) VALUES (?,?,?,?,?,?)`, project, e.id, string(domain.EventTypeUserCreated), e.category, e.occurred, e.created)
				if err != nil {
					t.Fatal(err)
				}
			}
			opts := &database.ListOptions[domain.EventField]{Filter: database.Equal(database.Col(domain.EventFieldProjectID), project), Pagination: database.Page[domain.EventField]{Limit: 1, OrderBy: events.CreatedAtAsc()}}
			statements := testPool.Statements()
			var err error
			if tc.each {
				_, err = events.ListEach(ctx, statements.ListEvents, opts, domain.EventFieldCategory, []string{"entity", "auth"})
			} else {
				_, err = statements.ListEvents(ctx, opts)
			}
			if err == nil {
				t.Fatal("expected conversion failure from full-event scan")
			}
			message := err.Error()
			if !strings.Contains(message, "occurred_at") || !strings.Contains(message, tc.wantValue) {
				t.Fatalf("error does not identify expected first occurred_at conversion: %v", err)
			}
		})
	}
}
