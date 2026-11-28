//go:build js && wasm

package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"regexp"
	"strings"
	"syscall/js"

	hydra "github.com/ory/hydra/v2/driver"
	"github.com/ory/hydra/v2/oauth2"
)

var opaqueID = regexp.MustCompile(`^[A-Za-z0-9_-]{1,128}$`)

func refreshFence(registry *hydra.RegistrySQL, host js.Value) *oauth2.Phase0RefreshFence {
	var grantID, sessionID, attemptID, refreshSignature string

	return &oauth2.Phase0RefreshFence{
		Begin: func(ctx context.Context, grant, refreshToken string) (bool, error) {
			// The pinned Hydra HMAC strategy uses the second component as
			// the stored signature. NewAccessRequest already verified it.
			_, signature, ok := strings.Cut(refreshToken, ".")
			if !ok || signature == "" {
				return false, nil
			}
			refreshSignature = signature
			err := registry.BasePersister().Connection(ctx).Store.GetContext(
				ctx, &sessionID, "SELECT session_id FROM mapi_hydra_grant WHERE grant_id = $1", grant)
			if errors.Is(err, sql.ErrNoRows) {
				return false, nil
			}
			if err != nil {
				return false, err
			}
			grantID = grant
			value, err := wait(host.Call("admit", sessionID, grantID))
			if err != nil || value.IsNull() {
				return false, err
			}
			attemptID = value.String()
			return opaqueID.MatchString(attemptID), nil
		},
		Receipt: func(ctx context.Context) (bool, error) {
			// The row is only visible on commit. The alarm competes for this
			// exact unique key to establish durable cancellation.
			persister := registry.BasePersister()
			store := persister.Connection(ctx).Store
			result, err := store.ExecContext(ctx,
				"INSERT INTO mapi_hydra_mint VALUES ($1, $2, 'committed') ON CONFLICT DO NOTHING",
				attemptID, grantID)
			if err != nil {
				return false, err
			}
			rows, err := result.RowsAffected()
			if err != nil || rows != 1 {
				return false, err
			}

			// Two callers can both get past NewAccessRequest. Recheck this
			// specific token under lock before Hydra rotates the chain.
			var active bool
			err = store.GetContext(ctx, &active, `SELECT active FROM hydra_oauth2_refresh
				WHERE signature = $1 AND request_id = $2 AND nid = $3 FOR UPDATE`,
				refreshSignature, grantID, persister.NetworkID(ctx))
			if errors.Is(err, sql.ErrNoRows) {
				return false, nil
			}
			return active, err
		},
		BeforeCommit: func() error {
			value, err := wait(host.Call("checkpoint", sessionID, "before_commit"))
			if err == nil && value.Type() == js.TypeBoolean && value.Bool() {
				host.Set("dropCommitAck", true)
			}
			return err
		},
		Release: func(context.Context) (bool, error) {
			if _, err := wait(host.Call("checkpoint", sessionID, "after_commit")); err != nil {
				return false, err
			}
			value, err := wait(host.Call("release", sessionID, attemptID))
			if err != nil {
				return false, err
			}
			return value.Bool(), nil
		},
	}
}

type fenceCommand struct {
	Action  string `json:"action"`
	Session string `json:"session"`
	Grant   string `json:"grant"`
	Attempt string `json:"attempt"`
}

func fenceDatabase(ctx context.Context, registry *hydra.RegistrySQL, body string) (reply, error) {
	var cmd fenceCommand
	if err := json.Unmarshal([]byte(body), &cmd); err != nil || !opaqueID.MatchString(cmd.Grant) ||
		!opaqueID.MatchString(cmd.Session) || (cmd.Action == "reconcile" && !opaqueID.MatchString(cmd.Attempt)) {
		return reply{Status: http.StatusBadRequest, Body: "invalid private fence command"}, nil
	}

	var value string
	err := registry.Transaction(ctx, func(ctx context.Context) error {
		store := registry.BasePersister().Connection(ctx).Store
		if cmd.Action == "link" {
			if _, err := store.ExecContext(ctx, "INSERT INTO mapi_hydra_grant VALUES ($1, $2) ON CONFLICT DO NOTHING",
				cmd.Grant, cmd.Session); err != nil {
				return err
			}
		}

		var linked string
		err := store.GetContext(ctx, &linked, "SELECT session_id FROM mapi_hydra_grant WHERE grant_id = $1", cmd.Grant)
		if err != nil {
			return err
		}
		if linked != cmd.Session {
			return errors.New("grant belongs to another session")
		}

		switch cmd.Action {
		case "link":
			value = "linked"
		case "reconcile":
			// In READ COMMITTED, a conflicting uncommitted receipt makes
			// this insert wait. The SELECT then sees the winner's outcome.
			if _, err := store.ExecContext(ctx, "INSERT INTO mapi_hydra_mint VALUES ($1, $2, 'cancelled') ON CONFLICT DO NOTHING",
				cmd.Attempt, cmd.Grant); err != nil {
				return err
			}
			return store.GetContext(ctx, &value, "SELECT outcome FROM mapi_hydra_mint WHERE attempt_id = $1 AND grant_id = $2",
				cmd.Attempt, cmd.Grant)
		case "revoke":
			if err := registry.Persister().RevokeRefreshToken(ctx, cmd.Grant); err != nil {
				return err
			}
			if err := registry.Persister().RevokeAccessToken(ctx, cmd.Grant); err != nil {
				return err
			}
			value = "revoked"
		default:
			return errors.New("unknown private fence command")
		}
		return nil
	})
	if err != nil {
		return reply{}, errors.New("execute Hydra fence database transaction")
	}
	return reply{Status: http.StatusOK, Body: value}, nil
}
