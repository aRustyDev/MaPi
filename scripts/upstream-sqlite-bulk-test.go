//go:build wasip1 && sqlite_integration

package stmttest

import (
	"fmt"
	"github.com/stretchr/testify/require"
	"github.com/zitadel/nextgen/internal/cloudflarewasm"
	"github.com/zitadel/nextgen/internal/domain"
	"testing"
	"time"
)

const bulkProject = "project_mapi_bulk"
const bulkTeam = "team_mapi_bulk"
const bulkSchema = "https://example.test/mapi-bulk"
const bulkUsers = 1000

func TestMaPiBulkSeed(t *testing.T) {
	d := dialects[0]
	require.NoError(t, d.stmts.CreateProject(t.Context(), newTestProject(bulkProject)))
	require.NoError(t, d.stmts.CreateJSONSchema(t.Context(), &domain.JSONSchema{ProjectID: bulkProject, URL: bulkSchema, Schema: []byte(`{"type":"object"}`)}))
	require.NoError(t, d.stmts.CreateTeam(t.Context(), newTestTeam(bulkProject, bulkTeam)))
	db := cloudflarewasm.Open()
	defer db.Close()
	now := time.Now().UnixNano()
	for i := 0; i < bulkUsers; i++ {
		_, err := db.Exec("INSERT INTO users (project_id, schema_url, id, lifecycle_owner_team_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)", bulkProject, bulkSchema, fmt.Sprintf("user_mapi_bulk_%05d", i), bulkTeam, domain.UserStatusActive.String(), now, now)
		require.NoError(t, err)
	}
}
func TestMaPiBulkDeactivate(t *testing.T) {
	d := dialects[0]
	changed, err := d.stmts.DeactivateTeam(t.Context(), bulkProject, bulkTeam)
	require.NoError(t, err)
	require.True(t, changed)
	db := cloudflarewasm.Open()
	defer db.Close()
	var users, advanced, scopes int
	require.NoError(t, db.QueryRow("SELECT COUNT(*), SUM(CASE WHEN updated_at > created_at THEN 1 ELSE 0 END) FROM users WHERE project_id = ? AND lifecycle_owner_team_id = ? AND status = ?", bulkProject, bulkTeam, domain.UserStatusDeactivated.String()).Scan(&users, &advanced))
	require.Equal(t, bulkUsers, users)
	require.Equal(t, bulkUsers, advanced)
	require.NoError(t, db.QueryRow("SELECT COUNT(*) FROM mapi_revision_scopes WHERE scope LIKE '%user-update%'").Scan(&scopes))
	require.Equal(t, bulkUsers, scopes)
}
