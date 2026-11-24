//go:build !wasip1

package sqlite

import (
	"context"
	"github.com/zitadel/nextgen/internal/domain"
	"github.com/zitadel/nextgen/internal/storage/dialect/authz"
)

// CheckAuthzProjects implements [service.AuthzResolverStatements].
func (s authzResolverStatements) CheckAuthzProjects(ctx context.Context, params domain.AuthzCheckParams, projectIDs []string) ([]domain.AuthzCheckResult, error) {
	results := make([]domain.AuthzCheckResult, len(projectIDs))
	if len(projectIDs) == 0 {
		return results, nil
	}
	var c statementCompiler
	authz.WriteCheckAuthzProjects(&c, sqliteAuthzEnv(), params, projectIDs)
	rows, err := s.client.Query(ctx, c.String(), c.args...)
	if err != nil {
		return nil, wrapError(err)
	}
	defer rows.Close()
	for rows.Next() {
		var arm int
		var result domain.AuthzCheckResult
		if err := rows.Scan(&arm, &result.Allowed, &result.Foothold); err != nil {
			return nil, wrapError(err)
		}
		results[arm] = result
	}
	return results, wrapError(rows.Err())
}
