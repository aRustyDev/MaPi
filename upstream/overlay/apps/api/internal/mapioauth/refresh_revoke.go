package mapioauth

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"errors"
	"time"
)

// RevokeRefresh revokes every member of the supplied token's refresh family.
// Client authentication is repeated inside the same transaction, and the audit
// callback is committed atomically with the revocation. Unknown, already
// revoked, and differently scoped tokens are deliberately indistinguishable.
// This primitive is not an RFC 7009 endpoint: access token revocation and
// downstream verification need a separate implementation before publication.
func (s Store) RevokeRefresh(ctx context.Context, plain, projectID, clientID string, authenticate func(context.Context) error, audit func(context.Context, RefreshGrant) error) error {
	if s.DB == nil || s.Transaction == nil || s.Now == nil || authenticate == nil || audit == nil || projectID == "" || clientID == "" {
		return errors.New("refresh revocation not configured")
	}
	return s.Transaction(func() error {
		if err := authenticate(ctx); err != nil {
			return err
		}
		if len(plain) != 43 {
			return nil
		}
		hash := sha256.Sum256([]byte(plain))
		var family []byte
		var grant RefreshGrant
		var expires int64
		err := s.DB.QueryRowContext(ctx, `SELECT family_id,project_id,client_id,user_id,session_id,scope,expires_at FROM mapi_oauth_refresh_tokens WHERE token_hash=?`, hash[:]).Scan(&family, &grant.ProjectID, &grant.ClientID, &grant.UserID, &grant.SessionID, &grant.Scope, &expires)
		if errors.Is(err, sql.ErrNoRows) {
			return nil
		}
		if err != nil {
			return err
		}
		if grant.ProjectID != projectID || grant.ClientID != clientID {
			return nil
		}
		grant.ExpiresAt = time.UnixMilli(expires)
		result, err := s.DB.ExecContext(ctx, `UPDATE mapi_oauth_refresh_tokens SET revoked_at=? WHERE project_id=? AND family_id=? AND revoked_at IS NULL`, s.Now().UnixMilli(), projectID, family)
		if err != nil {
			return err
		}
		count, err := result.RowsAffected()
		if err != nil {
			return err
		}
		if count == 0 {
			return nil
		}
		return audit(ctx, grant)
	})
}
