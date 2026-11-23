//go:build wasip1

// A small independent integration test for the Go driver and the actual
// Worker SQL bridge. No application, upstream statement suite, migration,
// size-limit, cursor or concurrency probe is run here.
package main

import (
	"bytes"
	"context"
	"database/sql"
	"errors"

	"github.com/zitadel/nextgen/internal/cloudflarewasm"
)

func main() {}

//go:wasmexport mapi_rows_real_sqlite
func run() int32 {
	ctx := context.Background()
	db := cloudflarewasm.Open()
	defer db.Close()
	if _, err := db.ExecContext(ctx, `CREATE TABLE row_smoke (id TEXT PRIMARY KEY, n INTEGER, t TEXT, b BLOB, r REAL, optional TEXT)`); err != nil { return 1 }
	if _, err := db.ExecContext(ctx, `INSERT INTO row_smoke VALUES (?, ?, ?, ?, ?, ?)`, "first", int64(9007199254741029), "Español ☁", []byte{0, 1, 127, 128, 255}, 1.25, nil); err != nil { return 2 }
	if _, err := db.ExecContext(ctx, `INSERT INTO row_smoke VALUES (?, ?, ?, ?, ?, ?)`, "second", int64(-723), "", []byte{}, -0.5, "present"); err != nil { return 3 }
	var n int64
	var text string
	var blob []byte
	var real float64
	var optional sql.NullString
	if err := db.QueryRowContext(ctx, `SELECT n, t, b, r, optional FROM row_smoke WHERE id = ?`, "first").Scan(&n, &text, &blob, &real, &optional); err != nil { return 4 }
	if n != 9007199254741029 || text != "Español ☁" || !bytes.Equal(blob, []byte{0, 1, 127, 128, 255}) || real != 1.25 || optional.Valid { return 5 }
	if err := db.QueryRowContext(ctx, `SELECT n, t, b, r, optional FROM row_smoke WHERE id = ?`, "second").Scan(&n, &text, &blob, &real, &optional); err != nil { return 6 }
	if n != -723 || text != "" || blob == nil || len(blob) != 0 || real != -0.5 || !optional.Valid || optional.String != "present" { return 7 }
	_, err := db.ExecContext(ctx, `INSERT INTO row_smoke (id) VALUES (?)`, "first")
	var sqliteError *cloudflarewasm.SQLError
	if !errors.As(err, &sqliteError) || sqliteError.Code() != 2067 { return 8 }
	var count int64
	if err = db.QueryRowContext(ctx, `SELECT count(*) FROM row_smoke`).Scan(&count); err != nil || count != 2 { return 9 }
	return 0
}
