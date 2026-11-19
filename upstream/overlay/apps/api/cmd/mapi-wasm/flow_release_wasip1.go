//go:build wasip1 && mapi_oauth

package main

import (
	"context"
	"encoding/json"
	"errors"
	"runtime"

	"github.com/zitadel/nextgen/internal/audit"
	"github.com/zitadel/nextgen/internal/cloudflarewasm"
	"github.com/zitadel/nextgen/internal/domain"
	"github.com/zitadel/nextgen/internal/mapiflowrelease"
	"github.com/zitadel/nextgen/internal/service"
)

//go:wasmexport mapi_flow_release
func flowRelease() uint64 {
	defer runtime.GC()
	var args struct {
		ProjectID            string          `json:"projectId"`
		Origin               string          `json:"origin"`
		Action               string          `json:"action"`
		Document             json.RawMessage `json:"document"`
		ExpectedDeploymentID string          `json:"expectedDeploymentId"`
		TargetDeploymentID   string          `json:"targetDeploymentId"`
	}
	if err := json.Unmarshal(input, &args); err != nil {
		return failure(err)
	}
	actorID, actorType := "mapi_operator", domain.EventActorTypeService
	// The host authenticates the shared operator credential before invoking
	// this export. The actor identifies that service, not an individual.
	ctx := audit.WithActorContext(context.Background(), audit.ActorContext{ProjectID: args.ProjectID, ActorID: &actorID, ActorType: &actorType, Authenticated: true})
	_, db, err := oauthComposition(ctx, args.ProjectID, args.Origin)
	if err != nil {
		return failure(err)
	}
	defer db.Close()
	manager := mapiflowrelease.Manager{ProjectID: args.ProjectID, Origin: args.Origin, Pool: runtimePool, Keys: runtimeKeys, Schemas: oauthSchemas, Transaction: func(ctx context.Context, fn func(context.Context, *service.DB) error) error {
		return cloudflarewasm.Transaction(func() error { return fn(ctx, runtimePool) })
	}}
	switch args.Action {
	case "status":
		value, err := manager.Status(ctx)
		if err != nil {
			return failure(err)
		}
		return marshal(value)
	case "publish":
		value, err := manager.Publish(ctx, args.Document, args.ExpectedDeploymentID)
		if err != nil {
			return failure(err)
		}
		return marshal(value)
	case "rollback":
		value, err := manager.Rollback(ctx, args.TargetDeploymentID, args.ExpectedDeploymentID)
		if err != nil {
			return failure(err)
		}
		return marshal(value)
	default:
		return failure(errors.New("unknown flow release operation"))
	}
}
