package mapioauth

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"database/sql"
	"errors"
	"net/http"
	"time"

	"github.com/zitadel/nextgen/internal/mapidpop"
)

// FAPIRevoker is private and unmounted. Client authentication, optional DPoP
// proof, token state and audit use one authoritative project transaction.
type FAPIRevoker struct {
	Issuer       FAPIAccessIssuer
	Audit        func(context.Context, AccessIdentity) error
	AuditRefresh func(context.Context, AccessIdentity) error
}
type FAPIRevokeRequest struct{ ClientID, AssertionType, Assertion, Proof, Token string }

func createFAPIRevocationSchema(ctx context.Context, store Store) error {
	if store.DB == nil {
		return errors.New("FAPI revocation database not configured")
	}
	if _, err := store.DB.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS mapi_fapi_revoked_access (project_id TEXT NOT NULL,token_hash BLOB NOT NULL,expires_at INTEGER NOT NULL,PRIMARY KEY(project_id,token_hash))`); err != nil {
		return err
	}
	_, err := store.DB.ExecContext(ctx, `CREATE INDEX IF NOT EXISTS mapi_fapi_revoked_access_expiry ON mapi_fapi_revoked_access(project_id,expires_at)`)
	return err
}

// RevokeAccess implements RFC 7009 nondisclosure for unknown, expired, foreign
// and already-revoked tokens. private_key_jwt authenticates the client. An
// optional DPoP proof is checked for nonce, replay and key binding, but the
// token being revoked is not an access token presented to a resource server,
// so `ath` is not required. Token use remains independently sender-bound.
func (r FAPIRevoker) RevokeAccess(ctx context.Context, req FAPIRevokeRequest) error {
	i := r.Issuer
	if !i.valid() || r.Audit == nil || r.AuditRefresh == nil {
		return errors.New("FAPI revocation not configured")
	}
	if req.ClientID == "" || req.Token == "" || len(req.Token) > 16384 {
		return ErrInvalidClient
	}
	p := i.Private
	return p.Store.Transaction(func() error {
		if _, err := p.Assertions.AuthenticateInTransaction(ctx, req.ClientID, req.AssertionType, req.Assertion); err != nil {
			return err
		}
		var proofJKT string
		if req.Proof != "" {
			scope := mapidpop.NonceScope{ProjectID: i.Keys.ProjectID, ClientID: req.ClientID, Purpose: "revocation"}
			nonce, err := p.Nonces.ResolveProof(ctx, scope, req.Proof)
			if errors.Is(err, mapidpop.ErrInvalidNonce) {
				return newNonceRequired(scope)
			}
			if err != nil {
				return err
			}
			verified, err := mapidpop.Verify(ctx, []string{req.Proof}, mapidpop.Options{ProjectID: i.Keys.ProjectID, Method: http.MethodPost, URL: p.Assertions.Issuer + "/revoke", Nonce: nonce, Now: p.Store.Now(), MaxAge: time.Minute, FutureSkew: 10 * time.Second}, mapidpop.SQLReplay{DB: p.Store.DB})
			if errors.Is(err, mapidpop.ErrInvalidProof) {
				return ErrInvalidDPoP
			}
			if err != nil {
				return err
			}
			proofJKT = verified.Thumbprint
		}
		// Access token signatures and client/project binding are checked without a
		// live session so revocation is idempotent even after logout.
		claims, claimErr := i.signedAccess(ctx, req.Token, "")
		if claimErr != nil && !errors.Is(claimErr, ErrInvalidAccess) {
			return claimErr
		}
		if claimErr == nil && claims.ClientID != req.ClientID {
			claimErr = ErrInvalidAccess
		}
		if claimErr == nil {
			if proofJKT != "" && subtle.ConstantTimeCompare([]byte(proofJKT), []byte(claims.Confirmation.JKT)) != 1 {
				return nil
			}
			if _, err := p.Store.DB.ExecContext(ctx, `DELETE FROM mapi_fapi_revoked_access WHERE rowid IN (SELECT rowid FROM mapi_fapi_revoked_access WHERE project_id=? AND expires_at<=? ORDER BY expires_at LIMIT 100)`, i.Keys.ProjectID, p.Store.Now().Unix()); err != nil {
				return err
			}
			hash := sha256.Sum256([]byte(req.Token))
			var inserted string
			err := p.Store.DB.QueryRowContext(ctx, `INSERT INTO mapi_fapi_revoked_access(project_id,token_hash,expires_at) VALUES(?,?,?) ON CONFLICT DO NOTHING RETURNING project_id`, i.Keys.ProjectID, hash[:], claims.Expiry.Time().Unix()).Scan(&inserted)
			if errors.Is(err, sql.ErrNoRows) {
				return nil
			}
			if err != nil {
				return err
			}
			return r.Audit(ctx, AccessIdentity{Subject: claims.Subject, ClientID: claims.ClientID, SessionID: claims.SessionID, Scope: claims.Scope})
		}
		// Look up only this authenticated client's refresh grant; unknown and
		// foreign tokens take the same successful response without audit or change.
		hash := sha256.Sum256([]byte(req.Token))
		var id AccessIdentity
		var jkt string
		err := p.Store.DB.QueryRowContext(ctx, `SELECT client_id,user_id,session_id,scope,dpop_jkt FROM mapi_fapi_refresh_tokens WHERE token_hash=? AND project_id=? AND client_id=? AND revoked_at IS NULL`, hash[:], i.Keys.ProjectID, req.ClientID).Scan(&id.ClientID, &id.Subject, &id.SessionID, &id.Scope, &jkt)
		if errors.Is(err, sql.ErrNoRows) {
			return nil
		}
		if err != nil {
			return err
		}
		if proofJKT != "" && subtle.ConstantTimeCompare([]byte(proofJKT), []byte(jkt)) != 1 {
			return nil
		}
		changed, err := p.Grants.RevokeRefreshInTransaction(ctx, req.Token, req.ClientID)
		if err != nil || !changed {
			return err
		}
		return r.AuditRefresh(ctx, id)
	})
}
