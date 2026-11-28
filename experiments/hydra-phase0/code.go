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

func bindAuthorizationCode(ctx context.Context, registry *hydra.RegistrySQL, body string) (reply, error) {
	var request struct {
		Code    string `json:"code"`
		Session string `json:"session"`
	}
	if json.Unmarshal([]byte(body), &request) != nil || !opaqueID.MatchString(request.Session) || len(request.Code) > 4096 {
		return reply{Status: http.StatusBadRequest}, nil
	}
	_, signature, ok := strings.Cut(request.Code, ".")
	if !ok || signature == "" {
		return reply{Status: http.StatusBadRequest}, nil
	}
	var grant string
	err := registry.Transaction(ctx, func(ctx context.Context) error {
		store := registry.BasePersister().Connection(ctx).Store
		if err := store.GetContext(ctx, &grant, "SELECT request_id FROM hydra_oauth2_code WHERE signature = $1 AND nid = $2",
			signature, registry.BasePersister().NetworkID(ctx)); err != nil {
			return err
		}
		if !opaqueID.MatchString(grant) {
			return errors.New("invalid grant")
		}
		if _, err := store.ExecContext(ctx, "INSERT INTO mapi_hydra_grant VALUES ($1, $2) ON CONFLICT DO NOTHING", grant, request.Session); err != nil {
			return err
		}
		var session string
		if err := store.GetContext(ctx, &session, "SELECT session_id FROM mapi_hydra_grant WHERE grant_id = $1", grant); err != nil {
			return err
		}
		if session != request.Session {
			return errors.New("grant belongs to another session")
		}
		return nil
	})
	if err != nil {
		return reply{}, errors.New("bind authorization code")
	}
	return reply{Status: http.StatusOK, Body: grant}, nil
}
