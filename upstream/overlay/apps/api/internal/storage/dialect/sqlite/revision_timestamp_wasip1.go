//go:build wasip1

package sqlite

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"math"
)

// These durable clocks track ordered mutation timestamps only. They do not
// affect expiry or other wall-clock reads. Allocation and the associated write
// must share the same owner transaction.
const revisionClockSchema = `CREATE TABLE mapi_revision_clock (id INTEGER PRIMARY KEY CHECK (id = 1), stamp INTEGER NOT NULL)`
const revisionScopesSchema = `CREATE TABLE mapi_revision_scopes (scope TEXT PRIMARY KEY, stamp INTEGER NOT NULL)`

// Bootstrap the aggregate from all retained scoped values. Deleted history
// before deployment and a PITR rewind cannot be reconstructed from local
// state; recovery requires independent per-scope anchoring and reconciliation.
var revisionBootstrapQueries = []string{
	"SELECT MAX(created_at) FROM projects", "SELECT MAX(updated_at) FROM projects",
	"SELECT MAX(created_at) FROM project_origins", "SELECT MAX(created_at) FROM teams", "SELECT MAX(updated_at) FROM teams",
	"SELECT MAX(created_at) FROM users", "SELECT MAX(updated_at) FROM users",
	"SELECT MAX(created_at) FROM events", "SELECT MAX(last_created_at) FROM event_sink_cursors",
	"SELECT MAX(created_at) FROM idp_connections", "SELECT MAX(created_at) FROM applications", "SELECT MAX(created_at) FROM policies",
	"SELECT MAX(created_at) FROM idp_connection_revisions", "SELECT MAX(created_at) FROM application_revisions",
	"SELECT MAX(created_at) FROM policy_revisions", "SELECT MAX(created_at) FROM json_schemas",
	"SELECT MAX(created_at) FROM flow_definitions", "SELECT MAX(created_at) FROM user_passwords",
}

func nextRevisionTimestamp(ctx context.Context, tx queryExecutor, kind, query string, args ...any) (int64, error) {
	return nextOrderedTimestamp(ctx, tx, kind, query, 1, args...)
}

func nextPasswordTimestamp(ctx context.Context, tx queryExecutor, projectID, userID string) (int64, error) {
	return nextOrderedTimestamp(ctx, tx, "user-password", "SELECT MAX(created_at) FROM user_passwords WHERE project_id = ? AND user_id = ?", 1000, projectID, userID)
}

func nextOrderedTimestamp(ctx context.Context, tx queryExecutor, kind, query string, increment int64, args ...any) (int64, error) {
	var scoped sql.NullInt64
	if err := tx.QueryRow(ctx, query, args...).Scan(&scoped); err != nil {
		return 0, wrapError(err)
	}
	key, err := json.Marshal(struct {
		Version int    `json:"v"`
		Kind    string `json:"kind"`
		Args    []any  `json:"args"`
	}{1, kind, args})
	if err != nil {
		return 0, err
	}
	var clockSchema, scopesSchema sql.NullString
	if err := tx.QueryRow(ctx, "SELECT MAX(sql) FROM sqlite_schema WHERE type = 'table' AND name = 'mapi_revision_clock'").Scan(&clockSchema); err != nil {
		return 0, wrapError(err)
	}
	if err := tx.QueryRow(ctx, "SELECT MAX(sql) FROM sqlite_schema WHERE type = 'table' AND name = 'mapi_revision_scopes'").Scan(&scopesSchema); err != nil {
		return 0, wrapError(err)
	}
	if clockSchema.Valid != scopesSchema.Valid {
		return 0, errors.New("incomplete revision clock schema")
	}
	var aggregate int64
	if !clockSchema.Valid {
		if _, err := tx.Exec(ctx, revisionClockSchema); err != nil {
			return 0, wrapError(err)
		}
		if _, err := tx.Exec(ctx, revisionScopesSchema); err != nil {
			return 0, wrapError(err)
		}
		for _, bootstrap := range revisionBootstrapQueries {
			var value sql.NullInt64
			if err := tx.QueryRow(ctx, bootstrap).Scan(&value); err != nil {
				return 0, wrapError(err)
			}
			if value.Valid && value.Int64 > aggregate {
				aggregate = value.Int64
			}
		}
	} else {
		if clockSchema.String != revisionClockSchema || scopesSchema.String != revisionScopesSchema {
			return 0, errors.New("unexpected revision clock schema")
		}
		if err := tx.QueryRow(ctx, "SELECT stamp FROM mapi_revision_clock WHERE id = 1").Scan(&aggregate); err != nil {
			return 0, wrapError(err)
		}
	}
	var previous int64
	err = tx.QueryRow(ctx, "SELECT stamp FROM mapi_revision_scopes WHERE scope = ?", string(key)).Scan(&previous)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return 0, wrapError(err)
	}
	now := nowUnixNano()
	if err == nil {
		if previous > math.MaxInt64-increment {
			return 0, errors.New("revision timestamp exhausted")
		}
		if previous+increment > now {
			now = previous + increment
		}
	}
	if scoped.Valid {
		if scoped.Int64 > math.MaxInt64-increment {
			return 0, errors.New("revision timestamp exhausted")
		}
		if scoped.Int64+increment > now {
			now = scoped.Int64 + increment
		}
	}
	if now > aggregate {
		aggregate = now
	}
	if _, err := tx.Exec(ctx, "INSERT INTO mapi_revision_scopes (scope, stamp) VALUES (?, ?) ON CONFLICT(scope) DO UPDATE SET stamp = excluded.stamp", string(key), now); err != nil {
		return 0, wrapError(err)
	}
	if _, err := tx.Exec(ctx, "INSERT INTO mapi_revision_clock (id, stamp) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET stamp = excluded.stamp", aggregate); err != nil {
		return 0, wrapError(err)
	}
	return now, nil
}
