package main

import (
	"context"
	"encoding/json"
	"errors"
	"runtime"
	"time"

	"github.com/zitadel/nextgen/api/openapi/endpoints/schemas"
	"github.com/zitadel/nextgen/internal/audit"
	"github.com/zitadel/nextgen/internal/cloudflarewasm"
	"github.com/zitadel/nextgen/internal/domain"
	"github.com/zitadel/nextgen/internal/policy"
	"github.com/zitadel/nextgen/internal/service"
	configdefaults "github.com/zitadel/nextgen/packages/config/defaults"
)

//go:wasmexport mapi_recover
func recoverSessions() uint64 {
	var args struct {
		ProjectID string `json:"projectId"`
		Epoch     string `json:"epoch"`
	}
	if err := json.Unmarshal(input, &args); err != nil {
		return failure(err)
	}
	if runtimePool == nil || args.ProjectID == "" || args.Epoch == "" {
		return failure(errors.New("missing recovery configuration"))
	}
	ctx := context.Background()
	db := cloudflarewasm.Open()
	defer db.Close()
	sessions := service.NewSessionService(runtimePool, service.StatementsUserRefResolver{Pool: runtimePool}, service.SessionConfig{DefaultTTL: domain.SessionDefaultTTL, MaxTTL: 720 * time.Hour})
	err := cloudflarewasm.Transaction(func() error {
		rows, err := db.QueryContext(ctx, "SELECT id FROM sessions WHERE project_id = ?", args.ProjectID)
		if err != nil {
			return err
		}
		var ids []string
		for rows.Next() {
			var id string
			if err := rows.Scan(&id); err != nil {
				rows.Close()
				return err
			}
			ids = append(ids, id)
		}
		if err := rows.Err(); err != nil {
			rows.Close()
			return err
		}
		if err := rows.Close(); err != nil {
			return err
		}
		for _, id := range ids {
			if err := sessions.Delete(ctx, service.DeleteSessionInput{ProjectID: args.ProjectID, SessionID: id}); err != nil {
				return err
			}
		}
		result, err := db.ExecContext(ctx, "UPDATE auth_attempts SET handed_off_at = 1 WHERE project_id = ? AND handed_off_at IS NOT NULL AND handoff_token IS NOT NULL", args.ProjectID)
		if err != nil {
			return err
		}
		count, err := result.RowsAffected()
		if err != nil {
			return err
		}
		if err := audit.Emit(ctx, runtimePool.Statements(), audit.EmitSpec{Type: domain.EventType("mapi.recovery.completed"), Category: domain.EventCategoryAuth, ProjectID: args.ProjectID, EntityType: "project", EntityID: args.ProjectID, Payload: map[string]any{"expired_handoffs": count, "revoked_sessions": len(ids)}}); err != nil {
			return err
		}
		_, err = db.ExecContext(ctx, "UPDATE mapi_recovery_epoch SET epoch = ?", args.Epoch)
		return err
	})
	if err != nil {
		return failure(err)
	}
	return marshal(true)
}

//go:wasmexport mapi_project_token
func projectToken() uint64 {
	var args struct {
		ProjectID string `json:"projectId"`
	}
	if err := json.Unmarshal(input, &args); err != nil {
		return failure(err)
	}
	if runtimeTokens == nil || args.ProjectID == "" {
		return failure(errors.New("missing project"))
	}
	project := domain.Project{ID: args.ProjectID}
	token, err := runtimeTokens.GenerateJWE(context.Background(), project.Token())
	if err != nil {
		return failure(err)
	}
	return marshal(map[string]string{"token": token})
}

//go:wasmexport mapi_provision
func provision() uint64 {
	var args struct {
		Name   string `json:"name"`
		Origin string `json:"origin"`
	}
	if err := json.Unmarshal(input, &args); err != nil {
		return failure(err)
	}
	if runtimePool == nil || args.Name == "" || args.Origin == "" {
		return failure(errors.New("missing provisioning configuration"))
	}
	ctx := service.WithAuthzListUnrestricted(context.Background())
	base := configdefaults.DefaultBuiltinSchemaBase
	validator, err := domain.NewSchemaValidator(base)
	if err != nil {
		return failure(err)
	}
	engine, err := policy.New()
	if err != nil {
		return failure(err)
	}
	projects := service.NewProjectService(runtimePool, base, validator, runtimeKeys, runtimeHashers, domain.DefaultSharedHosts)
	policies := service.NewPolicyService(runtimePool, engine)
	bases := domain.BuiltinSchemaBasesFor(base)
	releases := service.NewReleaseService(runtimePool, nil, nil, nil, nil, policies, bases)
	deployments := service.NewDeploymentService(runtimePool, service.NewVariableService(runtimePool, runtimeKeys))
	db := cloudflarewasm.Open()
	defer db.Close()
	var projectID string
	err = cloudflarewasm.Transaction(func() error {
		project, err := projects.Create(ctx, args.Name, []domain.Origin{{Pattern: args.Origin, Kind: domain.OriginKindPrimary}}, true)
		if err != nil {
			return err
		}
		projectID = project.ID
		var schemaID, flowID string
		if err := db.QueryRowContext(ctx, "SELECT url FROM json_schemas WHERE project_id = ?", projectID).Scan(&schemaID); err != nil {
			return err
		}
		if err := db.QueryRowContext(ctx, "SELECT id FROM flow_definitions WHERE project_id = ?", projectID).Scan(&flowID); err != nil {
			return err
		}
		var configured struct {
			Operation string         `json:"operation"`
			Config    map[string]any `json:"config"`
		}
		if err := json.Unmarshal(configdefaults.DefaultPasswordPolicy(), &configured); err != nil {
			return err
		}
		p, err := policies.Publish(ctx, service.PublishPolicyInput{ProjectID: projectID, Operation: configured.Operation, Config: configured.Config})
		if err != nil {
			return err
		}
		release, err := releases.Create(ctx, service.CreateReleaseInput{ProjectID: projectID, Pointers: []service.CreateReleasePointer{
			{Kind: domain.ReleasePointerKindSchema, RevisionID: schemaID},
			{Kind: domain.ReleasePointerKindFlowDefinition, RevisionID: flowID},
			{Kind: domain.ReleasePointerKindPolicy, RevisionID: p.RevisionID},
		}})
		if err != nil {
			return err
		}
		_, err = deployments.Deploy(ctx, service.DeployInput{ProjectID: projectID, ReleaseID: release.Release.ID, To: domain.DeployToPrimary(), Reason: domain.DeploymentReasonDeploy})
		if err != nil {
			return err
		}
		if _, err := service.NewRuntimeResolver(runtimePool, releases).ResolvePrimary(ctx, projectID); err != nil {
			return err
		}
		_, err = db.ExecContext(ctx, "INSERT INTO mapi_project (project_id, schema_url) VALUES (?, ?)", projectID, schemas.DefaultHumanUserSchemaURL(base))
		return err
	})
	if err != nil {
		return failure(err)
	}
	return marshal(map[string]string{"projectId": projectID})
}

//go:wasmexport mapi_add_user
func addUser() uint64 {
	var args struct {
		ProjectID string `json:"projectId"`
		Email     string `json:"email"`
		Password  string `json:"password"`
	}
	if err := json.Unmarshal(input, &args); err != nil {
		return failure(err)
	}
	if runtimePool == nil || args.ProjectID == "" || args.Email == "" || args.Password == "" {
		return failure(errors.New("missing user fields"))
	}
	ctx := service.WithAuthzListUnrestricted(context.Background())
	base := configdefaults.DefaultBuiltinSchemaBase
	bases := domain.BuiltinSchemaBasesFor(base)
	engine, err := policy.New()
	if err != nil {
		return failure(err)
	}
	policies := service.NewPolicyService(runtimePool, engine)
	releases := service.NewReleaseService(runtimePool, nil, nil, nil, nil, policies, bases)
	resolution, err := service.NewRuntimeResolver(runtimePool, releases).ResolvePrimary(ctx, args.ProjectID)
	if err != nil {
		return failure(err)
	}
	ctx = service.WithRuntimeResolution(ctx, resolution)
	passwordGate, err := service.NewPasswordPolicy(engine, policies, hasher, runtimePool)
	if err != nil {
		return failure(err)
	}
	hashers := service.NewProjectHasherResolver(runtimePool, runtimeHashers)
	schemaStore := domain.WithBuiltinSchemaAliases(runtimePool.Statements(), bases)
	users := service.NewUserService(runtimePool, schemaStore, hashers, passwordGate, service.StatementsUserRefResolver{Pool: runtimePool}, bases)
	userID, err := runtimePool.Statements().NewManagedID(string(domain.PrefixUser))
	if err != nil {
		return failure(err)
	}
	create := service.NewCreateUserAction(service.CreateUserInput{ProjectID: args.ProjectID, ID: userID, SchemaURL: schemas.DefaultHumanUserSchemaURL(base), Attributes: map[string]any{"email": args.Email}}, schemaStore)
	password := service.NewSetUserPasswordAction(service.SetPasswordInput{ProjectID: args.ProjectID, UserID: userID, Password: args.Password}, hashers, passwordGate)
	err = users.ApplyActions(ctx, create, password)
	runtime.GC()
	if err != nil {
		return failure(err)
	}
	return marshal(map[string]string{"userId": userID})
}
