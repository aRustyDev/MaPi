package main

import (
	"database/sql"
	"errors"
)

// recoveryCheckpoint validates the persisted shape before a batch trusts any
// cursor or reports completion. It does not authenticate the checkpoint or
// detect a well-formed rollback; that requires an independent authority.
type recoveryCheckpoint struct {
	phase                                     string
	sessionID, attemptID                      *string
	sessions, attempts, handoffs, credentials int64
}

func (c recoveryCheckpoint) validate() error {
	if c.sessions < 0 || c.attempts < 0 || c.handoffs < 0 || c.credentials < 0 || c.handoffs > c.attempts {
		return errors.New("invalid recovery checkpoint counters")
	}
	for _, id := range []*string{c.sessionID, c.attemptID} {
		if id != nil {
			if err := recoveryValidateID(sql.NullString{String: *id, Valid: true}); err != nil {
				return errors.New("invalid recovery checkpoint cursor")
			}
		}
	}
	switch c.phase {
	case "sessions":
		if c.attemptID != nil || c.attempts != 0 || c.handoffs != 0 || c.credentials != 0 {
			return errors.New("invalid recovery checkpoint phase")
		}
	case "orphan-tokens", "credentials":
		if c.sessionID != nil || c.attemptID != nil || c.attempts != 0 || c.handoffs != 0 || (c.phase == "orphan-tokens" && c.credentials != 0) {
			return errors.New("invalid recovery checkpoint phase")
		}
	case "attempts":
		if c.sessionID != nil {
			return errors.New("invalid recovery checkpoint phase")
		}
	case "done":
		if c.sessionID != nil || c.attemptID != nil {
			return errors.New("invalid recovery checkpoint phase")
		}
	default:
		return errors.New("invalid recovery checkpoint phase")
	}
	return nil
}

// Missing work after a cursor has been recorded is not a successful phase
// transition: the row may have disappeared outside the fenced transaction.
func recoveryRequireNoPendingCursor(cursor *string) error {
	if cursor != nil {
		return errors.New("recovery checkpoint cursor disappeared")
	}
	return nil
}
