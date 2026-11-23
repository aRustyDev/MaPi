package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"unicode/utf8"
)

const recoveryBatchSize = 64
const recoveryIDBytes = 8192

type recoverySQL interface {
	QueryRowContext(context.Context, string, ...any) *sql.Row
	ExecContext(context.Context, string, ...any) (sql.Result, error)
}

// The query returns one masked ID at a time; it never materializes 64 large IDs.
func recoveryOneID(ctx context.Context, db recoverySQL, query string, args ...any) (string, error) {
	var id sql.NullString
	err := db.QueryRowContext(ctx, query, args...).Scan(&id)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	if err = recoveryValidateID(id); err != nil {
		return "", err
	}
	return id.String, nil
}

func recoveryValidateID(id sql.NullString) error {
	if !id.Valid || id.String == "" || len(id.String) > recoveryIDBytes || !utf8.ValidString(id.String) {
		return errors.New("recovery ID exceeds limit or is invalid")
	}
	encoded, err := json.Marshal(id.String)
	if err != nil || len(encoded) > 64*1024 {
		return errors.New("recovery ID envelope exceeds limit")
	}
	return nil
}

// The caller must roll back the enclosing transaction when this returns an error.
func recoveryDeleteBounded(ctx context.Context, db recoverySQL, query, deleteSQL, project string, owner ...string) (int, error) {
	args := []any{project}
	for _, v := range owner {
		args = append(args, v)
	}
	for count := 0; count < recoveryBatchSize; count++ {
		id, err := recoveryOneID(ctx, db, query, args...)
		if err != nil {
			return 0, err
		}
		if id == "" {
			return count, nil
		}
		result, err := db.ExecContext(ctx, deleteSQL, project, id)
		if err != nil {
			return 0, err
		}
		rows, err := result.RowsAffected()
		if err != nil {
			return 0, err
		}
		if rows != 1 {
			return 0, fmt.Errorf("recovery delete affected %d rows; expected one", rows)
		}
	}
	return recoveryBatchSize, nil
}
