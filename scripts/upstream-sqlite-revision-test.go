//go:build wasip1 && sqlite_integration

package stmttest

import (
	"context"
	"errors"
	"math"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
	"github.com/zitadel/nextgen/internal/cloudflarewasm"
	"github.com/zitadel/nextgen/internal/domain"
	"github.com/zitadel/nextgen/internal/service"
)

func TestMaPiRevisionTimestampRollbackAndOverflow(t *testing.T) {
	d := dialects[0]
	projectID := ensureProject(t, d.stmts)
	entity := createIDPConnection(t, d.stmts, projectID, "mapi-revision", idpConnectionDocument("https://original.test"))
	db := cloudflarewasm.Open()
	defer db.Close()
	initial := entity.UpdatedAt.UnixNano()
	rolledBack := *entity
	sentinel := errors.New("injected rollback")
	err := d.pool.Transaction(t.Context(), func(ctx context.Context, tx service.Statementer[service.AllStatements]) error {
		rolledBack.Document = idpConnectionDocument("https://rollback.test")
		if err := tx.Statements().ReviseIDPConnection(ctx, &rolledBack); err != nil {
			return err
		}
		return sentinel
	})
	require.ErrorIs(t, err, sentinel)
	require.Greater(t, rolledBack.UpdatedAt.UnixNano(), initial)
	current, err := d.stmts.GetIDPConnection(t.Context(), idpConnectionByID(projectID, entity.ID))
	require.NoError(t, err)
	require.Equal(t, entity.RevisionID, current.RevisionID)
	current.Document = idpConnectionDocument("https://committed.test")
	require.NoError(t, d.stmts.ReviseIDPConnection(t.Context(), current))
	require.GreaterOrEqual(t, current.UpdatedAt.UnixNano(), rolledBack.UpdatedAt.UnixNano())
	committed, err := d.stmts.GetIDPConnection(t.Context(), idpConnectionByID(projectID, entity.ID))
	require.NoError(t, err)
	require.Equal(t, current.RevisionID, committed.RevisionID)
	require.Equal(t, current.UpdatedAt, committed.UpdatedAt)
	_, err = db.Exec("UPDATE idp_connection_revisions SET created_at = ? WHERE project_id = ? AND id = ?", int64(math.MaxInt64), projectID, current.RevisionID)
	require.NoError(t, err)
	next := *committed
	err = d.stmts.ReviseIDPConnection(t.Context(), &next)
	require.ErrorContains(t, err, "revision timestamp exhausted")
	var count int
	require.NoError(t, db.QueryRow("SELECT COUNT(*) FROM idp_connection_revisions WHERE project_id = ? AND connection_id = ?", projectID, entity.ID).Scan(&count))
	require.Equal(t, 2, count)
}

// The local clock retains acknowledged values even when their rows disappear.
// It is not an independent PITR high-water until recorded outside the owner.
func TestMaPiRevisionDeletionPreservesHighWater(t *testing.T) {
	d := dialects[0]
	projectID := ensureProject(t, d.stmts)
	entity := createIDPConnection(t, d.stmts, projectID, "mapi-delete", idpConnectionDocument("https://original.test"))
	revision := *entity
	require.NoError(t, d.stmts.ReviseIDPConnection(t.Context(), &revision))
	db := cloudflarewasm.Open()
	defer db.Close()
	future := time.Now().Add(time.Hour).UnixNano()
	_, err := db.Exec("UPDATE idp_connection_revisions SET created_at = ? WHERE project_id = ? AND id = ?", future, projectID, revision.RevisionID)
	require.NoError(t, err)
	_, err = db.Exec("UPDATE mapi_revision_clock SET stamp = ? WHERE id = 1", future)
	require.NoError(t, err)
	_, err = db.Exec("UPDATE mapi_revision_scopes SET stamp = ? WHERE scope LIKE '%idp-revision%'", future)
	require.NoError(t, err)
	_, err = db.Exec("DELETE FROM idp_connection_revisions WHERE project_id = ? AND id = ?", projectID, revision.RevisionID)
	require.NoError(t, err)
	current, err := d.stmts.GetIDPConnection(t.Context(), idpConnectionByID(projectID, entity.ID))
	require.NoError(t, err)
	require.NoError(t, d.stmts.ReviseIDPConnection(t.Context(), current))
	require.Greater(t, current.UpdatedAt.UnixNano(), future)
}

// Run with a frozen test clock to prove every writer of the scoped columns
// moves forward, and that failed transactions cannot advance them.
func TestMaPiScopedWritersOrderingAndRollback(t *testing.T) {
	d := dialects[0]
	db := cloudflarewasm.Open()
	defer db.Close()
	projectID := ensureProject(t, d.stmts)
	project, err := d.stmts.GetProjectByID(t.Context(), projectID)
	require.NoError(t, err)
	project.Name = "updated project"
	require.NoError(t, d.stmts.UpdateProject(t.Context(), project))
	updated := project.UpdatedAt.UnixNano()
	require.NoError(t, d.stmts.SetProjectPasswordHashPolicy(t.Context(), projectID, nil))
	var policyStamp int64
	require.NoError(t, db.QueryRow("SELECT updated_at FROM projects WHERE id = ?", projectID).Scan(&policyStamp))
	require.Greater(t, policyStamp, updated)
	sentinel := errors.New("injected rollback")
	err = d.pool.Transaction(t.Context(), func(ctx context.Context, tx service.Statementer[service.AllStatements]) error {
		if err := tx.Statements().SetProjectPasswordHashPolicy(ctx, projectID, nil); err != nil {
			return err
		}
		return sentinel
	})
	require.ErrorIs(t, err, sentinel)
	var stamp int64
	require.NoError(t, db.QueryRow("SELECT updated_at FROM projects WHERE id = ?", projectID).Scan(&stamp))
	require.Equal(t, policyStamp, stamp)
	require.NoError(t, d.stmts.SetProjectPasswordHashPolicy(t.Context(), projectID, nil))
	require.NoError(t, db.QueryRow("SELECT updated_at FROM projects WHERE id = ?", projectID).Scan(&stamp))
	require.Greater(t, stamp, policyStamp)
	team := newTestTeam(projectID, uniqueTeamID(t))
	require.NoError(t, d.stmts.CreateTeam(t.Context(), team))
	team.Name = "updated team"
	require.NoError(t, d.stmts.UpdateTeam(t.Context(), team))
	teamUpdated := team.UpdatedAt.UnixNano()
	err = d.pool.Transaction(t.Context(), func(ctx context.Context, tx service.Statementer[service.AllStatements]) error {
		changed, err := tx.Statements().DeactivateTeam(ctx, projectID, team.ID)
		if err != nil {
			return err
		}
		if !changed {
			return errors.New("deactivation was a no-op")
		}
		return sentinel
	})
	require.ErrorIs(t, err, sentinel)
	require.NoError(t, db.QueryRow("SELECT updated_at FROM teams WHERE project_id = ? AND id = ?", projectID, team.ID).Scan(&stamp))
	require.Equal(t, teamUpdated, stamp)
	changed, err := d.stmts.DeactivateTeam(t.Context(), projectID, team.ID)
	require.NoError(t, err)
	require.True(t, changed)
	require.NoError(t, db.QueryRow("SELECT updated_at FROM teams WHERE project_id = ? AND id = ?", projectID, team.ID).Scan(&stamp))
	require.Greater(t, stamp, teamUpdated)
	var beforeNoop int64
	require.NoError(t, db.QueryRow("SELECT stamp FROM mapi_revision_clock WHERE id = 1").Scan(&beforeNoop))
	changed, err = d.stmts.DeactivateTeam(t.Context(), projectID, team.ID)
	require.NoError(t, err)
	require.False(t, changed)
	var unchanged int64
	require.NoError(t, db.QueryRow("SELECT updated_at FROM teams WHERE project_id = ? AND id = ?", projectID, team.ID).Scan(&unchanged))
	require.Equal(t, stamp, unchanged)
	require.NoError(t, db.QueryRow("SELECT stamp FROM mapi_revision_clock WHERE id = 1").Scan(&unchanged))
	require.Equal(t, beforeNoop, unchanged)
	_, err = db.Exec("UPDATE projects SET updated_at = ? WHERE id = ?", int64(math.MaxInt64), projectID)
	require.NoError(t, err)
	err = d.stmts.SetProjectPasswordHashPolicy(t.Context(), projectID, nil)
	require.ErrorContains(t, err, "revision timestamp exhausted")
	require.NoError(t, db.QueryRow("SELECT updated_at FROM projects WHERE id = ?", projectID).Scan(&stamp))
	require.Equal(t, int64(math.MaxInt64), stamp)
}

// Bootstrap is atomic with the first new write and starts above existing
// stamps from other scoped tables, including values ahead of the wall clock.
func TestMaPiRevisionClockBootstrap(t *testing.T) {
	d := dialects[0]
	projectID := ensureProject(t, d.stmts)
	db := cloudflarewasm.Open()
	defer db.Close()
	future := time.Now().Add(time.Hour).UnixNano()
	_, err := db.Exec("UPDATE projects SET updated_at = ? WHERE id = ?", future, projectID)
	require.NoError(t, err)
	_, err = db.Exec("DROP TABLE mapi_revision_clock")
	require.NoError(t, err)
	_, err = db.Exec("DROP TABLE mapi_revision_scopes")
	require.NoError(t, err)
	team := newTestTeam(projectID, uniqueTeamID(t))
	require.NoError(t, d.stmts.CreateTeam(t.Context(), team))
	team.Name = "bootstrap"
	require.NoError(t, d.stmts.UpdateTeam(t.Context(), team))
	require.Less(t, team.UpdatedAt.UnixNano(), future)
	var clock int64
	require.NoError(t, db.QueryRow("SELECT stamp FROM mapi_revision_clock WHERE id = 1").Scan(&clock))
	require.Equal(t, future, clock)
}

func TestMaPiPasswordClockDeletionRollbackOverflow(t *testing.T) {
	d := dialects[0]
	projectID, schemaURL := ensureUserTestProject(t, d.stmts)
	userID := "user_mapi_clock"
	require.NoError(t, d.stmts.CreateUser(t.Context(), newTestUser(t, projectID, schemaURL, userID, "clock@example.test", "Clock")))
	setTestUserPassword(t, d, projectID, userID, "hash-0")
	db := cloudflarewasm.Open()
	defer db.Close()
	var first, clock int64
	require.NoError(t, db.QueryRow("SELECT MAX(created_at) FROM user_passwords WHERE project_id = ? AND user_id = ?", projectID, userID).Scan(&first))
	require.NoError(t, db.QueryRow("SELECT stamp FROM mapi_revision_clock WHERE id = 1").Scan(&clock))
	require.Equal(t, first, clock)
	sentinel := errors.New("password rollback")
	err := d.pool.Transaction(t.Context(), func(ctx context.Context, tx service.Statementer[service.AllStatements]) error {
		if err := tx.Statements().SetUserPassword(ctx, &domain.SetUserPassword{ProjectID: projectID, UserID: userID, EncodedHash: "rolled-back"}); err != nil {
			return err
		}
		return sentinel
	})
	require.ErrorIs(t, err, sentinel)
	require.NoError(t, db.QueryRow("SELECT stamp FROM mapi_revision_clock WHERE id = 1").Scan(&clock))
	require.Equal(t, first, clock)
	_, err = db.Exec("DELETE FROM user_passwords WHERE project_id = ? AND user_id = ?", projectID, userID)
	require.NoError(t, err)
	setTestUserPassword(t, d, projectID, userID, "hash-after-delete")
	var after int64
	require.NoError(t, db.QueryRow("SELECT MAX(created_at) FROM user_passwords WHERE project_id = ? AND user_id = ?", projectID, userID).Scan(&after))
	require.Greater(t, after, first)
	_, err = db.Exec("UPDATE user_passwords SET created_at = ? WHERE project_id = ? AND user_id = ?", int64(math.MaxInt64-500), projectID, userID)
	require.NoError(t, err)
	err = d.stmts.SetUserPassword(t.Context(), &domain.SetUserPassword{ProjectID: projectID, UserID: userID, EncodedHash: "overflow"})
	require.ErrorContains(t, err, "revision timestamp exhausted")
	var count int
	require.NoError(t, db.QueryRow("SELECT COUNT(*) FROM user_passwords WHERE project_id = ? AND user_id = ?", projectID, userID).Scan(&count))
	require.Equal(t, 1, count)
	require.NoError(t, db.QueryRow("SELECT stamp FROM mapi_revision_clock WHERE id = 1").Scan(&clock))
	require.Equal(t, after, clock)
}

func TestMaPiRevisionClockIncompleteFailsClosed(t *testing.T) {
	d := dialects[0]
	projectID := ensureProject(t, d.stmts)
	project, err := d.stmts.GetProjectByID(t.Context(), projectID)
	require.NoError(t, err)
	db := cloudflarewasm.Open()
	defer db.Close()
	_, err = db.Exec("DROP TABLE mapi_revision_scopes")
	require.NoError(t, err)
	original := project.Name
	project.Name = "should not commit"
	err = d.stmts.UpdateProject(t.Context(), project)
	require.ErrorContains(t, err, "incomplete revision clock schema")
	var name string
	require.NoError(t, db.QueryRow("SELECT name FROM projects WHERE id = ?", projectID).Scan(&name))
	require.Equal(t, original, name)
	_, err = db.Exec("CREATE TABLE mapi_revision_scopes (scope TEXT, stamp INTEGER)")
	require.NoError(t, err)
	err = d.stmts.UpdateProject(t.Context(), project)
	require.ErrorContains(t, err, "unexpected revision clock schema")
	require.NoError(t, db.QueryRow("SELECT name FROM projects WHERE id = ?", projectID).Scan(&name))
	require.Equal(t, original, name)
}

func TestMaPiEventCursorDeletionAndRollback(t *testing.T) {
	d := dialects[0]
	projectID := ensureProject(t, d.stmts)
	sink := &domain.EventSink{Type: domain.EventSinkTypeWebhook, Scope: domain.EventSinkScopeDeployment, URL: "https://example.invalid/mapi-event-clock", Enabled: true}
	require.NoError(t, d.stmts.EnsureEventSink(t.Context(), sink))
	first := sampleEvent(projectID, "evt_mapi_clock_first")
	require.NoError(t, d.stmts.InsertEvent(t.Context(), first))
	require.NoError(t, d.stmts.UpsertEventSinkCursor(t.Context(), &domain.EventSinkCursor{SinkID: sink.ID, ProjectID: projectID, LastCreatedAt: first.CreatedAt, LastEventID: first.ID}))
	_, err := d.stmts.DeleteEventsOlderThan(t.Context(), first.CreatedAt.Add(time.Nanosecond))
	require.NoError(t, err)
	next := sampleEvent(projectID, "evt_mapi_clock_second")
	require.NoError(t, d.stmts.InsertEvent(t.Context(), next))
	require.True(t, next.CreatedAt.After(first.CreatedAt))
	events, err := d.stmts.ListEventsAfterCursor(t.Context(), projectID, first.CreatedAt, first.ID, 10)
	require.NoError(t, err)
	require.Len(t, events, 1)
	require.Equal(t, next.ID, events[0].ID)
	sentinel := errors.New("event rollback")
	err = d.pool.Transaction(t.Context(), func(ctx context.Context, tx service.Statementer[service.AllStatements]) error {
		if err := tx.Statements().InsertEvent(ctx, sampleEvent(projectID, "evt_mapi_clock_rolled_back")); err != nil {
			return err
		}
		return sentinel
	})
	require.ErrorIs(t, err, sentinel)
	retry := sampleEvent(projectID, "evt_mapi_clock_retry")
	require.NoError(t, d.stmts.InsertEvent(t.Context(), retry))
	require.True(t, retry.CreatedAt.After(next.CreatedAt))
	db := cloudflarewasm.Open()
	defer db.Close()
	_, err = db.Exec("UPDATE mapi_revision_scopes SET stamp = ? WHERE scope LIKE '%event%'", int64(math.MaxInt64))
	require.NoError(t, err)
	err = d.stmts.InsertEvent(t.Context(), sampleEvent(projectID, "evt_mapi_clock_overflow"))
	require.ErrorContains(t, err, "revision timestamp exhausted")
	events, err = d.stmts.ListEventsAfterCursor(t.Context(), projectID, first.CreatedAt, first.ID, 10)
	require.NoError(t, err)
	require.Len(t, events, 2)
	// A pre-clock owner can have retained only a sink cursor, with all prior
	// events deleted. Bootstrap must not insert behind that cursor.
	require.NoError(t, d.stmts.UpsertEventSinkCursor(t.Context(), &domain.EventSinkCursor{SinkID: sink.ID, ProjectID: projectID, LastCreatedAt: retry.CreatedAt, LastEventID: retry.ID}))
	_, err = d.stmts.DeleteEventsOlderThan(t.Context(), retry.CreatedAt.Add(time.Nanosecond))
	require.NoError(t, err)
	_, err = db.Exec("DROP TABLE mapi_revision_clock")
	require.NoError(t, err)
	_, err = db.Exec("DROP TABLE mapi_revision_scopes")
	require.NoError(t, err)
	afterBootstrap := sampleEvent(projectID, "evt_mapi_clock_bootstrap")
	require.NoError(t, d.stmts.InsertEvent(t.Context(), afterBootstrap))
	require.True(t, afterBootstrap.CreatedAt.After(retry.CreatedAt))
	events, err = d.stmts.ListEventsAfterCursor(t.Context(), projectID, retry.CreatedAt, retry.ID, 10)
	require.NoError(t, err)
	require.Len(t, events, 1)
	require.Equal(t, afterBootstrap.ID, events[0].ID)
}

func TestMaPiUserStaleGuardAndDeactivation(t *testing.T) {
	d := dialects[0]
	projectID, schemaURL := ensureUserTestProject(t, d.stmts)
	user := newTestUser(t, projectID, schemaURL, "user_mapi_guard", "guard@example.test", "Before")
	require.NoError(t, d.stmts.CreateUser(t.Context(), user))
	before := getUserByID(t, d.stmts, projectID, user.ID)
	name, err := domain.NewCreateAttribute("name", "First", domain.AttributeUniquenessUnspecified)
	require.NoError(t, err)
	patch := patchStateOf(t, d.stmts, before, *name)
	require.NoError(t, d.stmts.PatchUser(t.Context(), patch))
	first := getUserByID(t, d.stmts, projectID, user.ID)
	require.True(t, first.Metadata.UpdatedAt.After(before.Metadata.UpdatedAt))
	db := cloudflarewasm.Open()
	defer db.Close()
	var clockBefore, clockAfter int64
	require.NoError(t, db.QueryRow("SELECT stamp FROM mapi_revision_clock WHERE id = 1").Scan(&clockBefore))
	err = d.stmts.PatchUser(t.Context(), patch)
	require.Error(t, err)
	require.NoError(t, db.QueryRow("SELECT stamp FROM mapi_revision_clock WHERE id = 1").Scan(&clockAfter))
	require.Equal(t, clockBefore, clockAfter)
	require.NoError(t, d.stmts.DeactivateUser(t.Context(), projectID, user.ID))
	var deactivated int64
	require.NoError(t, db.QueryRow("SELECT updated_at FROM users WHERE project_id = ? AND id = ?", projectID, user.ID).Scan(&deactivated))
	require.Greater(t, deactivated, first.Metadata.UpdatedAt.UnixNano())
	stale := patchStateOf(t, d.stmts, first, *name)
	require.Error(t, d.stmts.PatchUser(t.Context(), stale))

	team := newTestTeam(projectID, uniqueTeamID(t))
	require.NoError(t, d.stmts.CreateTeam(t.Context(), team))
	for i, email := range []string{"owned-one@example.test", "owned-two@example.test"} {
		id := []string{"user_mapi_owned_one", "user_mapi_owned_two"}[i]
		u := newTestUser(t, projectID, schemaURL, id, email, "Owned")
		u.LifecycleOwnerTeamID = &team.ID
		require.NoError(t, d.stmts.CreateUser(t.Context(), u))
	}
	snapshots := []*domain.User{getUserByID(t, d.stmts, projectID, "user_mapi_owned_one"), getUserByID(t, d.stmts, projectID, "user_mapi_owned_two")}
	changed, err := d.stmts.DeactivateTeam(t.Context(), projectID, team.ID)
	require.NoError(t, err)
	require.True(t, changed)
	for _, snapshot := range snapshots {
		require.NoError(t, db.QueryRow("SELECT updated_at FROM users WHERE project_id = ? AND id = ?", projectID, snapshot.ID).Scan(&deactivated))
		require.Greater(t, deactivated, snapshot.Metadata.UpdatedAt.UnixNano())
		require.Error(t, d.stmts.PatchUser(t.Context(), patchStateOf(t, d.stmts, snapshot, *name)))
	}
}
