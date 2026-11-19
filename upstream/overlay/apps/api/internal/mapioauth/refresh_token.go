package mapioauth

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"errors"
	"fmt"
	"time"
)

var (
	ErrInvalidRefresh = errors.New("invalid refresh token")
	ErrRefreshReuse   = errors.New("refresh token reuse detected")
)

type RefreshGrant struct {
	ProjectID string
	ClientID  string
	UserID    string
	SessionID string
	Scope     string
	ExpiresAt time.Time
}

// CreateRefreshSchema must run in the database's versioned migration.
func (s Store) CreateRefreshSchema(ctx context.Context) error {
	_, err := s.DB.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS mapi_oauth_refresh_tokens (
		token_hash BLOB PRIMARY KEY,
		family_id BLOB NOT NULL,
		project_id TEXT NOT NULL,
		client_id TEXT NOT NULL,
		user_id TEXT NOT NULL,
		session_id TEXT NOT NULL,
		scope TEXT NOT NULL,
		expires_at INTEGER NOT NULL,
		used_at INTEGER,
		revoked_at INTEGER
	)`)
	if err != nil {
		return err
	}
	_, err = s.DB.ExecContext(ctx, `CREATE INDEX IF NOT EXISTS mapi_oauth_refresh_families ON mapi_oauth_refresh_tokens (project_id, family_id)`)
	return err
}

func randomRefreshToken() (string, [32]byte, error) {
	var raw [32]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return "", [32]byte{}, fmt.Errorf("generate refresh token: %w", err)
	}
	plain := base64.RawURLEncoding.EncodeToString(raw[:])
	return plain, sha256.Sum256([]byte(plain)), nil
}

// IssueRefresh must run inside the caller's authorization-code transaction.
// The caller returns the token only after the encompassing transaction commits.
func (s Store) IssueRefresh(ctx context.Context, grant RefreshGrant) (string, error) {
	if s.DB == nil || s.Now == nil {
		return "", errors.New("refresh token store is not configured")
	}
	if grant.ProjectID == "" || grant.ClientID == "" || grant.UserID == "" || grant.SessionID == "" || !grant.ExpiresAt.Truncate(time.Millisecond).After(s.Now()) {
		return "", errors.New("invalid refresh grant fields")
	}
	plain, digest, err := randomRefreshToken()
	if err != nil {
		return "", err
	}
	var family [32]byte
	if _, err := rand.Read(family[:]); err != nil {
		return "", fmt.Errorf("generate refresh family: %w", err)
	}
	_, err = s.DB.ExecContext(ctx, `INSERT INTO mapi_oauth_refresh_tokens
		(token_hash, family_id, project_id, client_id, user_id, session_id, scope, expires_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, digest[:], family[:], grant.ProjectID, grant.ClientID, grant.UserID, grant.SessionID, grant.Scope, grant.ExpiresAt.UnixMilli())
	if err != nil {
		return "", err
	}
	return plain, nil
}

// RotateRefresh invalidates a token and issues a replacement in one transaction.
// Reuse revokes the family and commits onReuse before returning ErrRefreshReuse.
// The callbacks must revalidate session state and record token and audit writes.
func (s Store) RotateRefresh(ctx context.Context, plain, projectID, clientID string, commit func(context.Context, RefreshGrant) error, onReuse func(context.Context, RefreshGrant) error) (string, error) {
	if s.DB == nil || s.Transaction == nil || s.Now == nil || commit == nil || onReuse == nil {
		return "", errors.New("refresh token store is not configured")
	}
	if len(plain) != 43 || projectID == "" || clientID == "" {
		return "", ErrInvalidRefresh
	}
	hash := sha256.Sum256([]byte(plain))
	var replacement string
	var reused bool
	err := s.Transaction(func() error {
		var grant RefreshGrant
		var family []byte
		var expiry int64
		var used, revoked sql.NullInt64
		err := s.DB.QueryRowContext(ctx, `SELECT family_id, project_id, client_id, user_id, session_id, scope, expires_at, used_at, revoked_at
			FROM mapi_oauth_refresh_tokens WHERE token_hash = ?`, hash[:]).Scan(&family, &grant.ProjectID, &grant.ClientID,
			&grant.UserID, &grant.SessionID, &grant.Scope, &expiry, &used, &revoked)
		if errors.Is(err, sql.ErrNoRows) {
			return ErrInvalidRefresh
		}
		if err != nil {
			return err
		}
		grant.ExpiresAt = time.UnixMilli(expiry)
		if grant.ProjectID != projectID || grant.ClientID != clientID || revoked.Valid || !s.Now().Before(grant.ExpiresAt) {
			return ErrInvalidRefresh
		}
		if used.Valid {
			if _, err := s.DB.ExecContext(ctx, `UPDATE mapi_oauth_refresh_tokens SET revoked_at = ? WHERE project_id = ? AND family_id = ? AND revoked_at IS NULL`, s.Now().UnixMilli(), projectID, family); err != nil {
				return err
			}
			if err := onReuse(ctx, grant); err != nil {
				return err
			}
			reused = true
			return nil
		}
		next, digest, err := randomRefreshToken()
		if err != nil {
			return err
		}
		if _, err := s.DB.ExecContext(ctx, `UPDATE mapi_oauth_refresh_tokens SET used_at = ? WHERE token_hash = ?`, s.Now().UnixMilli(), hash[:]); err != nil {
			return err
		}
		if _, err := s.DB.ExecContext(ctx, `INSERT INTO mapi_oauth_refresh_tokens
			(token_hash, family_id, project_id, client_id, user_id, session_id, scope, expires_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, digest[:], family, grant.ProjectID, grant.ClientID, grant.UserID, grant.SessionID, grant.Scope, expiry); err != nil {
			return err
		}
		if err := commit(ctx, grant); err != nil {
			return err
		}
		replacement = next
		return nil
	})
	if err != nil {
		return "", err
	}
	if reused {
		return "", ErrRefreshReuse
	}
	return replacement, nil
}
