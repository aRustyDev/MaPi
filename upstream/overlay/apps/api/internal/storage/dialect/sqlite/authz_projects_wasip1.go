//go:build wasip1

package sqlite

import (
	"context"

	"github.com/zitadel/nextgen/internal/domain"
)

// Each upstream check can use dozens of binds. A single statement over several
// projects exceeds workerd's 100-parameter limit. Execute the same checks in
// a single owner transaction so they observe one authoritative snapshot.
func (s authzResolverStatements) CheckAuthzProjects(ctx context.Context, params domain.AuthzCheckParams, projectIDs []string) ([]domain.AuthzCheckResult, error) {
	results := make([]domain.AuthzCheckResult, len(projectIDs))
	if len(projectIDs) == 0 {
		return results, nil
	}
	err := withTransaction(ctx, s.client, func(ctx context.Context, executor queryExecutor) error {
		statement := newAuthzResolverStatements(executor)
		for index, projectID := range projectIDs {
			projectParams := params
			projectParams.ProjectID = projectID
			allowed, foothold, err := statement.CheckAuthz(ctx, projectParams)
			if err != nil {
				return err
			}
			results[index] = domain.AuthzCheckResult{Allowed: allowed, Foothold: foothold}
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return results, nil
}
