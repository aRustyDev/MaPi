//go:build mapi_native_e2e && !wasip1

package sqlite

import "database/sql"

// NewMaPiNativeTestPool lets an opt-in test run upstream statements and the
// experimental OAuth store on the same single-connection SQLite database.
// It is excluded from ordinary native and Worker builds.
func NewMaPiNativeTestPool(db *sql.DB) *Pool { return newPool(db) }
