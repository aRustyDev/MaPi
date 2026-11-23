package main

import (
	"context"
	"database/sql"
	"fmt"
	"strings"
	"testing"

	_ "modernc.org/sqlite"
)

const recoverySelect = "SELECT id FROM checks WHERE project_id=? AND session_id=? ORDER BY id LIMIT 1"
const recoveryDelete = "DELETE FROM checks WHERE project_id=? AND id=?"

func recoveryTestDB(t *testing.T) *sql.DB {
	t.Helper()
	db, err := sql.Open("sqlite", ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	if _, err := db.Exec("CREATE TABLE checks (project_id TEXT, id TEXT, session_id TEXT, PRIMARY KEY(project_id,id))"); err != nil {
		t.Fatal(err)
	}
	return db
}

func TestRecoveryDeleteBoundedProgress(t *testing.T) {
	ctx := context.Background()
	db := recoveryTestDB(t)
	for i := 0; i < 66; i++ {
		if _, err := db.Exec("INSERT INTO checks VALUES ('p', ?, 's')", fmt.Sprintf("%03d", i)); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := db.Exec("INSERT INTO checks VALUES ('other', '000', 's'), ('p', 'foreign', 'other')"); err != nil {
		t.Fatal(err)
	}
	for _, expected := range []int{64, 2, 0} {
		tx, err := db.BeginTx(ctx, nil)
		if err != nil {
			t.Fatal(err)
		}
		count, err := recoveryDeleteBounded(ctx, tx, recoverySelect, recoveryDelete, "p", "s")
		if err != nil {
			tx.Rollback()
			t.Fatal(err)
		}
		if count != expected {
			tx.Rollback()
			t.Fatalf("deleted %d, expected %d", count, expected)
		}
		if err := tx.Commit(); err != nil {
			t.Fatal(err)
		}
	}
	var remaining int
	if err := db.QueryRow("SELECT COUNT(*) FROM checks").Scan(&remaining); err != nil || remaining != 2 {
		t.Fatalf("remaining=%d, err=%v", remaining, err)
	}
}

func TestRecoveryDeleteCardinalityRollsBack(t *testing.T) {
	for _, tc := range []struct{ name, deleteSQL, expected string }{
		{"zero", "DELETE FROM checks WHERE project_id=? AND id=? AND 0", "affected 0 rows"},
		{"multiple", "DELETE FROM checks WHERE project_id=? AND ? IS NOT NULL", "affected 2 rows"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ctx := context.Background()
			db := recoveryTestDB(t)
			if _, err := db.Exec("INSERT INTO checks VALUES ('p', 'one', 's'), ('p', 'two', 's')"); err != nil {
				t.Fatal(err)
			}
			tx, err := db.BeginTx(ctx, nil)
			if err != nil {
				t.Fatal(err)
			}
			count, err := recoveryDeleteBounded(ctx, tx, recoverySelect, tc.deleteSQL, "p", "s")
			if err == nil || !strings.Contains(err.Error(), tc.expected) || count != 0 {
				tx.Rollback()
				t.Fatalf("count=%d, err=%v", count, err)
			}
			if err := tx.Rollback(); err != nil {
				t.Fatal(err)
			}
			var remaining int
			if err := db.QueryRow("SELECT COUNT(*) FROM checks").Scan(&remaining); err != nil || remaining != 2 {
				t.Fatalf("after rollback remaining=%d, err=%v", remaining, err)
			}
		})
	}
}

func TestRecoveryDeleteLaterMismatchRollsBackEarlierDelete(t *testing.T) {
	ctx := context.Background()
	db := recoveryTestDB(t)
	if _, err := db.Exec("INSERT INTO checks VALUES ('p', 'one', 's'), ('p', 'two', 's')"); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec("CREATE TRIGGER skip_second BEFORE DELETE ON checks WHEN OLD.id='two' BEGIN SELECT RAISE(IGNORE); END"); err != nil {
		t.Fatal(err)
	}
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	count, err := recoveryDeleteBounded(ctx, tx, recoverySelect, recoveryDelete, "p", "s")
	if err == nil || !strings.Contains(err.Error(), "affected 0 rows") || count != 0 {
		tx.Rollback()
		t.Fatalf("count=%d, err=%v", count, err)
	}
	if err := tx.Rollback(); err != nil {
		t.Fatal(err)
	}
	var remaining int
	if err := db.QueryRow("SELECT COUNT(*) FROM checks").Scan(&remaining); err != nil || remaining != 2 {
		t.Fatalf("after rollback remaining=%d, err=%v", remaining, err)
	}
}
