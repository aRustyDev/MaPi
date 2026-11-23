//go:build wasip1

package main

import (
	"context"
	"errors"

	"github.com/zitadel/nextgen/internal/cloudflarewasm"
	"github.com/zitadel/nextgen/internal/domain"
	"github.com/zitadel/nextgen/internal/service"
)

// recoveryTokenGuard refuses previously unrevocable credentials in a recovered
// owner. Its durable epoch is installed only by a separately fenced recovery;
// this guard does not schedule recovery or reopen the project.
type recoveryTokenGuard struct{ service.TokenService }

func (guard recoveryTokenGuard) IntrospectToken(ctx context.Context, raw string) (*domain.Token, error) {
	token, err := guard.TokenService.IntrospectToken(ctx, raw)
	if err != nil || token == nil || !token.IsRevocable() || token.TokenID != "" {
		return token, err
	}
	db := cloudflarewasm.Open()
	defer db.Close()
	// Only zero, one, or more than one authority row matters below.  Bound the
	// result before it crosses the SQL bridge, even if either table is corrupt.
	rows, err := db.QueryContext(ctx, "SELECT project_id, epoch FROM mapi_project CROSS JOIN mapi_recovery_epoch LIMIT 2")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	if !rows.Next() {
		return nil, errors.New("recovery token authority missing")
	}
	var projectID, epoch string
	if err := rows.Scan(&projectID, &epoch); err != nil {
		return nil, err
	}
	if rows.Next() {
		return nil, errors.New("ambiguous recovery token authority")
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if projectID != token.ProjectID || epoch == "" {
		return nil, errors.New("recovery token authority mismatch")
	}
	if epoch != "0" {
		return nil, domain.ErrTokenRevoked()
	}
	return token, nil
}
