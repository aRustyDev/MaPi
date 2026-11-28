//go:build js && wasm

package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	hydra "github.com/ory/hydra/v2/driver"
)

type boundIdentity struct {
	ProjectID string `json:"projectId" db:"project_id"`
	UserID    string `json:"userId" db:"user_id"`
	SessionID string `json:"sessionId" db:"session_id"`
	Issuer    string `json:"issuer" db:"issuer"`
}

func bindVerifiedAuthorizationCode(ctx context.Context, registry *hydra.RegistrySQL, body, issuer string) (reply, error) {
	var request struct {
		Code string `json:"code"`
		boundIdentity
	}
	if json.Unmarshal([]byte(body), &request) != nil || !opaqueID.MatchString(request.ProjectID) ||
		!opaqueID.MatchString(request.UserID) || !opaqueID.MatchString(request.SessionID) ||
		request.Issuer != issuer || len(request.Code) > 4096 {
		return reply{Status: http.StatusBadRequest}, nil
	}
	_, signature, ok := strings.Cut(request.Code, ".")
	if !ok || signature == "" {
		return reply{Status: http.StatusBadRequest}, nil
	}

	var grant string
	err := registry.Transaction(ctx, func(ctx context.Context) error {
		store := registry.BasePersister().Connection(ctx).Store
		var code struct {
			Grant   string `db:"request_id"`
			Subject string `db:"subject"`
		}
		if err := store.GetContext(ctx, &code, "SELECT request_id, subject FROM hydra_oauth2_code WHERE signature = $1 AND nid = $2 AND active = true",
			signature, registry.BasePersister().NetworkID(ctx)); err != nil {
			return err
		}
		if !opaqueID.MatchString(code.Grant) || code.Subject != request.UserID {
			return errors.New("authorization identity mismatch")
		}
		grant = code.Grant
		if _, err := store.ExecContext(ctx, "INSERT INTO mapi_hydra_grant (grant_id, session_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", grant, request.SessionID); err != nil {
			return err
		}
		var session string
		if err := store.GetContext(ctx, &session, "SELECT session_id FROM mapi_hydra_grant WHERE grant_id = $1", grant); err != nil || session != request.SessionID {
			return errors.New("grant session mismatch")
		}
		if _, err := store.ExecContext(ctx, "INSERT INTO mapi_hydra_identity (grant_id, project_id, user_id, session_id, issuer) VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING",
			grant, request.ProjectID, request.UserID, request.SessionID, issuer); err != nil {
			return err
		}
		var existing boundIdentity
		if err := store.GetContext(ctx, &existing, "SELECT project_id, user_id, session_id, issuer FROM mapi_hydra_identity WHERE grant_id = $1", grant); err != nil || existing != request.boundIdentity {
			return errors.New("grant identity mismatch")
		}
		return nil
	})
	if err != nil {
		return reply{}, errors.New("bind verified authorization code")
	}
	return reply{Status: http.StatusOK, Body: grant}, nil
}
