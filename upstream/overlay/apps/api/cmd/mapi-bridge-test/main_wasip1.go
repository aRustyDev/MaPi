package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"strings"
	"unsafe"

	"github.com/zitadel/nextgen/internal/cloudflarewasm"
)

var output []byte

//go:wasmexport run_bridge_tests
func run() uint64 {
	result := map[string]any{"ok": true}
	if err := check(); err != nil {
		result = map[string]any{"ok": false, "error": err.Error()}
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

	for _, want := range []int64{math.MinInt64, -9007199254740993, 9007199254740993, math.MaxInt64} {
		var got int64
		if err := db.QueryRowContext(ctx, "SELECT ?", want).Scan(&got); err != nil {
			return err
		}
		if got != want {
			return fmt.Errorf("integer changed: want %d got %d", want, got)
		}
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

func main() {}
