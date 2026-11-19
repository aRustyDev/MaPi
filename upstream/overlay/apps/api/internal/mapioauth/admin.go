package mapioauth

import (
	"context"
	"database/sql"
	"errors"
	"fmt"

	"github.com/zitadel/nextgen/internal/domain"
	"github.com/zitadel/nextgen/internal/service"
)

const schemaVersion = 4

// Admin is an unmounted Go adapter. The trusted caller binds it to exactly one
// project object and authenticates every operation; no secret or application
// response should be logged. The project and application services must use the
// same authoritative project database as Store.
type Admin struct {
	ProjectID string
	Store     Store
	Projects  interface {
		GetProject(context.Context, string, service.ProjectQueryOptions) (*domain.Project, error)
	}
	Applications          service.ApplicationService
	Registry              ClientRegistry
	AuditLogoutURI        func(context.Context, string, string) error
	AuditClientCredential func(context.Context, string, string) error
	SigningKeys           SigningKeys
}

func (a Admin) configured() error {
	if a.ProjectID == "" || a.Store.DB == nil || a.Store.Transaction == nil || a.Store.Now == nil || a.Projects == nil || a.Applications == nil || a.SigningKeys.ProjectID != a.ProjectID || a.SigningKeys.Keys == nil || a.SigningKeys.AuditRotation == nil {
		return errors.New("OAuth admin not configured")
	}
	return nil
}
func (a Admin) project(ctx context.Context) error {
	project, err := a.Projects.GetProject(ctx, a.ProjectID, service.ProjectQueryOptions{})
	if err != nil {
		return err
	}
	if project == nil || project.ID != a.ProjectID {
		return errors.New("project is unavailable")
	}
	return nil
}

// InitializeSchema installs the OAuth tables and version marker in a single
// storage transaction. An unknown future version is rejected; the caller must
// initialize Nextgen's own schema separately before calling this method.
func (a Admin) InitializeSchema(ctx context.Context) error {
	if err := a.configured(); err != nil {
		return err
	}
	return a.Store.Transaction(func() error {
		if err := a.project(ctx); err != nil {
			return err
		}
		if _, err := a.Store.DB.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS mapi_oauth_schema (singleton INTEGER PRIMARY KEY CHECK(singleton=1), version INTEGER NOT NULL)`); err != nil {
			return err
		}
		var version int
		err := a.Store.DB.QueryRowContext(ctx, `SELECT version FROM mapi_oauth_schema WHERE singleton=1`).Scan(&version)
		if err == nil {
			switch version {
			case schemaVersion:
				return nil
			case 1, 2, 3:
				if version == 1 {
					if err := (TokenIssuer{Store: a.Store}).CreateSchema(ctx); err != nil {
						return err
					}
				}
				if version <= 2 {
					if err := a.Store.CreateLogoutSchema(ctx); err != nil {
						return err
					}
				}
				if err := a.Store.CreateClientEpochSchema(ctx); err != nil {
					return err
				}
				_, err := a.Store.DB.ExecContext(ctx, `UPDATE mapi_oauth_schema SET version=? WHERE singleton=1 AND version=?`, schemaVersion, version)
				return err
			default:
				return fmt.Errorf("unsupported OAuth schema version %d", version)
			}
		}
		if !errors.Is(err, sql.ErrNoRows) {
			return err
		}
		if err := a.Store.CreateSchema(ctx); err != nil {
			return err
		}
		if err := a.Store.CreateRefreshSchema(ctx); err != nil {
			return err
		}
		if err := (LoginBridge{Store: a.Store}).CreateSchema(ctx); err != nil {
			return err
		}
		keys := a.SigningKeys
		keys.Store = a.Store
		if err := keys.CreateSchema(ctx); err != nil {
			return err
		}
		if err := (TokenIssuer{Store: a.Store}).CreateSchema(ctx); err != nil {
			return err
		}
		if err := a.Store.CreateLogoutSchema(ctx); err != nil {
			return err
		}
		if err := a.Store.CreateClientEpochSchema(ctx); err != nil {
			return err
		}
		_, err = a.Store.DB.ExecContext(ctx, `INSERT INTO mapi_oauth_schema(singleton,version) VALUES(1,?)`, schemaVersion)
		return err
	})
}

// RegisterApplication invokes Nextgen's validation and audited service
// transaction. Its output includes one-time plaintext client secrets and must
// only be returned over the authenticated operator channel.
func (a Admin) RegisterApplication(ctx context.Context, document []byte) (*service.CreateApplicationOutput, error) {
	if err := a.configured(); err != nil {
		return nil, err
	}
	if len(document) == 0 || len(document) > 65536 {
		return nil, errors.New("invalid application document size")
	}
	if err := a.requireReady(ctx); err != nil {
		return nil, err
	}
	return RegisterApplication(ctx, a.Applications, a.ProjectID, document)
}

func (a Admin) requireReady(ctx context.Context) error {
	if err := a.project(ctx); err != nil {
		return err
	}
	var version int
	if err := a.Store.DB.QueryRowContext(ctx, `SELECT version FROM mapi_oauth_schema WHERE singleton=1`).Scan(&version); err != nil {
		return err
	}
	if version != schemaVersion {
		return fmt.Errorf("unsupported OAuth schema version %d", version)
	}
	return nil
}

// EnsureSigningKey is retry-safe: it returns the existing active key without
// rotating it. Rotation itself is transactionally audited. Caller supplies an
// authorized operator channel and stores returned key IDs, never key material.
func (a Admin) EnsureSigningKey(ctx context.Context) (string, error) {
	if err := a.configured(); err != nil {
		return "", err
	}
	if err := a.requireReady(ctx); err != nil {
		return "", err
	}
	id, err := a.readActiveKey(ctx)
	if err == nil {
		return id, nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return "", err
	}
	keys := a.SigningKeys
	keys.Store = a.Store
	id, err = keys.Rotate(ctx, false)
	if err == nil {
		return id, nil
	}
	// Concurrent initialization may have won. Only an actually committed key
	// turns a retry into success; a failed transaction leaves no active key.
	if existing, readErr := a.readActiveKey(ctx); readErr == nil {
		return existing, nil
	}
	return "", err
}

// RotateSigningKey is explicit and leaves retired public keys available. It
// must only be invoked by an authenticated operator.
func (a Admin) RotateSigningKey(ctx context.Context) (string, error) {
	if err := a.configured(); err != nil {
		return "", err
	}
	if err := a.requireReady(ctx); err != nil {
		return "", err
	}
	keys := a.SigningKeys
	keys.Store = a.Store
	return keys.Rotate(ctx, true)
}

// readActiveKey serializes reads with key-write transactions so callers never
// observe an uncommitted key in a shared single-connection adapter.
func (a Admin) readActiveKey(ctx context.Context) (string, error) {
	var id string
	err := a.Store.Transaction(func() error { var err error; id, err = a.activeKey(ctx); return err })
	return id, err
}

func (a Admin) activeKey(ctx context.Context) (string, error) {
	var id string
	err := a.Store.DB.QueryRowContext(ctx, `SELECT key_id FROM mapi_oauth_signing_keys WHERE project_id=? AND active=1`, a.ProjectID).Scan(&id)
	return id, err
}
