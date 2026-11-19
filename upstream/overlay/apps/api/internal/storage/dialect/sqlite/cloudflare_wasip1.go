package sqlite

import (
	"context"
	"database/sql"
	"errors"

	"github.com/zitadel/nextgen/internal/cloudflarewasm"
	"github.com/zitadel/nextgen/internal/service"
	"github.com/zitadel/nextgen/internal/storage/database"
)

type CloudflarePool struct {
	client db
}

func NewCloudflarePool() *CloudflarePool {
	return &CloudflarePool{client: db{sqlDB: cloudflarewasm.Open()}}
}

func (p *CloudflarePool) Statements() service.AllStatements {
	return newStatements(p.client)
}

func (p *CloudflarePool) Transaction(ctx context.Context, fn func(context.Context, service.Statementer[service.AllStatements]) error) error {
	return withTransaction(ctx, p.client, func(ctx context.Context, executor queryExecutor) error {
		return fn(ctx, newStatements(executor))
	})
}

func withTransaction(ctx context.Context, executor queryExecutor, fn func(context.Context, queryExecutor) error) error {
	return cloudflarewasm.Transaction(func() error { return fn(ctx, executor) })
}

var errTooManyRows = errors.New("sqlite: multiple rows in result set")

func wrapError(err error) error {
	switch {
	case err == nil:
		return nil
	case errors.Is(err, sql.ErrNoRows):
		return database.NewNoRowFoundError(err)
	case errors.Is(err, errTooManyRows):
		return database.NewMultipleRowsFoundError(err)
	}
	var sqliteErr *cloudflarewasm.SQLError
	if errors.As(err, &sqliteErr) {
		switch sqliteErr.Code() {
		case 2067, 1555:
			return database.NewUniqueError("", "", err)
		case 787:
			return database.NewForeignKeyError("", "", err)
		case 1299:
			return database.NewNotNullError("", "", err)
		case 19, 275:
			return database.NewCheckError("", "", err)
		}
	}
	return database.NewUnknownError(err)
}
