//go:build wasip1

package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"time"
	"unicode/utf8"

	"github.com/zitadel/nextgen/internal/audit"
	"github.com/zitadel/nextgen/internal/cloudflarewasm"
	"github.com/zitadel/nextgen/internal/domain"
	"github.com/zitadel/nextgen/internal/service"
)

const recoveryInvalidationDDL = `CREATE TABLE IF NOT EXISTS mapi_recovery_invalidation (singleton INTEGER PRIMARY KEY CHECK (singleton=1), project_id TEXT NOT NULL, recovery_id TEXT NOT NULL, phase TEXT NOT NULL, session_id TEXT, attempt_id TEXT, sessions INTEGER NOT NULL, attempts INTEGER NOT NULL, handoffs INTEGER NOT NULL, credentials INTEGER NOT NULL)`

func recoveryAudit(ctx context.Context, project, recovery, kind, entity, id string, count int) error {
	return audit.Emit(ctx, runtimePool.Statements(), audit.EmitSpec{Type: domain.EventType(kind), Category: domain.EventCategoryAuth, ProjectID: project, EntityType: entity, EntityID: id, Payload: map[string]any{"recovery_id": recovery, "count": count}})
}

//go:wasmexport mapi_recover_batch
func recoverBatch() uint64 {
	var args struct {
		ProjectID  string `json:"projectId"`
		RecoveryID string `json:"recoveryId"`
	}
	if err := json.Unmarshal(input, &args); err != nil {
		return failure(err)
	}
	if runtimePool == nil || args.ProjectID == "" || args.RecoveryID == "" || len(args.ProjectID) > 128 || len(args.RecoveryID) > 128 || !utf8.ValidString(args.ProjectID) || !utf8.ValidString(args.RecoveryID) {
		return failure(errors.New("missing or invalid recovery configuration"))
	}
	ctx := context.Background()
	db := cloudflarewasm.Open()
	defer db.Close()
	sessions := service.NewSessionService(runtimePool, service.StatementsUserRefResolver{Pool: runtimePool}, service.SessionConfig{DefaultTTL: domain.SessionDefaultTTL, MaxTTL: 720 * time.Hour})
	result := map[string]any{}
	err := cloudflarewasm.Transaction(func() error {
		if _, err := db.ExecContext(ctx, recoveryInvalidationDDL); err != nil {
			return err
		}
		if _, err := db.ExecContext(ctx, "INSERT OR IGNORE INTO mapi_recovery_invalidation VALUES (1, ?, ?, 'sessions', NULL, NULL, 0, 0, 0, 0)", args.ProjectID, args.RecoveryID); err != nil {
			return err
		}
		var project, recovery, phase string
		var sessionID, attemptID *string
		var sessionCount, attemptCount, handoffCount, credentialCount int64
		if err := db.QueryRowContext(ctx, "SELECT project_id,recovery_id,phase,session_id,attempt_id,sessions,attempts,handoffs,credentials FROM mapi_recovery_invalidation WHERE singleton=1").Scan(&project, &recovery, &phase, &sessionID, &attemptID, &sessionCount, &attemptCount, &handoffCount, &credentialCount); err != nil {
			return err
		}
		if project != args.ProjectID || recovery != args.RecoveryID {
			return errors.New("conflicting recovery checkpoint")
		}
		if err := (recoveryCheckpoint{
			phase: phase, sessionID: sessionID, attemptID: attemptID,
			sessions: sessionCount, attempts: attemptCount, handoffs: handoffCount, credentials: credentialCount,
		}).validate(); err != nil {
			return err
		}
		if phase == "done" {
			result["done"] = true
			result["sessions"] = sessionCount
			result["attempts"] = attemptCount
			result["handoffs"] = handoffCount
			result["credentials"] = credentialCount
			return nil
		}
		if phase == "sessions" {
			id, err := recoveryOneID(ctx, db, "SELECT CASE WHEN length(CAST(id AS BLOB)) <= 8192 THEN id ELSE NULL END AS safe_id FROM sessions WHERE project_id=? ORDER BY id LIMIT 1", project)
			if err != nil {
				return err
			}
			if id == "" {
				if err = recoveryRequireNoPendingCursor(sessionID); err != nil {
					return err
				}
				if _, err = db.ExecContext(ctx, "UPDATE mapi_recovery_invalidation SET phase='orphan-tokens',session_id=NULL WHERE singleton=1"); err != nil {
					return err
				}
				phase = "orphan-tokens"
			} else {
				if sessionID != nil && *sessionID != id {
					return errors.New("recovery session checkpoint changed")
				}
				if _, err = db.ExecContext(ctx, "UPDATE mapi_recovery_invalidation SET session_id=? WHERE singleton=1", id); err != nil {
					return err
				}
				count, err := recoveryDeleteBounded(ctx, db, "SELECT CASE WHEN length(CAST(id AS BLOB)) <= 8192 THEN id ELSE NULL END AS safe_id FROM checks WHERE project_id=? AND session_id=? LIMIT 1", "DELETE FROM checks WHERE project_id=? AND id=?", project, id)
				if err != nil {
					return err
				}
				if count > 0 {
					if err = recoveryAudit(ctx, project, recovery, "mapi.recovery.session_checks_invalidated", "session", id, count); err != nil {
						return err
					}
					result["phase"] = "checks"
					result["count"] = count
					return nil
				}
				count, err = recoveryDeleteBounded(ctx, db, "SELECT CASE WHEN length(CAST(token_id AS BLOB)) <= 8192 THEN token_id ELSE NULL END AS safe_id FROM tokens WHERE project_id=? AND session_id=? LIMIT 1", "DELETE FROM tokens WHERE project_id=? AND token_id=?", project, id)
				if err != nil {
					return err
				}
				if count > 0 {
					if err = recoveryAudit(ctx, project, recovery, "mapi.recovery.session_tokens_invalidated", "session", id, count); err != nil {
						return err
					}
					result["phase"] = "tokens"
					result["count"] = count
					return nil
				}
				if err = sessions.Delete(ctx, service.DeleteSessionInput{ProjectID: project, SessionID: id}); err != nil {
					return err
				}
				if _, err = db.ExecContext(ctx, "UPDATE mapi_recovery_invalidation SET session_id=NULL,sessions=sessions+1 WHERE singleton=1"); err != nil {
					return err
				}
				result["phase"] = "session"
				result["count"] = 1
				return nil
			}
		}
		if phase == "orphan-tokens" {
			count, err := recoveryDeleteBounded(ctx, db, "SELECT CASE WHEN length(CAST(token_id AS BLOB)) <= 8192 THEN token_id ELSE NULL END AS safe_id FROM tokens WHERE project_id=? AND session_id IS NOT NULL LIMIT 1", "DELETE FROM tokens WHERE project_id=? AND token_id=?", project)
			if err != nil {
				return err
			}
			if count > 0 {
				if err = recoveryAudit(ctx, project, recovery, "mapi.recovery.orphan_tokens_invalidated", "project", project, count); err != nil {
					return err
				}
				result["phase"] = "orphan-tokens"
				result["count"] = count
				return nil
			}
			if _, err = db.ExecContext(ctx, "UPDATE mapi_recovery_invalidation SET phase='credentials' WHERE singleton=1"); err != nil {
				return err
			}
			phase = "credentials"
		}
		if phase == "credentials" {
			id, err := recoveryOneID(ctx, db, "SELECT CASE WHEN length(CAST(token_id AS BLOB)) <= 8192 THEN token_id ELSE NULL END AS safe_id FROM tokens WHERE project_id=? ORDER BY token_id LIMIT 1", project)
			if err != nil {
				return err
			}
			if id != "" {
				if err = runtimeTokens.RevokeToken(ctx, project, id); err != nil {
					return err
				}
				if err = recoveryAudit(ctx, project, recovery, "mapi.recovery.credential_invalidated", "token", id, 1); err != nil {
					return err
				}
				if _, err = db.ExecContext(ctx, "UPDATE mapi_recovery_invalidation SET credentials=credentials+1 WHERE singleton=1"); err != nil {
					return err
				}
				result["phase"] = "credential"
				result["count"] = 1
				return nil
			}
			if _, err = db.ExecContext(ctx, "UPDATE mapi_recovery_invalidation SET phase='attempts' WHERE singleton=1"); err != nil {
				return err
			}
			phase = "attempts"
		}
		if phase == "attempts" {
			var id sql.NullString
			var handedOff int
			err := db.QueryRowContext(ctx, "SELECT CASE WHEN length(CAST(id AS BLOB)) <= 8192 THEN id ELSE NULL END AS safe_id, CASE WHEN handed_off_at IS NOT NULL AND handoff_token IS NOT NULL THEN 1 ELSE 0 END FROM auth_attempts WHERE project_id=? ORDER BY id LIMIT 1", project).Scan(&id, &handedOff)
			if errors.Is(err, sql.ErrNoRows) {
				if err = recoveryRequireNoPendingCursor(attemptID); err != nil {
					return err
				}
				if err = audit.Emit(ctx, runtimePool.Statements(), audit.EmitSpec{Type: domain.EventType("mapi.recovery.completed"), Category: domain.EventCategoryAuth, ProjectID: project, EntityType: "project", EntityID: project, Payload: map[string]any{"recovery_id": recovery, "invalidated_attempts": attemptCount, "invalidated_handoffs": handoffCount, "revoked_sessions": sessionCount, "revoked_credentials": credentialCount}}); err != nil {
					return err
				}
				if _, err = db.ExecContext(ctx, "UPDATE mapi_recovery_invalidation SET phase='done' WHERE singleton=1"); err != nil {
					return err
				}
				result["done"] = true
				result["sessions"] = sessionCount
				result["attempts"] = attemptCount
				result["handoffs"] = handoffCount
				result["credentials"] = credentialCount
				return nil
			}
			if err != nil {
				return err
			}
			if err = recoveryValidateID(id); err != nil {
				return err
			}
			if attemptID != nil && *attemptID != id.String {
				return errors.New("recovery attempt checkpoint changed")
			}
			if _, err = db.ExecContext(ctx, "UPDATE mapi_recovery_invalidation SET attempt_id=? WHERE singleton=1", id.String); err != nil {
				return err
			}
			count, err := recoveryDeleteBounded(ctx, db, "SELECT CASE WHEN length(CAST(id AS BLOB)) <= 8192 THEN id ELSE NULL END AS safe_id FROM checks WHERE project_id=? AND auth_attempt_id=? LIMIT 1", "DELETE FROM checks WHERE project_id=? AND id=?", project, id.String)
			if err != nil {
				return err
			}
			if count > 0 {
				if err = recoveryAudit(ctx, project, recovery, "mapi.recovery.attempt_checks_invalidated", "auth_attempt", id.String, count); err != nil {
					return err
				}
				result["phase"] = "attempt-checks"
				result["count"] = count
				return nil
			}
			if err = runtimePool.Statements().DeleteAuthAttemptByID(ctx, project, id.String); err != nil {
				return err
			}
			if err = recoveryAudit(ctx, project, recovery, "mapi.recovery.attempt_invalidated", "auth_attempt", id.String, 1); err != nil {
				return err
			}
			if _, err = db.ExecContext(ctx, "UPDATE mapi_recovery_invalidation SET attempt_id=NULL,attempts=attempts+1,handoffs=handoffs+? WHERE singleton=1", handedOff); err != nil {
				return err
			}
			result["phase"] = "attempt"
			result["count"] = 1
			return nil
		}
		return fmt.Errorf("invalid recovery invalidation phase %q", phase)
	})
	if err != nil {
		return failure(err)
	}
	return marshal(result)
}
