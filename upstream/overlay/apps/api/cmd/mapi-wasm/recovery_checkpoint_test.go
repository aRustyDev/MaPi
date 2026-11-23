package main

import (
	"strings"
	"testing"
)

func TestRecoveryCheckpointAcceptsDocumentedTransitions(t *testing.T) {
	session, attempt := "session-1", "attempt-1"
	states := []recoveryCheckpoint{
		{phase: "sessions"},
		{phase: "sessions", sessionID: &session, sessions: 1},
		{phase: "orphan-tokens", sessions: 2},
		{phase: "credentials", sessions: 2, credentials: 1},
		{phase: "attempts", attemptID: &attempt, sessions: 2, credentials: 3, attempts: 1, handoffs: 1},
		{phase: "done", sessions: 2, credentials: 3, attempts: 2, handoffs: 1},
	}
	for _, state := range states {
		if err := state.validate(); err != nil {
			t.Fatalf("valid state %#v: %v", state, err)
		}
	}
}

func TestRecoveryCheckpointRejectsImpossibleProgress(t *testing.T) {
	session, attempt, empty := "session-1", "attempt-1", ""
	large := strings.Repeat("x", recoveryIDBytes+1)
	badUTF8 := string([]byte{0xff})
	cases := map[string]recoveryCheckpoint{
		"unknown phase":               {phase: "ready"},
		"negative count":              {phase: "done", sessions: -1},
		"more handoffs than attempts": {phase: "done", attempts: 1, handoffs: 2},
		"attempt in sessions":         {phase: "sessions", attemptID: &attempt},
		"early credential":            {phase: "orphan-tokens", credentials: 1},
		"early attempt":               {phase: "credentials", attempts: 1},
		"session in attempts":         {phase: "attempts", sessionID: &session},
		"unfinished completion":       {phase: "done", attemptID: &attempt},
		"empty cursor":                {phase: "sessions", sessionID: &empty},
		"oversized cursor":            {phase: "sessions", sessionID: &large},
		"invalid UTF8 cursor":         {phase: "attempts", attemptID: &badUTF8},
	}
	for name, state := range cases {
		t.Run(name, func(t *testing.T) {
			if err := state.validate(); err == nil {
				t.Fatalf("accepted impossible state %#v", state)
			}
		})
	}
}

func TestRecoveryMissingRecordedCursorFailsClosed(t *testing.T) {
	id := "previously-recorded-work"
	if err := recoveryRequireNoPendingCursor(nil); err != nil {
		t.Fatalf("empty checkpoint: %v", err)
	}
	if err := recoveryRequireNoPendingCursor(&id); err == nil {
		t.Fatal("missing row with a pending cursor must not advance the phase")
	}
}
