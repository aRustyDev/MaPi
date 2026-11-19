//go:build wasip1 && mapi_generation_test

package main

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/zitadel/nextgen/internal/domain"
	"github.com/zitadel/nextgen/internal/policy"
	"github.com/zitadel/nextgen/internal/service"
	"github.com/zitadel/nextgen/internal/storage/database"
)

// Test-only: exercise the actual pinned SQLite password and user statements.
//
//go:wasmexport mapi_generation_probe
func generationProbe() uint64 {
	var in struct{ ProjectID, UserID, Action string }
	if err := json.Unmarshal(input, &in); err != nil {
		return failure(err)
	}
	if runtimePool == nil || in.ProjectID == "" || in.UserID == "" {
		return failure(errors.New("invalid probe input"))
	}
	ctx := context.Background()
	s := runtimePool.Statements()
	switch in.Action {
	case "password":
		old, err := s.GetUserPassword(ctx, database.And(database.Equal(database.Col(domain.UserPasswordFieldProjectID), in.ProjectID), database.Equal(database.Col(domain.UserPasswordFieldUserID), in.UserID)))
		if err != nil {
			return failure(err)
		}
		if err = s.SetUserPassword(ctx, &domain.SetUserPassword{ProjectID: in.ProjectID, UserID: in.UserID, EncodedHash: old.EncodedHash}); err != nil {
			return failure(err)
		}
	case "policy":
		engine, err := policy.New()
		if err != nil {
			return failure(err)
		}
		_, err = service.NewPolicyService(runtimePool, engine).Publish(ctx, service.PublishPolicyInput{ProjectID: in.ProjectID, Operation: service.OperationPasswordSet, Config: map[string]any{"min_length": 12}})
		if err != nil {
			return failure(err)
		}
	case "deactivate":
		if err := s.DeactivateUser(ctx, in.ProjectID, in.UserID); err != nil {
			return failure(err)
		}
	default:
		return failure(errors.New("unknown probe mutation"))
	}
	return marshal(true)
}
