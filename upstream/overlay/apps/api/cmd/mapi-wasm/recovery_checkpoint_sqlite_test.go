package main

import (
	"database/sql"
	"testing"

	_ "modernc.org/sqlite"
)

// This exercises the checkpoint invariant with real SQLite transactions; it
// does not invoke the WASI batch, workerd, or a recovery control workflow.
func TestPendingRecoveryCursorRollbackAndLostAcknowledgement(t *testing.T) {
	for _, phase := range []string{"sessions", "attempts"} {
		t.Run(phase, func(t *testing.T) {
			db, err := sql.Open("sqlite", ":memory:")
			if err != nil {
				t.Fatal(err)
			}
			defer db.Close()
			if _, err := db.Exec("CREATE TABLE work (id TEXT PRIMARY KEY); CREATE TABLE checkpoint (cursor TEXT); INSERT INTO work VALUES ('one'); INSERT INTO checkpoint VALUES ('one')"); err != nil {
				t.Fatal(err)
			}
			read := func() (int, *string) {
				t.Helper()
				var count int
				var cursor sql.NullString
				if err := db.QueryRow("SELECT count(*) FROM work").Scan(&count); err != nil {
					t.Fatal(err)
				}
				if err := db.QueryRow("SELECT cursor FROM checkpoint").Scan(&cursor); err != nil {
					t.Fatal(err)
				}
				if !cursor.Valid {
					return count, nil
				}
				return count, &cursor.String
			}
			mutate := func(commit bool) {
				t.Helper()
				tx, err := db.Begin()
				if err != nil {
					t.Fatal(err)
				}
				if _, err := tx.Exec("DELETE FROM work WHERE id='one'; UPDATE checkpoint SET cursor=NULL"); err != nil {
					tx.Rollback()
					t.Fatal(err)
				}
				if commit {
					err = tx.Commit()
				} else {
					err = tx.Rollback()
				}
				if err != nil {
					t.Fatal(err)
				}
			}
			mutate(false)
			count, cursor := read()
			if count != 1 || cursor == nil || *cursor != "one" {
				t.Fatal("rollback must retain both work and cursor")
			}
			// Commit, then discard the response to model a lost acknowledgement.
			mutate(true)
			count, cursor = read()
			if count != 0 || cursor != nil || recoveryRequireNoPendingCursor(cursor) != nil {
				t.Fatal("retry must observe both committed deletion and cleared cursor")
			}
			if _, err := db.Exec("UPDATE checkpoint SET cursor='one'"); err != nil {
				t.Fatal(err)
			}
			_, cursor = read()
			if err := recoveryRequireNoPendingCursor(cursor); err == nil {
				t.Fatal("a missing row with a persisted cursor must stop recovery")
			}
		})
	}
}
