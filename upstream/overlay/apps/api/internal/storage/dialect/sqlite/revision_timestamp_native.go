//go:build !wasip1

package sqlite

import "context"

func nextRevisionTimestamp(_ context.Context, _ queryExecutor, _, _ string, _ ...any) (int64, error) {
	return nowUnixNano(), nil
}

func nextPasswordTimestamp(_ context.Context, _ queryExecutor, _, _ string) (int64, error) {
	return nowUnixNano(), nil
}
