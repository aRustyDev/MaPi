package mapioauth

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"database/sql"
	"encoding/base64"
	"errors"
	"time"
)

// FAPIGrants is an unmounted, separate sender-constrained grant store. The
// caller must authenticate the client, validate a live session, cryptographically
// verify DPoP and write audit in the SAME outer transaction. It does not modify
// the existing bearer authorization code or rotating refresh-token tables.
type FAPIGrants struct {
	Store     Store
	ProjectID string
}

type FAPICode struct {
	AuthorizationCode
	DPoPJKT string
}
type FAPIRefresh struct {
	RefreshGrant
	DPoPJKT       string
	PolicyVersion int64
}

func (g FAPIGrants) valid() bool { return g.ProjectID != "" && g.Store.DB != nil && g.Store.Now != nil }
func (g FAPIGrants) CreateSchema(ctx context.Context) error {
	if !g.valid() {
		return errors.New("FAPI grant store not configured")
	}
	if _, err := g.Store.DB.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS mapi_fapi_codes (
 code_hash BLOB PRIMARY KEY, project_id TEXT NOT NULL,client_id TEXT NOT NULL,redirect_uri TEXT NOT NULL,
 user_id TEXT NOT NULL,session_id TEXT NOT NULL,scope TEXT NOT NULL,nonce TEXT NOT NULL,
 code_challenge TEXT NOT NULL,dpop_jkt TEXT NOT NULL,expires_at INTEGER NOT NULL)`); err != nil {
		return err
	}
	if _, err := g.Store.DB.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS mapi_fapi_refresh_tokens (
 token_hash BLOB PRIMARY KEY,project_id TEXT NOT NULL,client_id TEXT NOT NULL,user_id TEXT NOT NULL,
 session_id TEXT NOT NULL,scope TEXT NOT NULL,dpop_jkt TEXT NOT NULL,expires_at INTEGER NOT NULL,revoked_at INTEGER)`); err != nil {
		return err
	}
	_, err := g.Store.DB.ExecContext(ctx, `CREATE INDEX IF NOT EXISTS mapi_fapi_refresh_client ON mapi_fapi_refresh_tokens(project_id,client_id)`)
	if err != nil {
		return err
	}
	return createFAPIPolicyBindings(ctx, g.Store)
}
func randomFAPIToken() (string, [32]byte, error) {
	var raw [32]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return "", [32]byte{}, err
	}
	plain := base64.RawURLEncoding.EncodeToString(raw[:])
	return plain, sha256.Sum256([]byte(plain)), nil
}

// IssueCodeInTransaction binds a code to the authenticated login and, when
// supplied by PAR, its DPoP JWK thumbprint. FAPI permits the code itself to
// be unbound; token exchange must nevertheless verify a DPoP proof.
func (g FAPIGrants) IssueCodeInTransaction(ctx context.Context, code AuthorizationCode, dpopJKT string) (string, error) {
	if !g.valid() {
		return "", errors.New("FAPI grant store not configured")
	}
	now := g.Store.Now()
	if now.IsZero() || code.ProjectID != g.ProjectID || code.PolicyVersion <= 0 || code.ClientID == "" || code.RedirectURI == "" || code.UserID == "" || code.SessionID == "" || !validChallenge(code.CodeChallenge) || (dpopJKT != "" && !validLoginSecret(dpopJKT)) || !code.ExpiresAt.Truncate(time.Millisecond).After(now) || code.ExpiresAt.After(now.Add(time.Minute)) {
		return "", errors.New("invalid FAPI authorization code")
	}
	plain, hash, err := randomFAPIToken()
	if err != nil {
		return "", err
	}
	_, err = g.Store.DB.ExecContext(ctx, `INSERT INTO mapi_fapi_codes(code_hash,project_id,client_id,redirect_uri,user_id,session_id,scope,nonce,code_challenge,dpop_jkt,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`, hash[:], code.ProjectID, code.ClientID, code.RedirectURI, code.UserID, code.SessionID, code.Scope, code.Nonce, code.CodeChallenge, dpopJKT, code.ExpiresAt.UnixMilli())
	if err != nil {
		return "", err
	}
	if err = bindFAPIPolicy(ctx, g.Store, "code", hash[:], code.ProjectID, code.ClientID, code.PolicyVersion, code.ExpiresAt); err != nil {
		return "", err
	}
	return plain, nil
}

// ConsumeCodeInTransaction consumes a code after the caller has verified a
// fresh token-endpoint DPoP proof. The verified proof's JKT is mandatory and
// becomes the token binding even when PAR did not bind the code in advance.
// Client authentication, DPoP replay protection, issuance and audit must all
// be part of the caller's existing transaction.
func (g FAPIGrants) ConsumeCodeInTransaction(ctx context.Context, plain, clientID, redirectURI, verifier, verifiedJKT string) (FAPICode, error) {
	if !g.valid() {
		return FAPICode{}, errors.New("FAPI grant store not configured")
	}
	if g.Store.Now().IsZero() || len(plain) != 43 || clientID == "" || redirectURI == "" || !validVerifier(verifier) || !validLoginSecret(verifiedJKT) {
		return FAPICode{}, ErrInvalidCode
	}
	hash := sha256.Sum256([]byte(plain))
	challenge := sha256.Sum256([]byte(verifier))
	challengeText := base64.RawURLEncoding.EncodeToString(challenge[:])
	var code FAPICode
	var expiry int64
	err := g.Store.DB.QueryRowContext(ctx, `SELECT project_id,client_id,redirect_uri,user_id,session_id,scope,nonce,code_challenge,dpop_jkt,expires_at FROM mapi_fapi_codes WHERE code_hash=?`, hash[:]).Scan(&code.ProjectID, &code.ClientID, &code.RedirectURI, &code.UserID, &code.SessionID, &code.Scope, &code.Nonce, &code.CodeChallenge, &code.DPoPJKT, &expiry)
	if errors.Is(err, sql.ErrNoRows) {
		return FAPICode{}, ErrInvalidCode
	}
	if err != nil {
		return FAPICode{}, err
	}
	code.ExpiresAt = time.UnixMilli(expiry)
	code.PolicyVersion, err = getFAPIPolicyBinding(ctx, g.Store, "code", hash[:], code.ProjectID, code.ClientID)
	if errors.Is(err, ErrFAPIPolicyDenied) {
		return FAPICode{}, ErrInvalidCode
	}
	if err != nil {
		return FAPICode{}, err
	}
	if code.ProjectID != g.ProjectID || code.ClientID != clientID || code.RedirectURI != redirectURI || !g.Store.Now().Before(code.ExpiresAt) || subtle.ConstantTimeCompare([]byte(challengeText), []byte(code.CodeChallenge)) != 1 || (code.DPoPJKT != "" && subtle.ConstantTimeCompare([]byte(code.DPoPJKT), []byte(verifiedJKT)) != 1) {
		return FAPICode{}, ErrInvalidCode
	}
	var deleted []byte
	err = g.Store.DB.QueryRowContext(ctx, `DELETE FROM mapi_fapi_codes WHERE code_hash=? RETURNING code_hash`, hash[:]).Scan(&deleted)
	if errors.Is(err, sql.ErrNoRows) {
		return FAPICode{}, ErrInvalidCode
	}
	if err != nil {
		return FAPICode{}, err
	}
	if err = deleteFAPIPolicyBinding(ctx, g.Store, "code", hash[:]); err != nil {
		return FAPICode{}, err
	}
	code.DPoPJKT = verifiedJKT
	return code, nil
}

// IssueRefreshInTransaction creates a sender-constrained, non-rotating
// refresh token. FAPI 2.0 says ordinary refresh rotation must not be used
// except in extraordinary circumstances. Caller commits token and audit writes.
func (g FAPIGrants) IssueRefreshInTransaction(ctx context.Context, grant FAPIRefresh) (string, error) {
	if !g.valid() {
		return "", errors.New("FAPI grant store not configured")
	}
	now := g.Store.Now()
	if now.IsZero() || grant.ProjectID != g.ProjectID || grant.PolicyVersion <= 0 || grant.ClientID == "" || grant.UserID == "" || grant.SessionID == "" || !validLoginSecret(grant.DPoPJKT) || !grant.ExpiresAt.Truncate(time.Millisecond).After(now) || grant.ExpiresAt.After(now.Add(30*24*time.Hour)) {
		return "", errors.New("invalid FAPI refresh grant")
	}
	plain, hash, err := randomFAPIToken()
	if err != nil {
		return "", err
	}
	_, err = g.Store.DB.ExecContext(ctx, `INSERT INTO mapi_fapi_refresh_tokens(token_hash,project_id,client_id,user_id,session_id,scope,dpop_jkt,expires_at) VALUES(?,?,?,?,?,?,?,?)`, hash[:], grant.ProjectID, grant.ClientID, grant.UserID, grant.SessionID, grant.Scope, grant.DPoPJKT, grant.ExpiresAt.UnixMilli())
	if err != nil {
		return "", err
	}
	if err = bindFAPIPolicy(ctx, g.Store, "refresh", hash[:], grant.ProjectID, grant.ClientID, grant.PolicyVersion, grant.ExpiresAt); err != nil {
		return "", err
	}
	return plain, nil
}

// RefreshInTransaction requires a cryptographically verified fresh DPoP proof
// by the same key as the grant. The token is deliberately not rotated here.
func (g FAPIGrants) RefreshInTransaction(ctx context.Context, plain, clientID, verifiedJKT string) (FAPIRefresh, error) {
	if !g.valid() {
		return FAPIRefresh{}, errors.New("FAPI grant store not configured")
	}
	if g.Store.Now().IsZero() || len(plain) != 43 || clientID == "" || !validLoginSecret(verifiedJKT) {
		return FAPIRefresh{}, ErrInvalidRefresh
	}
	hash := sha256.Sum256([]byte(plain))
	var grant FAPIRefresh
	var expiry int64
	var revoked sql.NullInt64
	err := g.Store.DB.QueryRowContext(ctx, `SELECT project_id,client_id,user_id,session_id,scope,dpop_jkt,expires_at,revoked_at FROM mapi_fapi_refresh_tokens WHERE token_hash=?`, hash[:]).Scan(&grant.ProjectID, &grant.ClientID, &grant.UserID, &grant.SessionID, &grant.Scope, &grant.DPoPJKT, &expiry, &revoked)
	if errors.Is(err, sql.ErrNoRows) {
		return FAPIRefresh{}, ErrInvalidRefresh
	}
	if err != nil {
		return FAPIRefresh{}, err
	}
	grant.ExpiresAt = time.UnixMilli(expiry)
	grant.PolicyVersion, err = getFAPIPolicyBinding(ctx, g.Store, "refresh", hash[:], grant.ProjectID, grant.ClientID)
	if errors.Is(err, ErrFAPIPolicyDenied) {
		return FAPIRefresh{}, ErrInvalidRefresh
	}
	if err != nil {
		return FAPIRefresh{}, err
	}
	if grant.ProjectID != g.ProjectID || grant.ClientID != clientID || revoked.Valid || !g.Store.Now().Before(grant.ExpiresAt) || subtle.ConstantTimeCompare([]byte(grant.DPoPJKT), []byte(verifiedJKT)) != 1 {
		return FAPIRefresh{}, ErrInvalidRefresh
	}
	return grant, nil
}

// RevokeRefreshInTransaction is idempotent; the caller authenticates the
// client and emits an audit event in the same transaction when changed is true.
func (g FAPIGrants) RevokeRefreshInTransaction(ctx context.Context, plain, clientID string) (bool, error) {
	if !g.valid() {
		return false, errors.New("FAPI grant store not configured")
	}
	if g.Store.Now().IsZero() {
		return false, errors.New("FAPI grant clock unavailable")
	}
	if len(plain) != 43 || clientID == "" {
		return false, nil
	}
	hash := sha256.Sum256([]byte(plain))
	var id string
	err := g.Store.DB.QueryRowContext(ctx, `UPDATE mapi_fapi_refresh_tokens SET revoked_at=? WHERE token_hash=? AND project_id=? AND client_id=? AND revoked_at IS NULL RETURNING client_id`, g.Store.Now().UnixMilli(), hash[:], g.ProjectID, clientID).Scan(&id)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return true, nil
}
