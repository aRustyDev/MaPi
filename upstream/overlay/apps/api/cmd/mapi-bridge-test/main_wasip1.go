package main

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"strings"
	"unsafe"

	"github.com/zitadel/nextgen/internal/cloudflarewasm"
	"github.com/zitadel/nextgen/internal/domain"
	"github.com/zitadel/nextgen/internal/service"
	"github.com/zitadel/nextgen/internal/storage/database"
	"github.com/zitadel/nextgen/internal/storage/dialect/sqlite"
)

var output []byte

//go:wasmexport run_bridge_tests
func run() uint64 {
	result := map[string]any{"ok": true}
	if err := check(); err != nil {
		result = map[string]any{"ok": false, "error": err.Error()}
	} else {
		result["upstreamCases"] = []string{
			"TestProjectStatements_Create/explicit-id-and-duplicate",
			"TestProjectStatements_Update/name",
			"TestProjectCRUD/create-get-update-delete",
			"TestUserStatements_Create_EmptyIDAssigned/create-get",
		}
	}
	output, _ = json.Marshal(result)
	return uint64(uint32(uintptr(unsafe.Pointer(unsafe.SliceData(output)))))<<32 | uint64(len(output))
}

func check() error {
	ctx := context.Background()
	db := cloudflarewasm.Open()
	defer db.Close()
	if _, err := db.ExecContext(ctx, "CREATE TABLE IF NOT EXISTS bridge_checks (value INTEGER NOT NULL)"); err != nil {
		return err
	}
	// Exercise marker-name handling through the same Go database/sql bridge
	// used by the owner, including SQLite identifiers that contain Unicode.
	if _, err := db.ExecContext(ctx, "CREATE TABLE αmapi_relocation_text_preflight_marker (value TEXT)"); err != nil {
		return fmt.Errorf("unicode identifier rejected: %w", err)
	}
	if _, err := db.ExecContext(ctx, "INSERT INTO αmapi_relocation_text_preflight_marker VALUES ('mapi_relocation_text_preflight_marker')"); err != nil {
		return fmt.Errorf("unicode identifier or literal rejected: %w", err)
	}
	var markerLiteral string
	if err := db.QueryRowContext(ctx, "SELECT value AS mapi_relocation_text_preflight_marker FROM αmapi_relocation_text_preflight_marker").Scan(&markerLiteral); err != nil || markerLiteral != "mapi_relocation_text_preflight_marker" {
		return fmt.Errorf("unicode identifier or alias read failed: %v", err)
	}
	if _, err := db.ExecContext(ctx, "CREATE VIEW 'mapi_relocation_text_preflight_marker' AS SELECT 1"); err == nil {
		return errors.New("reserved marker identifier was accepted")
	}
	if _, err := db.ExecContext(ctx, "DELETE FROM bridge_checks"); err != nil {
		return err
	}
	if _, err := db.ExecContext(ctx, "CREATE TABLE IF NOT EXISTS bridge_affected (a TEXT, b TEXT, PRIMARY KEY (a, b))"); err != nil {
		return err
	}
	if _, err := db.ExecContext(ctx, "DELETE FROM bridge_affected"); err != nil {
		return err
	}
	for _, step := range []struct {
		statement string
		want      int64
	}{
		{"INSERT INTO bridge_affected VALUES ('a', 'b')", 1},
		{"UPDATE bridge_affected SET b = 'c' WHERE a = 'a'", 1},
		{"UPDATE bridge_affected SET b = 'd' WHERE a = 'missing'", 0},
		{"DELETE FROM bridge_affected WHERE a = 'a'", 1},
	} {
		result, err := db.ExecContext(ctx, step.statement)
		if err != nil {
			return err
		}
		got, err := result.RowsAffected()
		if err != nil || got != step.want {
			return fmt.Errorf("affected rows for %q: got %d, want %d: %v", step.statement, got, step.want, err)
		}
	}

	abort := errors.New("nested rollback")
	err := cloudflarewasm.Transaction(func() error {
		if _, err := db.ExecContext(ctx, "INSERT INTO bridge_checks VALUES (?)", int64(11)); err != nil {
			return err
		}
		return cloudflarewasm.Transaction(func() error {
			if _, err := db.ExecContext(ctx, "INSERT INTO bridge_checks VALUES (?)", int64(12)); err != nil {
				return err
			}
			return abort
		})
	})
	if !errors.Is(err, abort) {
		return fmt.Errorf("nested error did not propagate: %v", err)
	}
	var count int64
	if err := db.QueryRowContext(ctx, "SELECT COUNT(*) FROM bridge_checks").Scan(&count); err != nil {
		return err
	}
	if count != 0 {
		return fmt.Errorf("nested rollback left %d rows", count)
	}

	err = cloudflarewasm.Transaction(func() error {
		if _, err := db.ExecContext(ctx, "INSERT INTO bridge_checks VALUES (?)", int64(21)); err != nil {
			return err
		}
		inner := cloudflarewasm.Transaction(func() error {
			if _, err := db.ExecContext(ctx, "INSERT INTO bridge_checks VALUES (?)", int64(22)); err != nil {
				return err
			}
			return abort
		})
		if !errors.Is(inner, abort) {
			return fmt.Errorf("missing nested error: %v", inner)
		}
		return nil
	})
	if err != nil {
		return fmt.Errorf("outer commit: %w", err)
	}
	if err := db.QueryRowContext(ctx, "SELECT COUNT(*) FROM bridge_checks").Scan(&count); err != nil {
		return err
	}
	if count != 2 {
		return fmt.Errorf("nested callback unexpectedly rolled back independently: %d rows", count)
	}

	err = cloudflarewasm.Transaction(func() error {
		if err := cloudflarewasm.Transaction(func() error {
			_, err := db.ExecContext(ctx, "INSERT INTO bridge_checks VALUES (?)", int64(25))
			return err
		}); err != nil {
			return err
		}
		return abort
	})
	if !errors.Is(err, abort) {
		return fmt.Errorf("outer rollback did not propagate: %v", err)
	}
	if err := db.QueryRowContext(ctx, "SELECT COUNT(*) FROM bridge_checks").Scan(&count); err != nil {
		return err
	}
	if count != 2 {
		return fmt.Errorf("outer rollback left %d rows", count)
	}

	err = cloudflarewasm.Transaction(func() error {
		if _, err := db.ExecContext(ctx, "INSERT INTO bridge_checks VALUES (?)", int64(31)); err != nil {
			return err
		}
		return cloudflarewasm.Transaction(func() error { panic("injected panic") })
	})
	if err == nil || !strings.Contains(err.Error(), "injected panic") {
		return fmt.Errorf("panic was not reported: %v", err)
	}
	if err := db.QueryRowContext(ctx, "SELECT COUNT(*) FROM bridge_checks").Scan(&count); err != nil {
		return err
	}
	if count != 2 {
		return fmt.Errorf("panic rollback left %d rows", count)
	}

	err = cloudflarewasm.Transaction(func() error {
		if _, err := db.ExecContext(ctx, "INSERT INTO bridge_affected VALUES ('retry', 'first')"); err != nil {
			return err
		}
		_, err := db.ExecContext(ctx, "INSERT INTO bridge_affected VALUES ('retry', 'first')")
		return err
	})
	if err == nil {
		return errors.New("constraint failure did not roll back the transaction")
	}
	if err := db.QueryRowContext(ctx, "SELECT COUNT(*) FROM bridge_affected WHERE a = 'retry'").Scan(&count); err != nil {
		return err
	}
	if count != 0 {
		return errors.New("failed transaction left a partial write")
	}
	if err := cloudflarewasm.Transaction(func() error {
		_, err := db.ExecContext(ctx, "INSERT INTO bridge_affected VALUES ('retry', 'first')")
		return err
	}); err != nil {
		return fmt.Errorf("retry after rollback: %w", err)
	}

	for _, want := range []int64{math.MinInt64, -9007199254740993, 9007199254740993, math.MaxInt64} {
		var got int64
		if err := db.QueryRowContext(ctx, "SELECT ?", want).Scan(&got); err != nil {
			return err
		}
		if got != want {
			return fmt.Errorf("integer changed: want %d got %d", want, got)
		}
	}
	if err := checkStoredValues(ctx, db); err != nil {
		return err
	}
	if err := checkProjectStatements(ctx); err != nil {
		return err
	}
	parameters := strings.TrimSuffix(strings.Repeat("?,", 100), ",")
	args := make([]any, 100)
	for index := range args {
		args[index] = int64(21)
	}
	var sum int64
	if err := db.QueryRowContext(ctx, "SELECT COUNT(*) FROM bridge_checks WHERE value IN ("+parameters+")", args...).Scan(&sum); err != nil {
		return fmt.Errorf("100 parameter query failed: %w", err)
	}
	if sum != 1 {
		return fmt.Errorf("100 parameter query returned %d", sum)
	}
	args = append(args, int64(21))
	if err := db.QueryRowContext(ctx, "SELECT COUNT(*) FROM bridge_checks WHERE value IN ("+parameters+",?)", args...).Scan(&sum); err == nil {
		return errors.New("101 parameter query unexpectedly succeeded")
	}
	return nil
}

// These assertions mirror the pinned stmttest project cases and the SQLite
// dialect CRUD case, using the actual Cloudflare pool and statement methods.
func checkProjectStatements(ctx context.Context) error {
	statements := sqlite.NewCloudflarePool().Statements()
	project := &domain.Project{ID: "proj_bridge_test", Name: "Bridge test", Origins: []domain.Origin{}}
	if err := statements.CreateProject(ctx, project); err != nil {
		return fmt.Errorf("create project: %w", err)
	}
	if project.CreatedAt.IsZero() || project.UpdatedAt.IsZero() {
		return errors.New("project timestamps missing")
	}
	stored, err := statements.GetProjectByID(ctx, project.ID)
	if err != nil || stored.ID != project.ID || stored.Name != project.Name {
		return fmt.Errorf("read project: %v", err)
	}
	duplicate := &domain.Project{ID: project.ID, Name: "duplicate", Origins: []domain.Origin{}}
	if err := statements.CreateProject(ctx, duplicate); !errors.Is(err, new(database.UniqueError)) {
		return fmt.Errorf("duplicate project error: %v", err)
	}
	project.Name = "Bridge updated"
	if err := statements.UpdateProject(ctx, project); err != nil {
		return fmt.Errorf("update project: %w", err)
	}
	stored, err = statements.GetProjectByID(ctx, project.ID)
	if err != nil || stored.Name != project.Name {
		return fmt.Errorf("read updated project: %v", err)
	}
	schemaURL := "https://example.com/schemas/bridge-user"
	if err := statements.CreateJSONSchema(ctx, &domain.JSONSchema{ProjectID: project.ID, URL: schemaURL, Schema: []byte(`{"type":"object"}`)}); err != nil {
		return fmt.Errorf("create user schema: %w", err)
	}
	email, err := domain.NewCreateAttribute("email", "bridge@example.com", domain.AttributeUniquenessProject)
	if err != nil {
		return err
	}
	user := &domain.CreateUser{ProjectID: project.ID, SchemaURL: schemaURL, Attributes: []domain.CreateAttribute{*email}}
	if err := statements.CreateUser(ctx, user); err != nil {
		return fmt.Errorf("create user: %w", err)
	}
	if !strings.HasPrefix(user.ID, "user_") {
		return fmt.Errorf("unexpected generated user ID %q", user.ID)
	}
	gotUser, err := statements.GetUser(ctx, database.And(
		database.Equal(database.Col(domain.UserFieldProjectID), project.ID),
		database.Equal(database.Col(domain.UserFieldID), user.ID),
	), service.UserQueryOptions{})
	if err != nil || gotUser.ID != user.ID {
		return fmt.Errorf("read created user: %v", err)
	}
	if _, err := statements.DeleteProjectByID(ctx, project.ID); err != nil {
		return fmt.Errorf("delete project: %w", err)
	}
	if _, err := statements.GetProjectByID(ctx, project.ID); err == nil {
		return errors.New("deleted project was readable")
	}
	return nil
}

func checkStoredValues(ctx context.Context, db *sql.DB) error {
	if _, err := db.ExecContext(ctx, "CREATE TABLE IF NOT EXISTS bridge_types (id INTEGER PRIMARY KEY, value, payload BLOB)"); err != nil {
		return err
	}
	if _, err := db.ExecContext(ctx, "DELETE FROM bridge_types"); err != nil {
		return err
	}
	values := []int64{math.MinInt64, -9007199254740993, 9007199254740992, 9007199254740993, 1700000000000000001, math.MaxInt64}
	for index, want := range values {
		var returned int64
		err := db.QueryRowContext(ctx, "INSERT INTO bridge_types (id, value, payload) VALUES (?, ?, ?) RETURNING value", int64(index+1), want, []byte{0, 1, 255}).Scan(&returned)
		if err != nil || returned != want {
			return fmt.Errorf("int64 insert returning: want %d got %d: %v", want, returned, err)
		}
	}
	rows, err := db.QueryContext(ctx, "SELECT value, payload FROM bridge_types WHERE value > ? ORDER BY value", values[0])
	if err != nil {
		return err
	}
	defer rows.Close()
	for _, want := range values[1:] {
		if !rows.Next() {
			return fmt.Errorf("missing sorted row for %d: %v", want, rows.Err())
		}
		var got int64
		var payload []byte
		if err := rows.Scan(&got, &payload); err != nil {
			return err
		}
		if got != want || !bytes.Equal(payload, []byte{0, 1, 255}) {
			return fmt.Errorf("stored value or blob changed: want %d got %d", want, got)
		}
	}
	if rows.Next() || rows.Err() != nil {
		return fmt.Errorf("unexpected sorted row or error: %v", rows.Err())
	}
	if _, err := db.ExecContext(ctx, "INSERT INTO bridge_types (id, value) VALUES (10, NULL), (11, 1.5), (12, '9007199254740993')"); err != nil {
		return err
	}
	var null any
	var real float64
	var text string
	if err := db.QueryRowContext(ctx, "SELECT (SELECT value FROM bridge_types WHERE id=10), (SELECT value FROM bridge_types WHERE id=11), (SELECT value FROM bridge_types WHERE id=12)").Scan(&null, &real, &text); err != nil {
		return err
	}
	if null != nil || real != 1.5 || text != "9007199254740993" {
		return fmt.Errorf("SQLite types changed: %#v %#v %#v", null, real, text)
	}
	var first, second, repeated int64
	if err := db.QueryRowContext(ctx, "SELECT ?2, ?1, ?2", int64(math.MinInt64), int64(math.MaxInt64)).Scan(&first, &second, &repeated); err != nil {
		return err
	}
	if first != math.MaxInt64 || second != math.MinInt64 || repeated != first {
		return fmt.Errorf("numbered parameters changed: %d %d %d", first, second, repeated)
	}
	duplicates, err := db.QueryContext(ctx, "SELECT 1 AS value, 2 AS value")
	if err != nil {
		return err
	}
	columns, err := duplicates.Columns()
	duplicates.Close()
	if err != nil || len(columns) != 2 || columns[0] != "value" || columns[1] != "value" {
		return fmt.Errorf("duplicate column names changed: %v: %v", columns, err)
	}
	var cte int64
	if err := db.QueryRowContext(ctx, "WITH \"update\" AS (SELECT ? AS value) SELECT value FROM \"update\"", int64(math.MaxInt64)).Scan(&cte); err != nil || cte != math.MaxInt64 {
		return fmt.Errorf("read-only CTE failed: %d: %v", cte, err)
	}
	var ignored int64
	err = db.QueryRowContext(ctx, "WITH source AS (SELECT 8 AS id) INSERT INTO bridge_types (id, value) SELECT id, 8 FROM source RETURNING value + 0").Scan(&ignored)
	if err == nil {
		return errors.New("unsupported RETURNING expression unexpectedly succeeded")
	}
	var count int64
	if err := db.QueryRowContext(ctx, "SELECT COUNT(*) FROM bridge_types WHERE id = 8").Scan(&count); err != nil {
		return err
	}
	if count != 0 {
		return errors.New("unsupported RETURNING expression mutated data")
	}
	return nil
}

func main() {}
