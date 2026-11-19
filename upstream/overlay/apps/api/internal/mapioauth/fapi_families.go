package mapioauth

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"database/sql"
	"encoding/base64"
	"errors"
	"fmt"
	"time"
)

// ErrFAPICodeReuse is also an invalid grant, but needs a committed family
// revocation before that response is returned to the authenticated client.
var ErrFAPICodeReuse = fmt.Errorf("%w: code reuse", ErrInvalidCode)

func createFAPIFamilySchema(ctx context.Context, s Store) error {
	if _, err := s.DB.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS mapi_fapi_code_family (code_hash BLOB PRIMARY KEY,project_id TEXT NOT NULL,client_id TEXT NOT NULL,redirect_uri TEXT NOT NULL,challenge TEXT NOT NULL,dpop_jkt TEXT NOT NULL,user_id TEXT NOT NULL,session_id TEXT NOT NULL,scope TEXT NOT NULL,expires_at INTEGER NOT NULL,revoked_at INTEGER)`); err != nil {
		return err
	}
	if _, err := s.DB.ExecContext(ctx, `CREATE INDEX IF NOT EXISTS mapi_fapi_family_expiry ON mapi_fapi_code_family(project_id,expires_at)`); err != nil {
		return err
	}
	if _, err := s.DB.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS mapi_fapi_refresh_family (token_hash BLOB PRIMARY KEY,project_id TEXT NOT NULL,client_id TEXT NOT NULL,family_hash BLOB NOT NULL,expires_at INTEGER NOT NULL)`); err != nil {
		return err
	}
	_, err := s.DB.ExecContext(ctx, `CREATE INDEX IF NOT EXISTS mapi_fapi_refresh_family_expiry ON mapi_fapi_refresh_family(project_id,expires_at)`)
	return err
}
func familyID(hash []byte) string { return base64.RawURLEncoding.EncodeToString(hash) }
func familyHash(id string) ([]byte, error) {
	b, err := base64.RawURLEncoding.DecodeString(id)
	if err != nil || len(b) != 32 || familyID(b) != id {
		return nil, ErrInvalidCode
	}
	return b, nil
}
func (g FAPIGrants) saveConsumedFamily(ctx context.Context, hash []byte, c FAPICode) error {
	// Access and refresh lifetimes are capped at 30 days, so tombstones remain
	// until every associated credential has expired. Cleanup is bounded.
	if _, err := g.Store.DB.ExecContext(ctx, `DELETE FROM mapi_fapi_code_family WHERE rowid IN (SELECT rowid FROM mapi_fapi_code_family WHERE project_id=? AND expires_at<=? ORDER BY expires_at LIMIT 100)`, g.ProjectID, g.Store.Now().UnixMilli()); err != nil {
		return err
	}
	_, err := g.Store.DB.ExecContext(ctx, `INSERT INTO mapi_fapi_code_family(code_hash,project_id,client_id,redirect_uri,challenge,dpop_jkt,user_id,session_id,scope,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?)`, hash, c.ProjectID, c.ClientID, c.RedirectURI, c.CodeChallenge, c.DPoPJKT, c.UserID, c.SessionID, c.Scope, g.Store.Now().Add(30*24*time.Hour).UnixMilli())
	return err
}
func (g FAPIGrants) consumedReplay(ctx context.Context, hash []byte, client, redirect, verifier, jkt string) error {
	var project, storedClient, storedRedirect, challenge, bound string
	var expires int64
	err := g.Store.DB.QueryRowContext(ctx, `SELECT project_id,client_id,redirect_uri,challenge,dpop_jkt,expires_at FROM mapi_fapi_code_family WHERE code_hash=?`, hash).Scan(&project, &storedClient, &storedRedirect, &challenge, &bound, &expires)
	if errors.Is(err, sql.ErrNoRows) {
		return ErrInvalidCode
	}
	if err != nil {
		return err
	}
	verifierHash := sha256.Sum256([]byte(verifier))
	computed := base64.RawURLEncoding.EncodeToString(verifierHash[:])
	if project != g.ProjectID || storedClient != client || storedRedirect != redirect || !g.Store.Now().Before(time.UnixMilli(expires)) || subtle.ConstantTimeCompare([]byte(challenge), []byte(computed)) != 1 || (bound != "" && subtle.ConstantTimeCompare([]byte(bound), []byte(jkt)) != 1) {
		return ErrInvalidCode
	}
	return ErrFAPICodeReuse
}

// revokeFamily requires an already-authenticated client and validated replay.
func (g FAPIGrants) revokeFamily(ctx context.Context, plain, client string) (FAPIExchangeGrant, error) {
	hash := sha256.Sum256([]byte(plain))
	var v FAPIExchangeGrant
	var revoked sql.NullInt64
	err := g.Store.DB.QueryRowContext(ctx, `SELECT project_id,client_id,user_id,session_id,scope,revoked_at FROM mapi_fapi_code_family WHERE code_hash=? AND project_id=? AND client_id=?`, hash[:], g.ProjectID, client).Scan(&v.ProjectID, &v.ClientID, &v.UserID, &v.SessionID, &v.Scope, &revoked)
	if err != nil {
		return v, err
	}
	if !revoked.Valid {
		_, err = g.Store.DB.ExecContext(ctx, `UPDATE mapi_fapi_code_family SET revoked_at=? WHERE code_hash=? AND project_id=? AND client_id=? AND revoked_at IS NULL`, g.Store.Now().UnixMilli(), hash[:], g.ProjectID, client)
	}
	return v, err
}
func (g FAPIGrants) familyValid(ctx context.Context, id, client string) error {
	hash, err := familyHash(id)
	if err != nil {
		return ErrInvalidAccess
	}
	var expiry int64
	var revoked sql.NullInt64
	err = g.Store.DB.QueryRowContext(ctx, `SELECT expires_at,revoked_at FROM mapi_fapi_code_family WHERE code_hash=? AND project_id=? AND client_id=?`, hash, g.ProjectID, client).Scan(&expiry, &revoked)
	if errors.Is(err, sql.ErrNoRows) {
		return ErrInvalidAccess
	}
	if err != nil {
		return err
	}
	if revoked.Valid || !g.Store.Now().Before(time.UnixMilli(expiry)) {
		return ErrInvalidAccess
	}
	return nil
}
