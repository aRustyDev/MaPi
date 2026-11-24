//go:build sqlite_integration

package sqlite

import (
	"bytes"
	"testing"

	"github.com/zitadel/nextgen/internal/domain"
	"github.com/zitadel/nextgen/internal/storage/events"
)

// This compares a diagnostic projection with the real SQLite list statement;
// it does not exercise authorization, a spool, or the Cloudflare SQL bridge.
func TestAuditSnapshotMetadataSQLiteParity(t *testing.T) {
	ctx := t.Context()
	project := "diag-snapshot-" + t.Name()
	defer testPool.sqlDB.ExecContext(ctx, "DELETE FROM events WHERE project_id=?", project)
	for _, e := range []struct {
		id      string
		created int64
	}{{"evt-a", 3}, {"evt-b", 3}, {"evt-c", 5}, {"evt-d", 8}, {"evt-e", 10}} {
		_, err := testPool.sqlDB.ExecContext(ctx, `INSERT INTO events (project_id,id,event_type,category,occurred_at,created_at) VALUES (?,?,?,?,?,?)`, project, e.id, string(domain.EventTypeUserCreated), string(domain.EventCategoryEntity), e.created, e.created)
		if err != nil {
			t.Fatal(err)
		}
	}
	statement := newEventStatements(db{sqlDB: testPool.sqlDB})
	for _, order := range []struct {
		name string
		desc bool
	}{{"ascending", false}, {"descending", true}} {
		t.Run(order.name, func(t *testing.T) {
			opts := events.ListOptions(project, 2)
			if order.desc {
				opts.Pagination.OrderBy = events.CreatedAtDesc()
			}
			seen := 0
			for {
				full, err := statement.ListEvents(ctx, opts)
				if err != nil {
					t.Fatal(err)
				}
				meta, err := statement.listEventSnapshotMetadata(ctx, opts)
				if err != nil {
					t.Fatal(err)
				}
				if len(full.Items) != len(meta.Items) || !bytes.Equal(full.NextCursor, meta.NextCursor) {
					t.Fatalf("page mismatch: full=%d metadata=%d cursors %q / %q", len(full.Items), len(meta.Items), full.NextCursor, meta.NextCursor)
				}
				for i, item := range full.Items {
					if item.ID != meta.Items[i].ID || !item.CreatedAt.Equal(meta.Items[i].CreatedAt) {
						t.Fatalf("row mismatch at %d", i)
					}
					seen++
				}
				if len(meta.NextCursor) == 0 {
					break
				}
				opts.Pagination.Cursor = meta.NextCursor
			}
			if seen != 5 {
				t.Fatalf("got %d rows, want 5", seen)
			}
		})
	}
}
