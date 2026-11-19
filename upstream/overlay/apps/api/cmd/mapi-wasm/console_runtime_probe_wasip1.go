//go:build wasip1 && mapi_console_runtime_probe

package main

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/zitadel/nextgen/internal/domain"
	"github.com/zitadel/nextgen/internal/service"
)

// Test-only adaptation of cmd/server/console_runtime.go. The caller must
// synchronously validate project identity, route, origin and recovery state.
//
//go:wasmexport mapi_console_runtime_probe
func consoleRuntimeProbe() uint64 {
	var args struct {
		ProjectID string `json:"projectId"`
	}
	if err := json.Unmarshal(input, &args); err != nil {
		return failure(err)
	}
	if runtimePool == nil || runtimeKeys == nil || runtimeTokens == nil || args.ProjectID == "" {
		return failure(errors.New("missing runtime project"))
	}
	ctx := context.Background()
	project, err := runtimePool.Statements().GetProjectByID(ctx, args.ProjectID)
	if err != nil {
		return failure(err)
	}
	releases := service.NewReleaseService(runtimePool, nil, nil, nil, nil, nil, domain.BuiltinSchemaBases{})
	if _, err = service.NewRuntimeResolver(runtimePool, releases).ResolvePrimary(ctx, project.ID); err != nil {
		return failure(err)
	}
	token, err := runtimeTokens.GetActivePreviewToken(ctx, project.ID)
	var jwe string
	if errors.Is(err, domain.TokenNotFound()) {
		jwe, err = runtimeTokens.GenerateJWE(ctx, project.PreviewToken())
	} else if err == nil {
		key, keyErr := runtimeKeys.GetProjectCrypter(ctx, project.ID, domain.EncryptionKeyPurposeToken)
		if keyErr != nil {
			return failure(keyErr)
		}
		jwe, err = token.JWE(key)
	}
	if err != nil {
		return failure(err)
	}
	// This probe refuses to publish a malformed or unexpectedly privileged key.
	// The check is stricter than the native resolver and is not an upstream contract.
	verified, err := runtimeTokens.IntrospectToken(ctx, jwe)
	if err != nil {
		return failure(err)
	}
	if verified.ProjectID != project.ID || verified.Type != domain.TokenTypeProjectPreview || len(verified.Scope) != 1 || verified.Scope[0] != "project.read" {
		return failure(errors.New("preview credential has unexpected scope"))
	}
	return marshal(map[string]string{"mode": "standalone", "console_project_id": project.ID, "publishable_key": jwe})
}
