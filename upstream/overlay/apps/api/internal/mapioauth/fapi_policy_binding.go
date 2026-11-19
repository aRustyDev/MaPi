package mapioauth

import (
	"context"
	"database/sql"
	"errors"
	"time"
)

// Binding rows are private to FAPI, keyed by hashes rather than credentials.
// Every mutation occurs in the same outer transaction as the protected state.
func createFAPIPolicyBindings(ctx context.Context, s Store) error {
	if s.DB == nil {
		return errors.New("FAPI policy binding database not configured")
	}
	if _, err := s.DB.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS mapi_fapi_policy_bindings (kind TEXT NOT NULL,token_hash BLOB NOT NULL,project_id TEXT NOT NULL,client_id TEXT NOT NULL,policy_version INTEGER NOT NULL CHECK(policy_version>0),expires_at INTEGER NOT NULL,PRIMARY KEY(kind,token_hash))`); err != nil {
		return err
	}
	_, err := s.DB.ExecContext(ctx, `CREATE INDEX IF NOT EXISTS mapi_fapi_policy_bindings_expiry ON mapi_fapi_policy_bindings(project_id,expires_at)`)
	return err
}
func bindFAPIPolicy(ctx context.Context, s Store, kind string, hash []byte, project, client string, version int64, expiry time.Time) error {
	if s.DB == nil || s.Now == nil || kind == "" || len(hash) != 32 || project == "" || client == "" || version <= 0 || expiry.IsZero() || s.Now().IsZero() || !expiry.After(s.Now()) {
		return errors.New("invalid FAPI policy binding")
	}
	if _, err := s.DB.ExecContext(ctx, `DELETE FROM mapi_fapi_policy_bindings WHERE rowid IN (SELECT rowid FROM mapi_fapi_policy_bindings WHERE project_id=? AND expires_at<=? ORDER BY expires_at LIMIT 100)`, project, s.Now().UnixMilli()); err != nil {
		return err
	}
	_, err := s.DB.ExecContext(ctx, `INSERT INTO mapi_fapi_policy_bindings(kind,token_hash,project_id,client_id,policy_version,expires_at) VALUES(?,?,?,?,?,?)`, kind, hash, project, client, version, expiry.UnixMilli())
	return err
}
func getFAPIPolicyBinding(ctx context.Context, s Store, kind string, hash []byte, project, client string) (int64, error) {
	if s.DB == nil || s.Now == nil || s.Now().IsZero() {
		return 0, errors.New("FAPI policy binding not configured")
	}
	var version, expiry int64
	err := s.DB.QueryRowContext(ctx, `SELECT policy_version,expires_at FROM mapi_fapi_policy_bindings WHERE kind=? AND token_hash=? AND project_id=? AND client_id=?`, kind, hash, project, client).Scan(&version, &expiry)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, ErrFAPIPolicyDenied
	}
	if err != nil {
		return 0, err
	}
	if version <= 0 || !s.Now().Before(time.UnixMilli(expiry)) {
		return 0, ErrFAPIPolicyDenied
	}
	return version, nil
}
func deleteFAPIPolicyBinding(ctx context.Context, s Store, kind string, hash []byte) error {
	_, err := s.DB.ExecContext(ctx, `DELETE FROM mapi_fapi_policy_bindings WHERE kind=? AND token_hash=?`, kind, hash)
	return err
}
