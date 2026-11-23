//go:build sqlite_integration

package sqlite

import (
	"context"
	"database/sql"
	"errors"
	"reflect"
	"slices"
	"testing"

	"github.com/zitadel/nextgen/internal/storage/events"
)

// A deliberately small native SQLite spool for the diagnostic only. The
// caller owns the transaction, so any partial permutation can be rolled back.
// This is not a production spool, a Workerd test, or a byte/memory limit test.
type nativeSortSpool struct {
	ctx   context.Context
	tx    *sql.Tx
	n     int
	swaps int
}

func (s *nativeSortSpool) Len() int { return s.n }
func (s *nativeSortSpool) Get(i int) (uint64, error) {
	if i < 0 || i >= s.n {
		return 0, errors.New("spool index out of range")
	}
	var v uint64
	err := s.tx.QueryRowContext(s.ctx, "SELECT handle FROM diagnostic_sort_spool WHERE pos = ?", i).Scan(&v)
	return v, err
}
func (s *nativeSortSpool) Swap(i, j int) error {
	if i == j {
		_, err := s.Get(i)
		return err
	}
	a, err := s.Get(i)
	if err != nil {
		return err
	}
	b, err := s.Get(j)
	if err != nil {
		return err
	}
	res, err := s.tx.ExecContext(s.ctx, "UPDATE diagnostic_sort_spool SET handle = CASE pos WHEN ? THEN ? ELSE ? END WHERE pos IN (?, ?)", i, b, a, i, j)
	if err != nil {
		return err
	}
	affected, err := res.RowsAffected()
	if err != nil {
		return err
	}
	if affected != 2 {
		return errors.New("spool swap did not update two positions")
	}
	newA, err := s.Get(i)
	if err != nil {
		return err
	}
	newB, err := s.Get(j)
	if err != nil {
		return err
	}
	if newA != b || newB != a {
		return errors.New("spool swap postcondition failed")
	}
	s.swaps++
	return nil
}

func TestDiagnosticNativeSortSpoolSwapPostcondition(t *testing.T) {
	ctx := t.Context()
	conn, err := testPool.sqlDB.Conn(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	if _, err := conn.ExecContext(ctx, "CREATE TEMP TABLE diagnostic_sort_spool (pos INTEGER PRIMARY KEY, handle INTEGER NOT NULL)"); err != nil {
		t.Fatal(err)
	}
	defer conn.ExecContext(ctx, "DROP TABLE diagnostic_sort_spool")
	if _, err := conn.ExecContext(ctx, "INSERT INTO diagnostic_sort_spool VALUES (0, 10), (1, 20)"); err != nil {
		t.Fatal(err)
	}
	if _, err := conn.ExecContext(ctx, `CREATE TEMP TRIGGER diagnostic_corrupt_swap AFTER UPDATE ON diagnostic_sort_spool WHEN NEW.pos = 1 AND NEW.handle = 10 BEGIN UPDATE diagnostic_sort_spool SET handle = 999 WHERE pos = 1; END`); err != nil {
		t.Fatal(err)
	}
	tx, err := conn.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	s := &nativeSortSpool{ctx: ctx, tx: tx, n: 2}
	err = s.Swap(0, 1)
	if err == nil || err.Error() != "spool swap postcondition failed" {
		tx.Rollback()
		t.Fatalf("expected postcondition failure, got %v", err)
	}
	if err := tx.Rollback(); err != nil {
		t.Fatal(err)
	}
	var a, b int
	if err := conn.QueryRowContext(ctx, "SELECT (SELECT handle FROM diagnostic_sort_spool WHERE pos=0), (SELECT handle FROM diagnostic_sort_spool WHERE pos=1)").Scan(&a, &b); err != nil {
		t.Fatal(err)
	}
	if a != 10 || b != 20 {
		t.Fatalf("corrupt swap survived rollback: %d, %d", a, b)
	}
}

func TestDiagnosticNativeSortSpoolSwapFailures(t *testing.T) {
	ctx := t.Context()
	conn, err := testPool.sqlDB.Conn(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	if _, err := conn.ExecContext(ctx, "CREATE TEMP TABLE diagnostic_sort_spool (pos INTEGER PRIMARY KEY, handle INTEGER NOT NULL)"); err != nil {
		t.Fatal(err)
	}
	defer conn.ExecContext(ctx, "DROP TABLE diagnostic_sort_spool")
	if _, err := conn.ExecContext(ctx, "INSERT INTO diagnostic_sort_spool VALUES (0, 10), (1, 20)"); err != nil {
		t.Fatal(err)
	}
	tx, err := conn.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	s := &nativeSortSpool{ctx: ctx, tx: tx, n: 3}
	if err := s.Swap(0, 0); err != nil {
		t.Fatalf("same existing slot: %v", err)
	}
	if err := s.Swap(2, 2); !errors.Is(err, sql.ErrNoRows) {
		t.Fatalf("same missing slot: %v", err)
	}
	if err := s.Swap(0, 2); !errors.Is(err, sql.ErrNoRows) {
		t.Fatalf("missing second slot: %v", err)
	}
	if err := s.Swap(-1, 0); err == nil {
		t.Fatal("negative slot accepted")
	}
	if err := s.Swap(0, 3); err == nil {
		t.Fatal("out-of-range slot accepted")
	}
	if err := tx.Rollback(); err != nil {
		t.Fatal(err)
	}
	// A trigger can suppress only one row of the multi-row UPDATE. Affected-row
	// validation must detect it, and the caller must roll back the other update.
	if _, err := conn.ExecContext(ctx, `CREATE TEMP TRIGGER diagnostic_skip_swap BEFORE UPDATE ON diagnostic_sort_spool WHEN OLD.pos = 1 BEGIN SELECT RAISE(IGNORE); END`); err != nil {
		t.Fatal(err)
	}
	tx, err = conn.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	s = &nativeSortSpool{ctx: ctx, tx: tx, n: 2}
	if err := s.Swap(0, 1); err == nil {
		tx.Rollback()
		t.Fatal("partial swap accepted")
	}
	if err := tx.Rollback(); err != nil {
		t.Fatal(err)
	}
	var a, b int
	if err := conn.QueryRowContext(ctx, "SELECT (SELECT handle FROM diagnostic_sort_spool WHERE pos=0), (SELECT handle FROM diagnostic_sort_spool WHERE pos=1)").Scan(&a, &b); err != nil {
		t.Fatal(err)
	}
	if a != 10 || b != 20 {
		t.Fatalf("partial swap survived rollback: %d, %d", a, b)
	}
}

func TestDiagnosticExternalSortNativeSQLite(t *testing.T) {
	ctx := t.Context()
	conn, err := testPool.sqlDB.Conn(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	if _, err := conn.ExecContext(ctx, "CREATE TEMP TABLE diagnostic_sort_spool (pos INTEGER PRIMARY KEY, handle INTEGER NOT NULL)"); err != nil {
		t.Fatal(err)
	}
	defer conn.ExecContext(ctx, "DROP TABLE diagnostic_sort_spool")
	const n = 113
	for i := 0; i < n; i++ {
		if _, err := conn.ExecContext(ctx, "INSERT INTO diagnostic_sort_spool (pos, handle) VALUES (?, ?)", i, i); err != nil {
			t.Fatal(err)
		}
	}
	key := func(v uint64) int { return int((v*37 + 11) % 7) }
	cmp := func(a, b uint64) int { return key(a) - key(b) }
	want := make([]uint64, n)
	for i := range want {
		want[i] = uint64(i)
	}
	slices.SortFunc(want, cmp)
	tx, err := conn.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	spool := &nativeSortSpool{ctx: ctx, tx: tx, n: n}
	if err := events.DiagnosticExternalHandleSort(spool, func(a, b uint64) (int, error) { return cmp(a, b), nil }); err != nil {
		tx.Rollback()
		t.Fatal(err)
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
	read := func() []uint64 {
		rows, err := conn.QueryContext(ctx, "SELECT handle FROM diagnostic_sort_spool ORDER BY pos")
		if err != nil {
			t.Fatal(err)
		}
		defer rows.Close()
		var got []uint64
		for rows.Next() {
			var h uint64
			if err := rows.Scan(&h); err != nil {
				t.Fatal(err)
			}
			got = append(got, h)
		}
		if err := rows.Err(); err != nil {
			t.Fatal(err)
		}
		return got
	}
	if got := read(); !reflect.DeepEqual(got, want) {
		t.Fatalf("SQLite spool order differs from slices.SortFunc: got %v want %v", got, want)
	}
	// Force a failure after at least one swap; rolling back must restore the
	// exact prior order rather than retaining a partly sorted spool.
	tx, err = conn.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	spool = &nativeSortSpool{ctx: ctx, tx: tx, n: n}
	sentinel := errors.New("comparison failed")
	comparisons := 0
	err = events.DiagnosticExternalHandleSort(spool, func(a, b uint64) (int, error) {
		comparisons++
		if comparisons == 100 {
			return 0, sentinel
		}
		return -cmp(a, b), nil
	})
	if !errors.Is(err, sentinel) {
		tx.Rollback()
		t.Fatalf("expected comparison failure, got %v after %d comparisons", err, comparisons)
	}
	if spool.swaps == 0 {
		tx.Rollback()
		t.Fatal("injected failure occurred before the first swap")
	}
	if err := tx.Rollback(); err != nil {
		t.Fatal(err)
	}
	if got := read(); !reflect.DeepEqual(got, want) {
		t.Fatalf("rollback did not restore prior spool")
	}
}
