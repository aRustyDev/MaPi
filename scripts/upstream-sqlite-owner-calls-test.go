//go:build wasip1 && sqlite_integration

package stmttest

import (
	"context"
	"errors"
	"github.com/stretchr/testify/require"
	"github.com/zitadel/nextgen/internal/cloudflarewasm"
	"github.com/zitadel/nextgen/internal/domain"
	"github.com/zitadel/nextgen/internal/service"
	"github.com/zitadel/nextgen/internal/storage/database"
	"testing"
	"time"
)

const ownerProject = "project_mapi_owner_calls"
const ownerUser = "user_mapi_owner_calls"
const ownerSchema = "https://example.test/owner-calls"

func TestMaPiOwnerSeed(t *testing.T) {
	d := dialects[0]
	require.NoError(t, d.stmts.CreateProject(t.Context(), newTestProject(ownerProject)))
	require.NoError(t, d.stmts.CreateJSONSchema(t.Context(), &domain.JSONSchema{ProjectID: ownerProject, URL: ownerSchema, Schema: []byte(`{"type":"object"}`)}))
	require.NoError(t, d.stmts.CreateUser(t.Context(), newTestUser(t, ownerProject, ownerSchema, ownerUser, "owner@example.test", "Owner")))
	setTestUserPassword(t, d, ownerProject, ownerUser, "hash-0")
	entity := createIDPConnection(t, d.stmts, ownerProject, "mapi-owner", idpConnectionDocument("https://original.test"))
	db := cloudflarewasm.Open()
	defer db.Close()
	_, err := db.Exec("CREATE TABLE mapi_test_owner_calls (label TEXT PRIMARY KEY, read_revision TEXT NOT NULL, wrote_revision TEXT NOT NULL)")
	require.NoError(t, err)
	_, err = db.Exec("CREATE TABLE mapi_test_owner_meta (id TEXT NOT NULL, initial_revision TEXT NOT NULL)")
	require.NoError(t, err)
	_, err = db.Exec("INSERT INTO mapi_test_owner_meta VALUES (?, ?)", entity.ID, entity.RevisionID)
	require.NoError(t, err)
	_, err = db.Exec("CREATE TABLE mapi_test_user_meta (stamp INTEGER NOT NULL)")
	require.NoError(t, err)
	_, err = db.Exec("INSERT INTO mapi_test_user_meta SELECT updated_at FROM users WHERE project_id = ? AND id = ?", ownerProject, ownerUser)
	require.NoError(t, err)
	_, err = db.Exec("CREATE TABLE mapi_test_user_results (label TEXT PRIMARY KEY, accepted INTEGER NOT NULL)")
	require.NoError(t, err)
}

func ownerUserPatch(t *testing.T, label string) {
	d := dialects[0]
	db := cloudflarewasm.Open()
	defer db.Close()
	var stamp int64
	require.NoError(t, db.QueryRow("SELECT stamp FROM mapi_test_user_meta").Scan(&stamp))
	snapshot := getUserByID(t, d.stmts, ownerProject, ownerUser)
	name, err := domain.NewCreateAttribute("name", label, domain.AttributeUniquenessUnspecified)
	require.NoError(t, err)
	patch := patchStateOf(t, d.stmts, snapshot, *name)
	patch.ExpectedUpdatedAt = time.Unix(0, stamp)
	err = d.stmts.PatchUser(t.Context(), patch)
	accepted := 1
	if err != nil {
		var stale *database.NoRowFoundError
		require.True(t, errors.As(err, &stale), "unexpected error: %v", err)
		accepted = 0
	}
	_, err = db.Exec("INSERT INTO mapi_test_user_results VALUES (?, ?)", label, accepted)
	require.NoError(t, err)
}
func TestMaPiUserOwnerA(t *testing.T) { ownerUserPatch(t, "a") }
func TestMaPiUserOwnerB(t *testing.T) { ownerUserPatch(t, "b") }
func TestMaPiUserOwnerVerify(t *testing.T) {
	d := dialects[0]
	db := cloudflarewasm.Open()
	defer db.Close()
	var accepted int
	require.NoError(t, db.QueryRow("SELECT COALESCE(SUM(accepted),0) FROM mapi_test_user_results").Scan(&accepted))
	require.Equal(t, 1, accepted)
	var winner string
	require.NoError(t, db.QueryRow("SELECT label FROM mapi_test_user_results WHERE accepted = 1").Scan(&winner))
	assertUserAttributes(t, getUserByID(t, d.stmts, ownerProject, ownerUser), map[string]any{"name": winner})
}

func ownerWrite(t *testing.T, label string) {
	d := dialects[0]
	db := cloudflarewasm.Open()
	defer db.Close()
	var id, initial string
	require.NoError(t, db.QueryRow("SELECT id, initial_revision FROM mapi_test_owner_meta").Scan(&id, &initial))
	err := d.pool.Transaction(t.Context(), func(ctx context.Context, tx service.Statementer[service.AllStatements]) error {
		s := tx.Statements()
		if err := s.LockIDPConnection(ctx, ownerProject, id); err != nil {
			return err
		}
		entity, err := s.GetIDPConnection(ctx, idpConnectionByID(ownerProject, id))
		if err != nil {
			return err
		}
		read := entity.RevisionID
		entity.Document = idpConnectionDocument("https://" + label + ".test")
		if err = s.ReviseIDPConnection(ctx, entity); err != nil {
			return err
		}
		if err = s.SetUserPassword(ctx, &domain.SetUserPassword{ProjectID: ownerProject, UserID: ownerUser, EncodedHash: "hash-" + label}); err != nil {
			return err
		}
		_, err = db.Exec("INSERT INTO mapi_test_owner_calls VALUES (?, ?, ?)", label, read, entity.RevisionID)
		return err
	})
	require.NoError(t, err)
}
func TestMaPiOwnerA(t *testing.T) { ownerWrite(t, "a") }
func TestMaPiOwnerB(t *testing.T) { ownerWrite(t, "b") }
func TestMaPiOwnerVerify(t *testing.T) {
	d := dialects[0]
	db := cloudflarewasm.Open()
	defer db.Close()
	var id, initial, readA, wroteA, readB, wroteB string
	require.NoError(t, db.QueryRow("SELECT id, initial_revision FROM mapi_test_owner_meta").Scan(&id, &initial))
	require.NoError(t, db.QueryRow("SELECT read_revision,wrote_revision FROM mapi_test_owner_calls WHERE label='a'").Scan(&readA, &wroteA))
	require.NoError(t, db.QueryRow("SELECT read_revision,wrote_revision FROM mapi_test_owner_calls WHERE label='b'").Scan(&readB, &wroteB))
	var newestRevision, newestHash string
	switch {
	case readA == initial && readB == wroteA:
		newestRevision, newestHash = wroteB, "hash-b"
	case readB == initial && readA == wroteB:
		newestRevision, newestHash = wroteA, "hash-a"
	default:
		t.Fatalf("writes did not serialize: A read %s wrote %s; B read %s wrote %s", readA, wroteA, readB, wroteB)
	}
	current, err := d.stmts.GetIDPConnection(t.Context(), idpConnectionByID(ownerProject, id))
	require.NoError(t, err)
	require.Equal(t, newestRevision, current.RevisionID)
	require.Equal(t, newestHash, currentUserPasswordHash(t, d, ownerProject, ownerUser))
	require.ElementsMatch(t, []string{"hash-0", "hash-a", "hash-b"}, append(userPasswordHistoryHashes(t, d, ownerProject, ownerUser), newestHash))
}
