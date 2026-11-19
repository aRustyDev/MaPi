// Package mapioauth provides stateful primitives for MaPi's OIDC adapter.
package mapioauth

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"database/sql"
	"encoding/base64"
	"errors"
	"fmt"
	"strings"
	"time"
)

var ErrInvalidCode = errors.New("invalid authorization code")

// Transaction executes fn atomically, committing only when it returns nil.
// Its callback must use the same database connection as Store.DB.
type Transaction func(fn func() error) error

// Store holds only hashes of authorization codes. Token creation must occur
// in the Consume callback so a failed exchange leaves the code usable.
type Store struct {
	DB          *sql.DB
	Transaction Transaction
	Now         func() time.Time
}

type AuthorizationCode struct {
	ProjectID     string
	ClientID      string
	RedirectURI   string
	UserID        string
	SessionID     string
	Scope         string
	Nonce         string
	CodeChallenge string
	ExpiresAt     time.Time
}

// CreateSchema must be called during the database's versioned migration.
func (s Store) CreateSchema(ctx context.Context) error {
	_, err := s.DB.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS mapi_oauth_codes (
		code_hash BLOB PRIMARY KEY,
		project_id TEXT NOT NULL,
		client_id TEXT NOT NULL,
		redirect_uri TEXT NOT NULL,
		user_id TEXT NOT NULL,
		session_id TEXT NOT NULL,
		scope TEXT NOT NULL,
		nonce TEXT NOT NULL,
		code_challenge TEXT NOT NULL,
		expires_at INTEGER NOT NULL
	)`)
	return err
}

// Issue persists an authorization code bound to a previously validated
// client, redirect URI, authenticated session and S256 PKCE challenge.
func (s Store) Issue(ctx context.Context, code AuthorizationCode) (string, error) {
	if s.Transaction == nil {
		return "", errors.New("authorization code store is not configured")
	}
	var plain string
	err := s.Transaction(func() error {
		var err error
		plain, err = s.IssueInTransaction(ctx, code)
		return err
	})
	if err != nil {
		return "", err
	}
	return plain, nil
}

// IssueInTransaction inserts the code in the caller's existing transaction.
// A login continuation must consume its browser-bound state and write the
// audit record in that same transaction, and expose the code only after commit.
func (s Store) IssueInTransaction(ctx context.Context, code AuthorizationCode) (string, error) {
	if s.DB == nil || s.Now == nil {
		return "", errors.New("authorization code store is not configured")
	}
	if code.ProjectID == "" || code.ClientID == "" || code.RedirectURI == "" || code.UserID == "" || code.SessionID == "" || !validChallenge(code.CodeChallenge) || !code.ExpiresAt.Truncate(time.Millisecond).After(s.Now()) {
		return "", errors.New("invalid authorization code fields")
	}
	random := make([]byte, 32)
	if _, err := rand.Read(random); err != nil {
		return "", fmt.Errorf("generate authorization code: %w", err)
	}
	plain := base64.RawURLEncoding.EncodeToString(random)
	hash := sha256.Sum256([]byte(plain))
	_, err := s.DB.ExecContext(ctx, `INSERT INTO mapi_oauth_codes
		(code_hash, project_id, client_id, redirect_uri, user_id, session_id, scope, nonce, code_challenge, expires_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, hash[:], code.ProjectID, code.ClientID, code.RedirectURI,
		code.UserID, code.SessionID, code.Scope, code.Nonce, code.CodeChallenge, code.ExpiresAt.UnixMilli())
	if err != nil {
		return "", err
	}
	return plain, nil
}

// Consume verifies and deletes a code inside the same transaction as commit.
// The callback must revalidate the session and perform all token mutations.
func (s Store) Consume(ctx context.Context, plain, projectID, clientID, redirectURI, verifier string, commit func(context.Context, AuthorizationCode) error) error {
	if s.DB == nil || s.Transaction == nil || s.Now == nil || commit == nil {
		return errors.New("authorization code store is not configured")
	}
	if len(plain) != 43 || !validVerifier(verifier) || projectID == "" || clientID == "" || redirectURI == "" {
		return ErrInvalidCode
	}
	hash := sha256.Sum256([]byte(plain))
	challenge := sha256.Sum256([]byte(verifier))
	challengeText := base64.RawURLEncoding.EncodeToString(challenge[:])
	return s.Transaction(func() error {
		var code AuthorizationCode
		var expiry int64
		err := s.DB.QueryRowContext(ctx, `SELECT project_id, client_id, redirect_uri, user_id, session_id, scope, nonce, code_challenge, expires_at
			FROM mapi_oauth_codes WHERE code_hash = ?`, hash[:]).Scan(&code.ProjectID, &code.ClientID, &code.RedirectURI,
			&code.UserID, &code.SessionID, &code.Scope, &code.Nonce, &code.CodeChallenge, &expiry)
		if errors.Is(err, sql.ErrNoRows) {
			return ErrInvalidCode
		}
		if err != nil {
			return err
		}
		code.ExpiresAt = time.UnixMilli(expiry)
		if code.ProjectID != projectID || code.ClientID != clientID || code.RedirectURI != redirectURI || !s.Now().Before(code.ExpiresAt) || subtle.ConstantTimeCompare([]byte(challengeText), []byte(code.CodeChallenge)) != 1 {
			return ErrInvalidCode
		}
		result, err := s.DB.ExecContext(ctx, `DELETE FROM mapi_oauth_codes WHERE code_hash = ?`, hash[:])
		if err != nil {
			return err
		}
		count, err := result.RowsAffected()
		if err != nil {
			return err
		}
		if count != 1 {
			return ErrInvalidCode
		}
		return commit(ctx, code)
	})
}

func validChallenge(challenge string) bool {
	if len(challenge) != 43 {
		return false
	}
	decoded, err := base64.RawURLEncoding.DecodeString(challenge)
	return err == nil && len(decoded) == sha256.Size && base64.RawURLEncoding.EncodeToString(decoded) == challenge
}

func validVerifier(verifier string) bool {
	if len(verifier) < 43 || len(verifier) > 128 {
		return false
	}
	for _, r := range verifier {
		if !strings.ContainsRune("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~", r) {
			return false
		}
	}
	return true
}
