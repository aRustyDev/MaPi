package mapioauth

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"database/sql"
	"encoding/base64"
	"errors"
	"strings"
	"time"
)

// Browser reload state holds only hashes. The browser retains the login handle
// in a separate HttpOnly cookie and the original login-binding secret in its
// existing cookie. PAR expires independently; session binding remains until
// the pending login itself expires.
func createFAPIReloadSchema(ctx context.Context, s Store) error {
	if s.DB == nil {
		return errors.New("FAPI reload database not configured")
	}
	if _, err := s.DB.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS mapi_fapi_reload (par_hash BLOB PRIMARY KEY,project_id TEXT NOT NULL,client_id TEXT NOT NULL,login_hash BLOB NOT NULL,browser_hash BLOB NOT NULL,session_hash BLOB,par_expires INTEGER NOT NULL,login_expires INTEGER NOT NULL,UNIQUE(project_id,login_hash))`); err != nil {
		return err
	}
	_, err := s.DB.ExecContext(ctx, `CREATE INDEX IF NOT EXISTS mapi_fapi_reload_expiry ON mapi_fapi_reload(project_id,login_expires)`)
	return err
}
func parReloadCookieName(requestURI string) string {
	h := sha256.Sum256([]byte(requestURI))
	return "__Host-mapi-par-" + base64.RawURLEncoding.EncodeToString(h[:16])
}
func reloadSessionDigest(value string) []byte { h := sha256.Sum256([]byte(value)); return h[:] }

// recordFAPIReload runs inside PAR consumption after the login row is written.
func recordFAPIReload(ctx context.Context, f FAPILogin, requestURI, handle, binding, session string, req PushedAuthorizationRequest) error {
	if !strings.HasPrefix(requestURI, parPrefix) || !validLoginSecret(strings.TrimPrefix(requestURI, parPrefix)) || !validLoginSecret(handle) || !validLoginSecret(binding) || req.ExpiresAt.IsZero() {
		return ErrInvalidPAR
	}
	parHash := sha256.Sum256([]byte(requestURI))
	loginHash := sha256.Sum256([]byte(handle))
	browserHash := sha256.Sum256([]byte(binding))
	var loginExpiry int64
	if err := f.Store.DB.QueryRowContext(ctx, `SELECT expires_at FROM mapi_fapi_logins WHERE handle_hash=? AND project_id=? AND client_id=?`, loginHash[:], req.ProjectID, req.ClientID).Scan(&loginExpiry); err != nil {
		return err
	}
	var sessionHash any
	if session != "" {
		identity, err := f.Session(ctx, req.ProjectID, session)
		if err != nil || identity.ProjectID != req.ProjectID || identity.UserID == "" || identity.SessionID == "" {
			return ErrInvalidLogin
		}
		sessionHash = reloadSessionDigest(session)
	}
	if _, err := f.Store.DB.ExecContext(ctx, `DELETE FROM mapi_fapi_reload WHERE rowid IN (SELECT rowid FROM mapi_fapi_reload WHERE project_id=? AND login_expires<=? ORDER BY login_expires LIMIT 100)`, req.ProjectID, f.Store.Now().UnixMilli()); err != nil {
		return err
	}
	_, err := f.Store.DB.ExecContext(ctx, `INSERT INTO mapi_fapi_reload(par_hash,project_id,client_id,login_hash,browser_hash,session_hash,par_expires,login_expires) VALUES(?,?,?,?,?,?,?,?)`, parHash[:], req.ProjectID, req.ClientID, loginHash[:], browserHash[:], sessionHash, req.ExpiresAt.UnixMilli(), loginExpiry)
	return err
}

// resumeFAPIReload admits only the same browser while the original pending
// login and PAR are live, and rechecks client, scope and policy generation.
func resumeFAPIReload(ctx context.Context, f FAPILogin, requestURI, client, handle, binding, session string) error {
	if !f.configured() || !strings.HasPrefix(requestURI, parPrefix) || !validLoginSecret(strings.TrimPrefix(requestURI, parPrefix)) || !validLoginSecret(handle) || !validLoginSecret(binding) || client == "" {
		return ErrInvalidPAR
	}
	parHash := sha256.Sum256([]byte(requestURI))
	loginHash := sha256.Sum256([]byte(handle))
	browserHash := sha256.Sum256([]byte(binding))
	return f.Store.Transaction(func() error {
		var savedLogin, savedBrowser, savedSession []byte
		var project, storedClient string
		var parExpiry, loginExpiry int64
		err := f.Store.DB.QueryRowContext(ctx, `SELECT project_id,client_id,login_hash,browser_hash,session_hash,par_expires,login_expires FROM mapi_fapi_reload WHERE par_hash=?`, parHash[:]).Scan(&project, &storedClient, &savedLogin, &savedBrowser, &savedSession, &parExpiry, &loginExpiry)
		if errors.Is(err, sql.ErrNoRows) {
			return ErrInvalidPAR
		}
		if err != nil {
			return err
		}
		if project != f.ProjectID || storedClient != client || subtle.ConstantTimeCompare(savedLogin, loginHash[:]) != 1 || subtle.ConstantTimeCompare(savedBrowser, browserHash[:]) != 1 || !f.Store.Now().Before(time.UnixMilli(parExpiry)) || !f.Store.Now().Before(time.UnixMilli(loginExpiry)) {
			return ErrInvalidPAR
		}
		var req PushedAuthorizationRequest
		var saved []byte
		var expiry int64
		err = f.Store.DB.QueryRowContext(ctx, `SELECT browser_hash,project_id,client_id,redirect_uri,scope,expires_at FROM mapi_fapi_logins WHERE handle_hash=?`, loginHash[:]).Scan(&saved, &req.ProjectID, &req.ClientID, &req.RedirectURI, &req.Scope, &expiry)
		if errors.Is(err, sql.ErrNoRows) {
			return ErrInvalidPAR
		}
		if err != nil {
			return err
		}
		if req.ProjectID != project || req.ClientID != client || subtle.ConstantTimeCompare(saved, browserHash[:]) != 1 || !f.Store.Now().Before(time.UnixMilli(expiry)) {
			return ErrInvalidPAR
		}
		if err = f.CheckClient(ctx, project, client, req.RedirectURI, req.Scope); err != nil {
			return err
		}
		if _, err = getFAPIPrompt(ctx, f.Store, "login", loginHash[:]); err != nil {
			return ErrInvalidPAR
		}
		savedVersion, err := getFAPIPolicyBinding(ctx, f.Store, "login", loginHash[:], project, client)
		if errors.Is(err, ErrFAPIPolicyDenied) {
			return ErrInvalidPAR
		}
		if err != nil {
			return err
		}
		current, err := f.PolicyVersion(ctx, project, client, req.Scope)
		if err != nil {
			return err
		}
		if current != savedVersion {
			return ErrInvalidPAR
		}
		if len(savedSession) > 0 && session == "" {
			return ErrInvalidPAR
		}
		if session != "" {
			identity, err := f.Session(ctx, project, session)
			if err != nil || identity.ProjectID != project || identity.UserID == "" || identity.SessionID == "" {
				return ErrInvalidPAR
			}
			if err = bindFAPIReloadSession(ctx, f.Store, project, loginHash[:], session); err != nil {
				return err
			}
		}
		return nil
	})
}

// bindFAPIReloadSession is called after authoritative session verification,
// in the same transaction as login preview/completion. Direct non-HTTP test
// fixtures may lack a reload row; the HTTP adapter always creates one.
func bindFAPIReloadSession(ctx context.Context, s Store, project string, loginHash []byte, session string) error {
	var saved []byte
	err := s.DB.QueryRowContext(ctx, `SELECT session_hash FROM mapi_fapi_reload WHERE project_id=? AND login_hash=?`, project, loginHash).Scan(&saved)
	if errors.Is(err, sql.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	digest := reloadSessionDigest(session)
	if len(saved) > 0 {
		if subtle.ConstantTimeCompare(saved, digest) != 1 {
			return ErrInvalidLogin
		}
		return nil
	}
	_, err = s.DB.ExecContext(ctx, `UPDATE mapi_fapi_reload SET session_hash=? WHERE project_id=? AND login_hash=? AND session_hash IS NULL`, digest, project, loginHash)
	return err
}
