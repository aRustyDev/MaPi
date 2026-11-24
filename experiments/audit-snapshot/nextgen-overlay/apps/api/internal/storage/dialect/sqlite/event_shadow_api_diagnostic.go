//go:build mapi_shadow_diagnostic && !wasip1

// This constructor is used only by the unmounted native API diagnostic.
package sqlite

import "database/sql"

// DiagnosticShadowReaderFromSQL does not authenticate callers or establish
// a trustworthy snapshot. The supplied project and view are trusted inputs.
func DiagnosticShadowReaderFromSQL(sqlDB *sql.DB, projectID string) (*diagnosticShadowEventReader, error) {
	return newDiagnosticShadowEventReader(db{sqlDB: sqlDB}, projectID)
}
