//go:build wasip1 && mapi_idp_bridge_test

package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/go-jose/go-jose/v4"
	"github.com/zitadel/nextgen/internal/cloudflarewasm"
	"github.com/zitadel/nextgen/internal/domain"
	"github.com/zitadel/nextgen/internal/mapiidpbridge"
	"github.com/zitadel/nextgen/internal/service"
	configdefaults "github.com/zitadel/nextgen/packages/config/defaults"
	"github.com/zitadel/oidc/v3/pkg/op"
)

type syntheticIDPConnections struct {
	service.IDPConnectionService
	project  string
	document []byte
}

func (s syntheticIDPConnections) GetRevision(_ context.Context, project, id string) (*domain.IDPConnection, error) {
	if project != s.project || id != "idprev_synthetic" {
		return nil, errors.New("revision denied")
	}
	return &domain.IDPConnection{Slug: "synthetic", RevisionID: id, Document: s.document}, nil
}

type syntheticIDPVariables struct {
	service.VariableService
	project string
	set     *domain.VariableSet
}

func (s syntheticIDPVariables) GetDeploymentVariables(_ context.Context, project, id string) (*domain.VariableSet, error) {
	if project != s.project || id != "dep_synthetic" {
		return nil, errors.New("variables denied")
	}
	return s.set, nil
}

type syntheticIDPKeys struct {
	service.KeyService
	crypter op.Crypto
}

func (s syntheticIDPKeys) GetCrypter(_ context.Context, id string, algorithm jose.ContentEncryption) (op.Crypto, error) {
	if id != "idp_test_key" || algorithm != jose.A256GCM {
		return nil, errors.New("key denied")
	}
	return s.crypter, nil
}

var idpBridge *mapiidpbridge.Bridge
var idpAttemptID, idpProjectID string

//go:wasmexport mapi_idp_bridge_start
func idpBridgeStart() uint64 {
	if runtimePool == nil || idpBridge != nil {
		return failure(errors.New("bridge unavailable"))
	}
	var args struct {
		ProjectID, Issuer string
		WrongBinding      bool
		RealConfig        bool
	}
	if json.Unmarshal(input, &args) != nil || args.ProjectID == "" || !strings.HasPrefix(args.Issuer, "https://127.0.0.1:") {
		return failure(errors.New("invalid synthetic issuer"))
	}
	ctx := context.Background()
	attempts := service.NewAuthAttemptService(runtimePool, nil, nil, nil, nil)
	document := []byte(fmt.Sprintf(`{"slug":"synthetic","protocol":"oidc","display_name":"Synthetic","oidc":{"issuer":%q,"client_id":"synthetic","client_secret":"${{ PROVIDER_SECRET }}","scopes":["openid"]},"claim_mapping":{"email":"email"}}`, args.Issuer))
	var connections service.IDPConnectionService
	var variables service.VariableService
	var keys service.KeyService
	var crypter op.Crypto
	deploymentID, revisionID := "dep_synthetic", "idprev_synthetic"
	if args.RealConfig {
		if runtimeKeys == nil {
			return failure(errors.New("project keys unavailable"))
		}
		validator, err := domain.NewSchemaValidator(configdefaults.DefaultBuiltinSchemaBase)
		if err != nil {
			return failure(err)
		}
		connections = service.NewIDPConnectionService(runtimePool, validator)
		variables = service.NewVariableService(runtimePool, runtimeKeys)
		keys = runtimeKeys
		connection, err := connections.CreateOrRevise(ctx, args.ProjectID, document)
		if err != nil {
			return failure(err)
		}
		revisionID = connection.Connection.RevisionID
		if _, err = connections.GetRevision(ctx, "proj_other", revisionID); err == nil {
			return failure(errors.New("foreign revision accepted"))
		}
		owner := domain.VariableOwner{ProjectID: args.ProjectID}
		if err = variables.SetVariables(ctx, owner, nil, []service.VariableToSet{{Name: "PROVIDER_SECRET", Value: "synthetic-secret", IsSecret: true}}); err != nil {
			return failure(err)
		}
		bases := domain.BuiltinSchemaBasesFor(configdefaults.DefaultBuiltinSchemaBase)
		releases := service.NewReleaseService(runtimePool, nil, nil, nil, nil, nil, bases)
		resolution, err := service.NewRuntimeResolver(runtimePool, releases).ResolvePrimary(ctx, args.ProjectID)
		if err != nil {
			return failure(err)
		}
		deployed, err := service.NewDeploymentService(runtimePool, variables).Deploy(ctx, service.DeployInput{ProjectID: args.ProjectID, ReleaseID: resolution.Release.ID, To: domain.DeployToPrimary(), Reason: domain.DeploymentReasonDeploy})
		if err != nil {
			return failure(err)
		}
		deploymentID = deployed.Deployment.ID
		if _, err = variables.GetDeploymentVariables(ctx, "proj_other", deploymentID); err == nil {
			return failure(errors.New("foreign variables accepted"))
		}
		if err = variables.SetVariables(ctx, owner, nil, []service.VariableToSet{{Name: "PROVIDER_SECRET", Value: "changed-after-deployment", IsSecret: true}}); err != nil {
			return failure(err)
		}
		newDocument := []byte(fmt.Sprintf(`{"slug":"synthetic","protocol":"oidc","display_name":"Synthetic","oidc":{"issuer":%q,"client_id":"different-client","client_secret":"${{ PROVIDER_SECRET }}","scopes":["openid"]},"claim_mapping":{"email":"email"}}`, args.Issuer))
		if next, err := connections.CreateOrRevise(ctx, args.ProjectID, newDocument); err != nil || next.Connection.RevisionID == revisionID {
			return failure(errors.New("revision change failed"))
		}
		// Secret values and OAuth credentials must stay out of stored cleartext and mutation audit payloads.
		db := cloudflarewasm.Open()
		defer db.Close()
		var leaks, events int
		for _, table := range []struct{ name, column string }{{"variables", "value"}, {"variable_sets", "entries"}, {"events", "payload"}, {"idp_connection_revisions", "document"}} {
			if err = db.QueryRowContext(ctx, "SELECT count(*) FROM "+table.name+" WHERE project_id=? AND (instr("+table.column+",?)>0 OR instr("+table.column+",?)>0)", args.ProjectID, "synthetic-secret", "changed-after-deployment").Scan(&leaks); err != nil || leaks != 0 {
				return failure(errors.New("configuration secret persisted in cleartext"))
			}
		}
		if err = db.QueryRowContext(ctx, "SELECT count(*) FROM events WHERE project_id=? AND event_type IN ('idp.created','idp.updated','variable.set')", args.ProjectID).Scan(&events); err != nil || events < 4 {
			return failure(errors.New("configuration audit missing"))
		}
		crypter, err = runtimeKeys.GetProjectCrypter(ctx, args.ProjectID, domain.EncryptionKeyPurposeSecret)
		if err != nil {
			return failure(err)
		}
	} else {
		crypter = op.NewAES256GCMCrypto([32]byte{1, 2, 3}, "idp_test_key")
		encrypted, err := crypter.Encrypt(`"synthetic-secret"`)
		if err != nil {
			return failure(err)
		}
		vars, err := domain.NewVariableSet(args.ProjectID, []*domain.Variable{{Name: "PROVIDER_SECRET", Value: encrypted, IsSecret: true}})
		if err != nil {
			return failure(err)
		}
		connections = syntheticIDPConnections{project: args.ProjectID, document: document}
		variables = syntheticIDPVariables{project: args.ProjectID, set: vars}
		keys = syntheticIDPKeys{crypter: crypter}
	}
	a := &domain.AuthAttempt{ProjectID: args.ProjectID, DeploymentID: deploymentID}
	if err := runtimePool.Statements().CreateAuthAttempt(ctx, a); err != nil {
		return failure(err)
	}
	state, err := attempts.IssueSSOState(ctx, service.IssueSSOStateInput{ProjectID: args.ProjectID, AttemptID: a.ID, ProviderSlug: "synthetic", ConnectionRevisionID: revisionID, RedirectURI: "https://app.example/callback", ReturnTarget: "/login", PKCEEncrypter: crypter})
	if err != nil {
		return failure(err)
	}
	binding := state.BindingNonce
	if args.WrongBinding {
		binding = "incorrect-synthetic-binding"
	}
	idpBridge, err = mapiidpbridge.New(service.FlowSSOCallbackInput{State: state.State, BindingNonce: binding, ConnectionSlug: "synthetic", Code: "synthetic-code", Issuer: args.Issuer}, attempts, connections, keys, variables)
	if err != nil {
		return failure(err)
	}
	idpProjectID, idpAttemptID = args.ProjectID, a.ID
	next, out, err := idpBridge.Advance(ctx, nil)
	if err != nil || out != nil || next == nil {
		idpBridge = nil
		return failure(errors.New("initial callback failed"))
	}
	return marshal(map[string]any{"next": next, "nonce": state.OIDCNonce, "attemptId": a.ID})
}

//go:wasmexport mapi_idp_bridge_resume
func idpBridgeResume() uint64 {
	if idpBridge == nil {
		return failure(errors.New("no active bridge"))
	}
	var response mapiidpbridge.Response
	if err := json.Unmarshal(input, &response); err != nil {
		return failure(err)
	}
	next, out, err := idpBridge.Advance(context.Background(), &response)
	if err != nil {
		idpBridge = nil
		return failure(err)
	}
	if next != nil {
		return marshal(map[string]any{"next": next})
	}
	if out == nil || out.Failure != nil || out.ReturnTarget != "/login" {
		idpBridge = nil
		return failure(errors.New("upstream callback failed"))
	}
	attempt, err := runtimePool.Statements().GetAuthAttemptByID(context.Background(), idpProjectID, idpAttemptID)
	if err != nil {
		idpBridge = nil
		return failure(err)
	}
	check, ok := attempt.SSOCallback()
	if !ok || check.Result == nil || check.Result.Subject != "user-1" || check.Result.Claims["email"] != "user@example.test" {
		idpBridge = nil
		return failure(errors.New("upstream identity missing"))
	}
	db := cloudflarewasm.Open()
	defer db.Close()
	var n int
	err = db.QueryRow(`SELECT count(*) FROM events WHERE project_id=? AND event_type='auth.sso.exchange.succeeded' AND entity_id=?`, idpProjectID, check.ID).Scan(&n)
	idpBridge = nil
	if err != nil || n != 1 {
		return failure(errors.New("upstream audit missing"))
	}
	return marshal(map[string]any{"ok": true, "subject": check.Result.Subject})
}
