package mapidpop

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
)

var ErrInvalidNonce = errors.New("invalid or expired DPoP nonce")

// NonceScope is constructed from server-validated context, not proof claims.
// Purpose separates PAR, token and resource-server nonce domains.
type NonceScope struct{ ProjectID, ClientID, Purpose string }

func (s NonceScope) valid() bool {
	return s.ProjectID != "" && len(s.ProjectID) <= 256 && s.ClientID != "" && len(s.ClientID) <= 512 && (s.Purpose == "par" || s.Purpose == "token" || s.Purpose == "resource")
}

// NonceStore stores only a hash. Issue requires a transaction and audit;
// ResolveProof must run inside the caller's existing protected transaction.
type NonceStore struct {
	DB          ReplayDB
	Transaction func(func() error) error
	Now         func() time.Time
	TTL         time.Duration
	Audit       func(context.Context, NonceScope) error
}

func InitNonceSchema(ctx context.Context, db Execer) error {
	if _, err := db.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS mapi_dpop_nonces (
 nonce_hash BLOB PRIMARY KEY, project_id TEXT NOT NULL, client_id TEXT NOT NULL,
 purpose TEXT NOT NULL, expires_at INTEGER NOT NULL)`); err != nil {
		return err
	}
	_, err := db.ExecContext(ctx, `CREATE INDEX IF NOT EXISTS mapi_dpop_nonces_expiry ON mapi_dpop_nonces (project_id, expires_at)`)
	return err
}
func (s NonceStore) Issue(ctx context.Context, scope NonceScope) (string, error) {
	if s.DB == nil || s.Transaction == nil || s.Now == nil || s.Audit == nil || !scope.valid() || s.TTL < time.Second || s.TTL > 5*time.Minute {
		return "", errors.New("invalid nonce issuer configuration")
	}
	var raw [32]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return "", fmt.Errorf("nonce generation: %w", err)
	}
	value := base64.RawURLEncoding.EncodeToString(raw[:])
	hash := sha256.Sum256([]byte(value))
	err := s.Transaction(func() error {
		now := s.Now()
		if now.IsZero() {
			return errors.New("nonce clock unavailable")
		}
		if _, err := s.DB.ExecContext(ctx, `INSERT INTO mapi_dpop_nonces (nonce_hash,project_id,client_id,purpose,expires_at) VALUES (?,?,?,?,?)`, hash[:], scope.ProjectID, scope.ClientID, scope.Purpose, now.Add(s.TTL).UnixMilli()); err != nil {
			return err
		}
		return s.Audit(ctx, scope)
	})
	if err != nil {
		return "", err
	}
	return value, nil
}

// ResolveProof treats the JWT payload as untrusted, and only resolves a nonce
// issued for the authenticated server-side scope. It does NOT authenticate the
// proof: callers must immediately invoke Verify inside the same transaction.
func (s NonceStore) ResolveProof(ctx context.Context, scope NonceScope, proof string) (string, error) {
	if s.DB == nil || s.Now == nil || !scope.valid() {
		return "", errors.New("invalid nonce verifier configuration")
	}
	if len(proof) > 16384 || strings.ContainsAny(proof, " \t\r\n,") {
		return "", ErrInvalidNonce
	}
	parts := strings.Split(proof, ".")
	if len(parts) != 3 {
		return "", ErrInvalidNonce
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil || !uniqueJSON(payload) {
		return "", ErrInvalidNonce
	}
	var claims struct {
		Nonce string `json:"nonce"`
	}
	if json.Unmarshal(payload, &claims) != nil || len(claims.Nonce) != 43 {
		return "", ErrInvalidNonce
	}
	decoded, err := base64.RawURLEncoding.DecodeString(claims.Nonce)
	if err != nil || len(decoded) != 32 || base64.RawURLEncoding.EncodeToString(decoded) != claims.Nonce {
		return "", ErrInvalidNonce
	}
	hash := sha256.Sum256([]byte(claims.Nonce))
	var expires int64
	err = s.DB.QueryRowContext(ctx, `SELECT expires_at FROM mapi_dpop_nonces WHERE nonce_hash=? AND project_id=? AND client_id=? AND purpose=?`, hash[:], scope.ProjectID, scope.ClientID, scope.Purpose).Scan(&expires)
	if errors.Is(err, sql.ErrNoRows) {
		return "", ErrInvalidNonce
	}
	if err != nil {
		return "", fmt.Errorf("nonce storage: %w", err)
	}
	now := s.Now()
	if now.IsZero() {
		return "", errors.New("nonce clock unavailable")
	}
	if !now.Before(time.UnixMilli(expires)) {
		return "", ErrInvalidNonce
	}
	return claims.Nonce, nil
}

// Cleanup is bounded and project-scoped; the caller supplies its transaction.
func (s NonceStore) Cleanup(ctx context.Context, project string) error {
	if s.DB == nil || s.Now == nil || project == "" {
		return errors.New("invalid nonce cleanup configuration")
	}
	now := s.Now()
	if now.IsZero() {
		return errors.New("nonce clock unavailable")
	}
	_, err := s.DB.ExecContext(ctx, `DELETE FROM mapi_dpop_nonces WHERE rowid IN (SELECT rowid FROM mapi_dpop_nonces WHERE project_id=? AND expires_at<=? ORDER BY expires_at LIMIT 100)`, project, now.UnixMilli())
	return err
}
