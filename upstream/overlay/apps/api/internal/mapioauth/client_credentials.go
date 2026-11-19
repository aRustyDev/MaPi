package mapioauth

import (
	"context"
	"database/sql"
	"errors"

	"github.com/zitadel/nextgen/internal/domain"
	"github.com/zitadel/nextgen/internal/secrets"
)

// ClientCredential contains a one-time plaintext secret. Return it only on
// the authenticated operator channel and never persist it in plaintext.
type ClientCredential struct {
	ClientID string `json:"clientId"`
	Secret   string `json:"secret"`
}

func (s Store) CreateClientEpochSchema(ctx context.Context) error {
	if s.DB == nil {
		return errors.New("client credential store not configured")
	}
	_, err := s.DB.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS mapi_oauth_client_epochs (project_id TEXT NOT NULL, client_id TEXT NOT NULL, epoch INTEGER NOT NULL CHECK(epoch >= 0), PRIMARY KEY(project_id,client_id))`)
	return err
}
func (s Store) clientEpoch(ctx context.Context, project, client string) (int64, error) {
	var epoch int64
	err := s.DB.QueryRowContext(ctx, `SELECT epoch FROM mapi_oauth_client_epochs WHERE project_id=? AND client_id=?`, project, client).Scan(&epoch)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, nil
	}
	return epoch, err
}

// invalidateClient runs in the operator's transaction. Incrementing the epoch
// invalidates earlier access tokens at authoritative checks, while deleting
// codes and revoking all refreshes prevents further issuance.
func (a Admin) invalidateClient(ctx context.Context, clientID string) error {
	if _, err := a.Store.DB.ExecContext(ctx, `INSERT INTO mapi_oauth_client_epochs(project_id,client_id,epoch) VALUES(?,?,1) ON CONFLICT(project_id,client_id) DO UPDATE SET epoch=epoch+1`, a.ProjectID, clientID); err != nil {
		return err
	}
	if _, err := a.Store.DB.ExecContext(ctx, `DELETE FROM mapi_oauth_codes WHERE project_id=? AND client_id=?`, a.ProjectID, clientID); err != nil {
		return err
	}
	_, err := a.Store.DB.ExecContext(ctx, `UPDATE mapi_oauth_refresh_tokens SET revoked_at=? WHERE project_id=? AND client_id=? AND revoked_at IS NULL`, a.Store.Now().UnixMilli(), a.ProjectID, clientID)
	return err
}

// RotateClientSecret replaces all existing client secrets in one transaction,
// invalidates that client's pending authorization and tokens, and audits the
// operation. A lost response can be recovered by rotating again; that also
// invalidates any prior response that might have reached a caller.
func (a Admin) RotateClientSecret(ctx context.Context, clientID string) (ClientCredential, error) {
	if err := a.configured(); err != nil {
		return ClientCredential{}, err
	}
	if err := a.requireReady(ctx); err != nil {
		return ClientCredential{}, err
	}
	if clientID == "" || a.Registry.Statements == nil || a.AuditClientCredential == nil {
		return ClientCredential{}, errors.New("client credential management not configured")
	}
	plain, err := secrets.NewRandomSecretGenerator().New(string(domain.PrefixApplicationClient))
	if err != nil {
		return ClientCredential{}, err
	}
	err = a.Store.Transaction(func() error {
		client, err := a.Registry.Lookup(ctx, a.ProjectID, clientID)
		if err != nil {
			return err
		}
		if _, err = a.Store.DB.ExecContext(ctx, `DELETE FROM application_client_secrets WHERE project_id=? AND application_client_id=?`, a.ProjectID, client.rowID); err != nil {
			return err
		}
		secret := &domain.ApplicationClientSecret{ProjectID: a.ProjectID, ApplicationClientID: client.rowID, SecretHash: domain.HashSecret(plain)}
		if err = a.Registry.Statements.CreateApplicationClientSecret(ctx, secret); err != nil {
			return err
		}
		if err = a.invalidateClient(ctx, clientID); err != nil {
			return err
		}
		return a.AuditClientCredential(ctx, clientID, "rotated")
	})
	if err != nil {
		return ClientCredential{}, err
	}
	return ClientCredential{ClientID: clientID, Secret: plain}, nil
}

// RevokeClientSecrets disables every secret and invalidates tokens for that
// client in the same audited transaction. Repeated calls are idempotent.
func (a Admin) RevokeClientSecrets(ctx context.Context, clientID string) error {
	if err := a.configured(); err != nil {
		return err
	}
	if err := a.requireReady(ctx); err != nil {
		return err
	}
	if clientID == "" || a.Registry.Statements == nil || a.AuditClientCredential == nil {
		return errors.New("client credential management not configured")
	}
	return a.Store.Transaction(func() error {
		client, err := a.Registry.Lookup(ctx, a.ProjectID, clientID)
		if err != nil {
			return err
		}
		result, err := a.Store.DB.ExecContext(ctx, `DELETE FROM application_client_secrets WHERE project_id=? AND application_client_id=?`, a.ProjectID, client.rowID)
		if err != nil {
			return err
		}
		count, err := result.RowsAffected()
		if err != nil || count == 0 {
			return err
		}
		if err = a.invalidateClient(ctx, clientID); err != nil {
			return err
		}
		return a.AuditClientCredential(ctx, clientID, "revoked")
	})
}
