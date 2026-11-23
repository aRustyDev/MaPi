//go:build wasip1 && sqlite_integration

package stmttest

import (
	"database/sql"
	"errors"
	"testing"

	"github.com/stretchr/testify/require"
	"github.com/zitadel/nextgen/internal/cloudflarewasm"
)

// This checks the existing eager bridge contract, including a value that
// cannot be reconstructed by rerunning the SELECT after rollback.
func TestMaPiRowsRemainReadableAfterRollback(t *testing.T) {
	db := cloudflarewasm.Open()
	defer db.Close()
	_, err := db.ExecContext(t.Context(), "CREATE TABLE escaped_rows_probe (value TEXT)")
	require.NoError(t, err)
	var rows *sql.Rows
	sentinel := errors.New("rollback escaped rows")
	err = cloudflarewasm.Transaction(func() error {
		if _, err := db.ExecContext(t.Context(), "INSERT INTO escaped_rows_probe VALUES ('uncommitted')"); err != nil {
			return err
		}
		var queryErr error
		rows, queryErr = db.QueryContext(t.Context(), "SELECT value FROM escaped_rows_probe")
		if queryErr != nil {
			return queryErr
		}
		return sentinel
	})
	require.ErrorIs(t, err, sentinel)
	require.True(t, rows.Next(), "rows must retain their pre-rollback snapshot: %v", rows.Err())
	var value string
	require.NoError(t, rows.Scan(&value))
	require.Equal(t, "uncommitted", value)
	require.NoError(t, rows.Close())
	var count int
	require.NoError(t, db.QueryRowContext(t.Context(), "SELECT count(*) FROM escaped_rows_probe").Scan(&count))
	require.Zero(t, count)
}
