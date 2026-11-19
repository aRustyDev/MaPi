package mapioauth

import (
	"context"
	"errors"
	"net/url"
)

// CreateLogoutSchema is called only by the project's versioned migration.
func (s Store) CreateLogoutSchema(ctx context.Context) error {
	if s.DB == nil {
		return errors.New("logout registry not configured")
	}
	_, err := s.DB.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS mapi_oauth_logout_uris (project_id TEXT NOT NULL, client_id TEXT NOT NULL, uri TEXT NOT NULL, PRIMARY KEY(project_id,client_id,uri))`)
	return err
}
func validLogoutURI(uri string) bool {
	if len(uri) == 0 || len(uri) > 2048 {
		return false
	}
	u, err := url.Parse(uri)
	if err != nil || u.Scheme != "https" || u.Host == "" || u.User != nil || u.Fragment != "" {
		return false
	}
	q, err := url.ParseQuery(u.RawQuery)
	return err == nil && !q.Has("state")
}

// RegisterLogoutURI requires an authenticated operator. Client revalidation,
// registration and audit must happen in one project transaction.
func (a Admin) RegisterLogoutURI(ctx context.Context, clientID, uri string) error {
	if err := a.configured(); err != nil {
		return err
	}
	if err := a.requireReady(ctx); err != nil {
		return err
	}
	if !validLogoutURI(uri) || clientID == "" || a.Registry.Statements == nil || a.AuditLogoutURI == nil {
		return errors.New("invalid logout registry configuration")
	}
	return a.Store.Transaction(func() error {
		if _, err := a.Registry.Lookup(ctx, a.ProjectID, clientID); err != nil {
			return err
		}
		result, err := a.Store.DB.ExecContext(ctx, `INSERT OR IGNORE INTO mapi_oauth_logout_uris(project_id,client_id,uri) VALUES(?,?,?)`, a.ProjectID, clientID, uri)
		if err != nil {
			return err
		}
		count, err := result.RowsAffected()
		if err != nil || count == 0 {
			return err
		}
		return a.AuditLogoutURI(ctx, clientID, uri)
	})
}
