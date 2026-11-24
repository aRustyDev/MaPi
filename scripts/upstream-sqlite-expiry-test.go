//go:build wasip1 && sqlite_integration

package stmttest

import (
	"fmt"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
	"github.com/zitadel/nextgen/internal/domain"
)

// Run only with MAPI_FREEZE_TEST_CLOCK=1; no timer polls occur in this test.
func TestMaPiAuthAttemptExpiryPrecision(t *testing.T) {
	created := time.Now()
	attempt := domain.AuthAttempt{CreatedAt: created}
	require.False(t, attempt.IsExpired())
	for _, tc := range []struct {
		ttl     time.Duration
		expired bool
	}{
		{time.Nanosecond, true},
		{time.Millisecond - time.Nanosecond, true},
		{time.Millisecond, false},
		{time.Millisecond + time.Nanosecond, false},
		{5 * time.Minute, false},
	} {
		ttl := tc.ttl
		attempt.TimeToLive = &ttl
		require.Equal(t, tc.expired, attempt.IsExpired(), "ttl %s", ttl)
	}
	attempt.CreatedAt = time.Time{}
	require.False(t, attempt.IsExpired())
}

var expiryProbeSink uint64

// The host deliberately freezes its WASI clock. Local host markers independently
// measure elapsed time around synchronous work, before the predicate is called.
func TestMaPiFrozenClockAfterSynchronousWork(t *testing.T) {
	created := time.Now()
	ttl := 2 * time.Millisecond
	attempt := domain.AuthAttempt{CreatedAt: created, TimeToLive: &ttl}
	fmt.Println("MAPI_EXPIRY_WINDOW_BEGIN")
	var value uint64 = 1
	for i := uint64(0); i < 30000000; i++ {
		value = value*1664525 + 1013904223
	}
	expiryProbeSink = value
	fmt.Println("MAPI_EXPIRY_WINDOW_END")
	require.False(t, attempt.IsExpired(), "test clock must stay frozen")
}
