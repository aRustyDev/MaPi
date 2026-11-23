//go:build !wasip1

package domain

import "time"

func authAttemptExpiredAtClockPrecision(expires time.Time) bool {
	return time.Now().After(expires)
}
