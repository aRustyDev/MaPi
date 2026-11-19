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
	}
	if json.Unmarshal(input, &args) != nil || args.ProjectID == "" || !strings.HasPrefix(args.Issuer, "https://127.0.0.1:") {
		return failure(errors.New("invalid synthetic issuer"))
	}
	ctx := context.Background()
	attempts := service.NewAuthAttemptService(runtimePool, nil, nil, nil, nil)
	a := &domain.AuthAttempt{ProjectID: args.ProjectID, DeploymentID: "dep_synthetic"}
	if err := runtimePool.Statements().CreateAuthAttempt(ctx, a); err != nil {
		return failure(err)
	}
	crypter := op.NewAES256GCMCrypto([32]byte{1, 2, 3}, "idp_test_key")
	state, err := attempts.IssueSSOState(ctx, service.IssueSSOStateInput{ProjectID: args.ProjectID, AttemptID: a.ID, ProviderSlug: "synthetic", ConnectionRevisionID: "idprev_synthetic", RedirectURI: "https://app.example/callback", ReturnTarget: "/login", PKCEEncrypter: crypter})
	if err != nil {
		return failure(err)
	}
	encrypted, err := crypter.Encrypt(`"synthetic-secret"`)
	if err != nil {
		return failure(err)
	}
	vars, err := domain.NewVariableSet(args.ProjectID, []*domain.Variable{{Name: "PROVIDER_SECRET", Value: encrypted, IsSecret: true}})
	if err != nil {
		return failure(err)
	}
	document := []byte(fmt.Sprintf(`{"slug":"synthetic","protocol":"oidc","oidc":{"issuer":%q,"client_id":"synthetic","client_secret":"${{ PROVIDER_SECRET }}","scopes":["openid"]},"claim_mapping":{"email":"email"}}`, args.Issuer))
	binding := state.BindingNonce
	if args.WrongBinding {
		binding = "incorrect-synthetic-binding"
	}
	idpBridge, err = mapiidpbridge.New(service.FlowSSOCallbackInput{State: state.State, BindingNonce: binding, ConnectionSlug: "synthetic", Code: "synthetic-code", Issuer: args.Issuer}, attempts, syntheticIDPConnections{project: args.ProjectID, document: document}, syntheticIDPKeys{crypter: crypter}, syntheticIDPVariables{project: args.ProjectID, set: vars})
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
