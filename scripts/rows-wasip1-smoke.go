//go:build wasip1

package main

import (
	"context"
	"database/sql"
	"strings"

	"mapirowstest/internal/cloudflarewasm"
)

func main() {}

func rejected(db *sql.DB, name string) bool {
	r, err := db.QueryContext(context.Background(), name)
	if err != nil { return false }
	defer r.Close()
	if r.Next() { return false }
	return r.Err() != nil && !strings.Contains(r.Err().Error(), "synthetic-secret")
}

//go:wasmexport mapi_rows_smoke
func smoke() int32 {
	db := cloudflarewasm.Open()
	defer db.Close()
	for _, name := range []string{"short", "long", "badblob", "badinteger", "ambiguous", "array"} {
		if !rejected(db, name) { return 1 }
	}
	r, err := db.QueryContext(context.Background(), "normal")
	if err != nil { return 2 }
	defer r.Close()
	if !r.Next() { return 3 }
	var a, b, c, d any
	if err := r.Scan(&a, &b, &c, &d); err != nil { return 4 }
	if a != nil || b != "" || c != int64(9007199254740993) { return 5 }
	blob, ok := d.([]byte)
	if !ok || len(blob) != 1 || blob[0] != 'a' { return 6 }
	if r.Next() || r.Err() != nil { return 7 }
	return 0
}
