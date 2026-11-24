//go:build wasip1 && mapi_recovery_token_proof

package main

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/zitadel/nextgen/internal/domain"
)

//go:wasmexport mapi_recovery_token_proof
func recoveryTokenProof() uint64 {
	var args struct{ Action, ProjectID, UserID, Kind, Token, TokenID, SessionID, OIDCSessionID, SAMLSessionID string }
	if err := json.Unmarshal(input, &args); err != nil {
		return failure(err)
	}
	if runtimeTokens == nil || runtimeKeys == nil || args.ProjectID == "" {
		return failure(errors.New("missing token proof configuration"))
	}
	ctx := context.Background()
	switch args.Action {
	case "mint", "legacy":
		var kind domain.TokenType
		switch args.Kind {
		case "pat":
			kind = domain.TokenTypePersonalAccessToken
		case "project":
			kind = domain.TokenTypeProjectToken
		case "preview":
			kind = domain.TokenTypeProjectPreview
		case "session":
			kind = domain.TokenTypeSessionToken
		case "oidc":
			kind = domain.TokenTypeOIDCAccessToken
		case "saml":
			kind = domain.TokenTypeSAMLAssertion
		case "flow":
			kind = domain.TokenTypeFlow
		case "jwtprofile":
			kind = domain.TokenTypeJWTProfile
		default:
			return failure(errors.New("invalid proof token type"))
		}
		value := &domain.Token{ProjectID: args.ProjectID, UserID: args.UserID, Type: kind, Scope: []string{"project.read", "project.write"}}
		if args.SessionID != "" {
			value.SessionID = &args.SessionID
		}
		if args.OIDCSessionID != "" {
			value.OIDCSessionID = &args.OIDCSessionID
		}
		if args.SAMLSessionID != "" {
			value.SAMLSessionID = &args.SAMLSessionID
		}
		if args.Action == "mint" {
			token, err := runtimeTokens.GenerateJWE(ctx, value)
			if err != nil {
				return failure(err)
			}
			return marshal(map[string]any{"token": token, "tokenId": value.TokenID})
		}
		crypt, err := runtimeKeys.GetProjectCrypter(ctx, args.ProjectID, domain.EncryptionKeyPurposeToken)
		if err != nil {
			return failure(err)
		}
		token, err := value.JWE(crypt)
		if err != nil {
			return failure(err)
		}
		return marshal(map[string]any{"token": token, "tokenId": value.TokenID})
	case "introspect":
		value, err := runtimeTokens.IntrospectToken(ctx, args.Token)
		if err != nil {
			return marshal(map[string]any{"valid": false})
		}
		return marshal(map[string]any{"valid": true, "tokenId": value.TokenID, "projectId": value.ProjectID})
	case "revoke":
		if err := runtimeTokens.RevokeToken(ctx, args.ProjectID, args.TokenID); err != nil {
			return failure(err)
		}
		return marshal(map[string]any{"ok": true})
	default:
		return failure(errors.New("invalid token proof action"))
	}
}
