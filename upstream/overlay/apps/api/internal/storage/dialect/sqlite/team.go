package sqlite

import (
	"context"
	"database/sql"

	"github.com/zitadel/nextgen/internal/domain"
	"github.com/zitadel/nextgen/internal/service"
	"github.com/zitadel/nextgen/internal/storage/database"
	"github.com/zitadel/nextgen/internal/storage/dialect/pagination"
)

const (
	createTeamStmt = `INSERT INTO teams (project_id, id, name, created_at, updated_at)
VALUES (?, ?, ?, ?, ?) RETURNING project_id, id, name, status, created_at, updated_at`

	updateTeamStmt = `UPDATE teams SET name = ?, updated_at = ?
WHERE project_id = ? AND id = ? AND status = ?
RETURNING project_id, id, name, status, created_at, updated_at`

	deactivateTeamStmt = `UPDATE teams SET status = ?, updated_at = ? WHERE project_id = ? AND id = ? AND status = ?`

	deactivateTeamMembershipsStmt = `UPDATE team_memberships SET status = ?, updated_at = ?
WHERE project_id = ? AND team_id = ? AND status <> ?`

	deactivateTeamOwnedUsersStmt = `UPDATE users SET status = ?, updated_at = ?
WHERE project_id = ? AND lifecycle_owner_team_id = ? AND status <> ?`

	deactivateOwnedUsersMembershipsStmt = `UPDATE team_memberships SET status = ?, updated_at = ?
WHERE project_id = ? AND status <> ?
  AND user_id IN (SELECT id FROM users WHERE project_id = ? AND lifecycle_owner_team_id = ?)`

	getTeamQuery = `SELECT project_id, id, name, status, created_at, updated_at FROM teams`
)

type teamStatements struct{ statement }

func newTeamStatements(client queryExecutor) teamStatements {
	return teamStatements{statement: statement{client: client}}
}

// CreateTeam implements [service.TeamStatements].
func (ts teamStatements) CreateTeam(ctx context.Context, team *domain.Team) error {
	if err := ensureManagedID(&team.ID, domain.PrefixTeam); err != nil {
		return err
	}
	return withTransaction(ctx, ts.client, func(ctx context.Context, tx queryExecutor) error {
		now, err := nextRevisionTimestamp(ctx, tx, "team-update", "SELECT MAX(updated_at) FROM teams WHERE project_id = ? AND id = ?", team.ProjectID, team.ID)
		if err != nil {
			return err
		}
		row := tx.QueryRow(ctx, createTeamStmt, team.ProjectID, team.ID, team.Name, now, now)
		if err := scanTeamRow(row, team); err != nil {
			return wrapError(err)
		}
		rsi := newResourceScopeStatements(tx)
		if err := rsi.UpsertResourceScope(ctx, domain.NewTeamResourceScope(team.ProjectID, team.ID)); err != nil {
			return err
		}
		return writeSearchEntry(ctx, tx, domain.TeamSearchEntry(team))
	})
}

// GetTeamByID implements [service.TeamStatements].
func (ts teamStatements) GetTeamByID(ctx context.Context, projectID, id string) (*domain.Team, error) {
	return ts.GetTeam(ctx, database.And(
		database.Equal(database.Col(domain.TeamFieldProjectID), projectID),
		database.Equal(database.Col(domain.TeamFieldID), id),
	))
}

// GetTeam implements [service.TeamStatements].
func (ts teamStatements) GetTeam(ctx context.Context, filter database.Filter[domain.TeamField]) (*domain.Team, error) {
	var compiler statementCompiler
	if err := compileRead(&compiler, getTeamQuery, &database.ListOptions[domain.TeamField]{
		Filter: filter,
	}, teamSchema); err != nil {
		return nil, err
	}
	rows, err := ts.client.Query(ctx, compiler.String(), compiler.args...)
	if err != nil {
		return nil, wrapError(err)
	}
	defer rows.Close()
	team, err := collectExactlyOneRow(rows, scanTeam)
	if err != nil {
		return nil, wrapError(err)
	}
	return team, nil
}

// UpdateTeam implements [service.TeamStatements].
// The whole team is returned after the update.
// Only active teams are updated.
// Update of a deactivated or a non-existent team returns [database.NoRowFoundError].
func (ts teamStatements) UpdateTeam(ctx context.Context, team *domain.Team) error {
	return withTransaction(ctx, ts.client, func(ctx context.Context, tx queryExecutor) error {
		now, err := nextRevisionTimestamp(ctx, tx, "team-update", "SELECT MAX(updated_at) FROM teams WHERE project_id = ? AND id = ?", team.ProjectID, team.ID)
		if err != nil {
			return err
		}
		row := tx.QueryRow(
			ctx,
			updateTeamStmt,
			team.Name,
			now,
			team.ProjectID,
			team.ID,
			domain.TeamStatusActive.String(),
		)
		if err := scanTeamRow(row, team); err != nil {
			return wrapError(err)
		}
		return writeSearchEntry(ctx, tx, domain.TeamSearchEntry(team))
	})
}

// ListTeams implements [service.TeamStatements].
func (ts teamStatements) ListTeams(ctx context.Context, filter *database.ListOptions[domain.TeamField]) (*database.ListResult[*domain.Team], error) {
	teams, nextCursor, err := pagination.Page(filter.Pagination, teamSchema, func(limit uint32) ([]*domain.Team, error) {
		filter := filter.WithLimit(limit)
		var compiler statementCompiler
		if err := compileList(ctx, &compiler, getTeamQuery, filter, teamSchema, "teams", "id"); err != nil {
			return nil, err
		}
		rows, err := ts.client.Query(ctx, compiler.String(), compiler.args...)
		if err != nil {
			return nil, wrapError(err)
		}
		defer rows.Close()
		teams, err := collectRows(rows, scanTeam)
		if err != nil {
			return nil, wrapError(err)
		}
		return teams, nil
	})
	if err != nil {
		return nil, err
	}
	return &database.ListResult[*domain.Team]{Items: teams, NextCursor: nextCursor}, nil
}

// DeactivateTeam implements [service.TeamStatements].
// Deactivating a team that is not active is a no-op, so updated_at records when
// the team was deactivated, not when delete was last called.
func (ts teamStatements) DeactivateTeam(ctx context.Context, projectID, id string) (bool, error) {
	membershipRemoved := domain.MembershipStatusRemoved.String()
	userDeactivated := domain.UserStatusDeactivated.String()
	teamDeactivated := domain.TeamStatusDeactivated.String()
	teamActive := domain.TeamStatusActive.String()
	now := nowUnixNano()

	var changed bool
	err := withTransaction(ctx, ts.client, func(ctx context.Context, tx queryExecutor) error {
		var active int
		if err := tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM teams WHERE project_id = ? AND id = ? AND status = ?)", projectID, id, teamActive).Scan(&active); err != nil {
			return wrapError(err)
		}
		if active == 0 {
			return nil
		}
		teamStamp, err := nextRevisionTimestamp(ctx, tx, "team-update", "SELECT MAX(updated_at) FROM teams WHERE project_id = ? AND id = ?", projectID, id)
		if err != nil {
			return err
		}
		result, err := tx.Exec(ctx, deactivateTeamStmt, teamDeactivated, teamStamp, projectID, id, teamActive)
		if err != nil {
			return wrapError(err)
		}
		affected, err := result.RowsAffected()
		if err != nil {
			return wrapError(err)
		}
		// No active team: unknown, or already tombstoned.
		if affected == 0 {
			return nil
		}
		changed = true

		for _, step := range []struct {
			sql  string
			args []any
		}{
			{deactivateTeamMembershipsStmt, []any{membershipRemoved, now, projectID, id, membershipRemoved}},
			{deactivateOwnedUsersMembershipsStmt, []any{membershipRemoved, now, projectID, membershipRemoved, projectID, id}},
		} {
			if _, err := tx.Exec(ctx, step.sql, step.args...); err != nil {
				return wrapError(err)
			}
		}
		// Each owned user has an optimistic updated_at token. Allocate a
		// durable per-user stamp in this same transaction before changing it.
		rows, err := tx.Query(ctx, "SELECT id FROM users WHERE project_id = ? AND lifecycle_owner_team_id = ? AND status <> ? ORDER BY id", projectID, id, userDeactivated)
		if err != nil {
			return wrapError(err)
		}
		var ownedUsers []string
		for rows.Next() {
			var userID string
			if err := rows.Scan(&userID); err != nil {
				rows.Close()
				return wrapError(err)
			}
			ownedUsers = append(ownedUsers, userID)
		}
		if err := rows.Err(); err != nil {
			rows.Close()
			return wrapError(err)
		}
		if err := rows.Close(); err != nil {
			return wrapError(err)
		}
		for _, userID := range ownedUsers {
			userStamp, err := nextRevisionTimestamp(ctx, tx, "user-update", "SELECT MAX(updated_at) FROM users WHERE project_id = ? AND id = ?", projectID, userID)
			if err != nil {
				return err
			}
			if _, err := tx.Exec(ctx, "UPDATE users SET status = ?, updated_at = ? WHERE project_id = ? AND id = ? AND lifecycle_owner_team_id = ? AND status <> ?", userDeactivated, userStamp, projectID, userID, id, userDeactivated); err != nil {
				return wrapError(err)
			}
		}
		edges := newAuthzMembershipEdgeStatements(tx)
		return edges.DeleteAuthzMembershipEdgesForTeamDeactivate(ctx, projectID, id)
	})
	return changed, err
}

func scanTeamRow(row *sql.Row, team *domain.Team) error {
	var (
		statusStr            string
		createdNano, updNano int64
	)
	if err := row.Scan(&team.ProjectID, &team.ID, &team.Name, &statusStr, &createdNano, &updNano); err != nil {
		return err
	}
	team.Status = domain.TeamStatus(statusStr)
	team.CreatedAt = timeFromUnixNano(createdNano)
	team.UpdatedAt = timeFromUnixNano(updNano)
	return nil
}

func scanTeam(rows *sql.Rows) (*domain.Team, error) {
	team := new(domain.Team)
	var (
		statusStr            string
		createdNano, updNano int64
	)
	if err := rows.Scan(&team.ProjectID, &team.ID, &team.Name, &statusStr, &createdNano, &updNano); err != nil {
		return nil, err
	}
	team.Status = domain.TeamStatus(statusStr)
	team.CreatedAt = timeFromUnixNano(createdNano)
	team.UpdatedAt = timeFromUnixNano(updNano)
	return team, nil
}

var _ service.TeamStatements = (*teamStatements)(nil)

var teamSchema = database.NewSchema(map[domain.TeamField]database.FieldBinding[domain.Team]{
	domain.TeamFieldProjectID: {
		SQLName:  "project_id",
		Accessor: func(t *domain.Team) any { return t.ProjectID },
		Coerce:   database.CoerceString,
	},
	domain.TeamFieldID: {
		SQLName:  "id",
		Accessor: func(t *domain.Team) any { return t.ID },
		Coerce:   database.CoerceString,
	},
	domain.TeamFieldName: {
		SQLName:  "name",
		Accessor: func(t *domain.Team) any { return t.Name },
		Coerce:   database.CoerceString,
	},
	domain.TeamFieldStatus: {
		SQLName:  "status",
		Accessor: func(t *domain.Team) any { return string(t.Status) },
		Coerce:   database.CoerceString,
	},
	domain.TeamFieldCreatedAt: {
		SQLName:  "created_at",
		Accessor: func(t *domain.Team) any { return t.CreatedAt },
		Coerce:   database.CoerceTime,
	},
	domain.TeamFieldUpdatedAt: {
		SQLName:  "updated_at",
		Accessor: func(t *domain.Team) any { return t.UpdatedAt },
		Coerce:   database.CoerceTime,
	},
})
