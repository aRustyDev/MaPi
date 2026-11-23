//go:build wasip1

package domain

import "time"

// The WASI host exposes Date.now, whose timestamps are integral milliseconds.
// Reject at most one millisecond early so quantization cannot extend a TTL.
// A frozen platform clock can still remain stale until the runtime advances it.
func authAttemptExpiredAtClockPrecision(expires time.Time) bool {
	return time.Now().Add(time.Millisecond).After(expires)
}
