package main

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"slices"
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
		result["wideReturning"] = true
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
	if err := checkWideReturning(ctx, db); err != nil {
		return fmt.Errorf("wide RETURNING: %w", err)
	}
	if err := checkFramedValues(ctx, db); err != nil {
		return fmt.Errorf("framed SQL values: %w", err)
	}
	if err := checkFrameTransferFailure(ctx, db); err != nil {
		return fmt.Errorf("frame transfer failure: %w", err)
	}
	if err := checkBoundedContract(ctx, db); err != nil {
		return fmt.Errorf("bounded SQL contract: %w", err)
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

// UTF-8 segments and BLOB chunks cross transfer boundaries. The signed
// integers and both non-finite REALs keep their storage classes in Go.
func checkFramedValues(ctx context.Context, db *sql.DB) error {
	text := strings.Repeat("a", 32*1024-4) + "🧑\x00é" + strings.Repeat("𐐷", 20_000)
	if _, err := db.ExecContext(ctx, "CREATE TABLE mapi_bridge_framed_values (value)"); err != nil {
		return err
	}
	if _, err := db.ExecContext(ctx, "INSERT INTO mapi_bridge_framed_values(rowid, value) VALUES (123456789, 0)"); err != nil {
		return err
	}
	var totalBefore int64
	if err := db.QueryRowContext(ctx, "SELECT total_changes()").Scan(&totalBefore); err != nil {
		return err
	}
	var gotText string
	var low, high int64
	var plus, minus float64
	var emptyBlob, null any
	err := db.QueryRowContext(ctx, "SELECT ?, -9223372036854775808, 9223372036854775807, 1e999, -1e999, X'', NULL", text).
		Scan(&gotText, &low, &high, &plus, &minus, &emptyBlob, &null)
	if err != nil {
		return err
	}
	blob, ok := emptyBlob.([]byte)
	if gotText != text || low != math.MinInt64 || high != math.MaxInt64 || !math.IsInf(plus, 1) || !math.IsInf(minus, -1) || !ok || len(blob) != 0 || null != nil {
		return errors.New("framing changed a SELECT value or storage class")
	}

	cancellable, cancel := context.WithCancel(ctx)
	rows, err := db.QueryContext(cancellable, "SELECT value FROM mapi_bridge_framed_values UNION ALL SELECT 1")
	if err != nil {
		cancel()
		return err
	}
	cancel()
	if err := rows.Close(); err != nil {
		return err
	}
	var changes, total, rowid int64
	err = db.QueryRowContext(ctx, "SELECT changes(), total_changes(), last_insert_rowid()").Scan(&changes, &total, &rowid)
	if err != nil {
		return err
	}
	if changes != 1 || total != totalBefore || rowid != 123456789 {
		return fmt.Errorf("read or cancellation changed SQLite counters: changes=%d total=%d rowid=%d", changes, total, rowid)
	}
	return nil
}

func checkFrameTransferFailure(ctx context.Context, db *sql.DB) error {
	for _, statement := range []string{
		"CREATE TABLE mapi_bridge_frame_failure (value BLOB)",
		"CREATE TABLE mapi_bridge_frame_audit (n INTEGER NOT NULL)",
		"INSERT INTO mapi_bridge_frame_audit VALUES (0)",
		`CREATE TRIGGER mapi_bridge_frame_delete AFTER DELETE ON mapi_bridge_frame_failure
		 BEGIN UPDATE mapi_bridge_frame_audit SET n = n + 1; END`,
		"INSERT INTO mapi_bridge_frame_failure VALUES (zeroblob(64000)), (zeroblob(64001))",
	} {
		if _, err := db.ExecContext(ctx, statement); err != nil {
			return err
		}
	}
	const statement = "DELETE FROM mapi_bridge_frame_failure RETURNING value"
	err := cloudflarewasm.Transaction(func() error {
		rows, err := db.QueryContext(ctx, statement)
		if err == nil {
			rows.Close()
			return errors.New("expected a transfer error")
		}
		if !strings.Contains(err.Error(), "injected frame transfer failure") {
			return err
		}
		// A caller can handle a query error and commit other work.
		return nil
	})
	if err != nil {
		return err
	}
	readCounts := func(wantRows, wantAudit int) error {
		var rows, audit int
		if err := db.QueryRowContext(ctx, "SELECT (SELECT count(*) FROM mapi_bridge_frame_failure), n FROM mapi_bridge_frame_audit").Scan(&rows, &audit); err != nil {
			return err
		}
		if rows != wantRows || audit != wantAudit {
			return fmt.Errorf("remaining rows=%d and audit=%d, want %d and %d", rows, audit, wantRows, wantAudit)
		}
		return nil
	}
	if err := readCounts(2, 0); err != nil {
		return err
	}
	rows, err := db.QueryContext(ctx, statement)
	if err != nil {
		return err
	}
	if err := rows.Close(); err != nil {
		return err
	}
	return readCounts(0, 2)
}

func checkBoundedContract(ctx context.Context, db *sql.DB) error {
	for _, statement := range []string{
		"CREATE TABLE mapi_limit_probe (id INTEGER PRIMARY KEY, payload BLOB)",
		"CREATE TABLE mapi_limit_audit (n INTEGER NOT NULL)",
		"INSERT INTO mapi_limit_audit VALUES (0)",
		`CREATE TRIGGER mapi_limit_delete AFTER DELETE ON mapi_limit_probe
		 BEGIN UPDATE mapi_limit_audit SET n=n+1; END`,
		`WITH RECURSIVE ids(id) AS (VALUES(1) UNION ALL SELECT id+1 FROM ids WHERE id<65)
		 INSERT INTO mapi_limit_probe SELECT id, X'' FROM ids`,
		"UPDATE mapi_limit_probe SET payload=zeroblob(4194305) WHERE id=1",
	} {
		if _, err := db.ExecContext(ctx, statement); err != nil {
			return err
		}
	}
	for _, test := range []struct{ statement, message string }{
		{"DELETE FROM mapi_limit_probe RETURNING id", "MaPi SQLite RETURNING row limit exceeded"},
		{"DELETE FROM mapi_limit_probe WHERE id=1 RETURNING payload", "MaPi SQLite result row byte limit exceeded"},
		{"INSERT INTO mapi_limit_probe SELECT 100, X'' UNION ALL VALUES (101,X'') RETURNING id", "requires an admitted INSERT source"},
		{"SELECT zeroblob(4194305) AS oversized", "MaPi SQLite result row byte limit exceeded"},
		{"WITH RECURSIVE seq(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM seq WHERE n<4097) SELECT n FROM seq", "MaPi SQLite result row limit exceeded"},
		{"SELECT zeroblob(3145728) UNION ALL SELECT zeroblob(3145728) UNION ALL SELECT zeroblob(3145728)", "MaPi SQLite result snapshot byte limit exceeded"},
	} {
		rows, err := db.QueryContext(ctx, test.statement)
		if err == nil {
			rows.Close()
			return fmt.Errorf("expected %s for %q", test.message, test.statement)
		}
		if !strings.Contains(err.Error(), test.message) {
			return fmt.Errorf("expected %s for %q: %w", test.message, test.statement, err)
		}
	}
	if _, err := db.ExecContext(ctx, "DELETE FROM mapi_limit_probe RETURNING id"); err == nil || !strings.Contains(err.Error(), "requires query mode") {
		return fmt.Errorf("Exec with RETURNING must be rejected: %v", err)
	}
	var remaining, audit int
	if err := db.QueryRowContext(ctx, "SELECT (SELECT count(*) FROM mapi_limit_probe), n FROM mapi_limit_audit").Scan(&remaining, &audit); err != nil {
		return err
	}
	if remaining != 65 || audit != 0 {
		return fmt.Errorf("rejected statements changed %d rows and %d audit entries", 65-remaining, audit)
	}
	if _, err := db.ExecContext(ctx, "INSERT INTO mapi_limit_probe VALUES (?, X'01')", int64(math.MaxInt64)); err != nil {
		return err
	}
	var identifier int64
	if err := db.QueryRowContext(ctx, "DELETE FROM mapi_limit_probe WHERE id=? RETURNING id", int64(math.MaxInt64)).Scan(&identifier); err != nil || identifier != math.MaxInt64 {
		return fmt.Errorf("bounded rowid mutation: id=%d error=%v", identifier, err)
	}
	for _, statement := range []string{
		`CREATE TRIGGER mapi_limit_ignore BEFORE DELETE ON mapi_limit_probe WHEN OLD.id=2
		 BEGIN SELECT RAISE(IGNORE); END`,
		`CREATE TRIGGER mapi_limit_nested AFTER DELETE ON mapi_limit_probe WHEN OLD.id=3
		 BEGIN DELETE FROM mapi_limit_probe WHERE id=4; END`,
	} {
		if _, err := db.ExecContext(ctx, statement); err != nil {
			return err
		}
	}
	returned, err := db.QueryContext(ctx, "DELETE FROM mapi_limit_probe WHERE id IN (2,3) RETURNING id")
	if err != nil {
		return err
	}
	defer returned.Close()
	if !returned.Next() {
		return fmt.Errorf("expected one directly deleted row: %v", returned.Err())
	}
	if err := returned.Scan(&identifier); err != nil || identifier != 3 || returned.Next() {
		return fmt.Errorf("nested or ignored trigger changed the RETURNING result: id=%d error=%v", identifier, err)
	}
	if err := returned.Err(); err != nil {
		return err
	}
	var changes int
	err = db.QueryRowContext(ctx, "SELECT changes(), (SELECT count(*) FROM mapi_limit_probe), n FROM mapi_limit_audit").
		Scan(&changes, &remaining, &audit)
	if err != nil {
		return err
	}
	if changes != 1 || remaining != 63 || audit != 3 {
		return fmt.Errorf("nested or ignored trigger changed results: changes=%d retained=%d audit=%d", changes, remaining, audit)
	}
	return nil
}

// A dense, reserved-looking BLOB at the supported row byte limit can be
// consumed from the Go result after both rollback and commit.
func checkWideReturning(ctx context.Context, db *sql.DB) error {
	const size = 4 * 1024 * 1024
	expected := bytes.Repeat([]byte{0xaa}, size)
	copy(expected, []byte{255, 0, 0, 0, 0, 0, 0, 0, 0})
	copy(expected[9:], "@MaPiRun1")

	columns := make([]string, 100)
	columns[0] = "value"
	for i := range columns[1:] {
		columns[i+1] = fmt.Sprintf("column_identifier_for_test_%d%s", i, strings.Repeat("_", 128))
	}
	statement := "DELETE FROM mapi_bridge_wide_returning RETURNING " + strings.Join(columns, ",")
	abort := errors.New("rollback wide RETURNING")

	for _, rollback := range []bool{true, false} {
		var rows *sql.Rows
		err := cloudflarewasm.Transaction(func() error {
			var err error
			rows, err = db.QueryContext(ctx, statement)
			if err == nil && rollback {
				return abort
			}
			return err
		})
		var wantErr error
		wantRemaining, wantAudit := 0, 1
		if rollback {
			wantErr = abort
			wantRemaining, wantAudit = 1, 0
		}
		if !errors.Is(err, wantErr) {
			if rows != nil {
				rows.Close()
			}
			return fmt.Errorf("transaction (rollback=%t): got %v, want %v", rollback, err, wantErr)
		}
		if err := checkWideReturningRow(rows, columns, expected); err != nil {
			return err
		}

		var remaining, audit int
		if err := db.QueryRowContext(ctx, "SELECT (SELECT count(*) FROM mapi_bridge_wide_returning), n FROM mapi_bridge_wide_audit").Scan(&remaining, &audit); err != nil {
			return err
		}
		if remaining != wantRemaining || audit != wantAudit {
			return fmt.Errorf("remaining rows=%d and audit rows=%d, want %d and %d", remaining, audit, wantRemaining, wantAudit)
		}
	}
	return nil
}

func checkWideReturningRow(rows *sql.Rows, columns []string, expected []byte) error {
	defer rows.Close()
	got, err := rows.Columns()
	if err != nil {
		return err
	}
	if !slices.Equal(got, columns) {
		return errors.New("column names or order changed")
	}
	if !rows.Next() {
		return fmt.Errorf("expected a returned row, iterator error: %v", rows.Err())
	}
	values := make([]any, len(columns))
	dest := make([]any, len(columns))
	for i := range values {
		dest[i] = &values[i]
	}
	if err := rows.Scan(dest...); err != nil {
		return err
	}
	payload, ok := values[0].([]byte)
	if !ok || !bytes.Equal(payload, expected) {
		return fmt.Errorf("BLOB changed: got %T with %d bytes, want %d exact bytes", values[0], len(payload), len(expected))
	}
	for i, value := range values[1:] {
		if value != nil {
			return fmt.Errorf("column %d: got %T, want NULL", i+1, value)
		}
	}
	if rows.Next() {
		return errors.New("unexpected extra returned row")
	}
	return rows.Err()
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
