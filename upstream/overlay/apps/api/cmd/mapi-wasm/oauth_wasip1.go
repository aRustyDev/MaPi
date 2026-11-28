//go:build wasip1 && mapi_oauth

package main

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"runtime"
	"strings"
	"time"

	"github.com/zitadel/nextgen/internal/cloudflarewasm"
	"github.com/zitadel/nextgen/internal/domain"
	"github.com/zitadel/nextgen/internal/mapioauth"
	"github.com/zitadel/nextgen/internal/service"
	configdefaults "github.com/zitadel/nextgen/packages/config/defaults"
)

// Built-in schemas are immutable; compile them once per reactor rather than
// allocating a new validator on every issuer request.
var oauthSchemas service.BuiltinSchemaProvider

//go:wasmexport mapi_hydra_session_valid
func hydraSessionValid() uint64 {
	var args struct {
		ProjectID string `json:"projectId"`
		UserID    string `json:"userId"`
		SessionID string `json:"sessionId"`
	}
	if json.Unmarshal(input, &args) != nil || runtimePool == nil {
		return marshal(false)
	}
	ctx := context.Background()
	db := cloudflarewasm.Open()
	defer db.Close()
	var project string
	if db.QueryRowContext(ctx, "SELECT project_id FROM mapi_project").Scan(&project) != nil || project != args.ProjectID {
		return marshal(false)
	}
	issuer := mapioauth.TokenIssuer{
		Keys:     mapioauth.SigningKeys{ProjectID: project},
		Sessions: runtimePool.Statements(),
		Store:    mapioauth.Store{Now: time.Now},
	}
	return marshal(issuer.ValidateBoundSession(ctx, project, args.UserID, args.SessionID))
}

// oauthComposition is a host-only opt-in. The host must authenticate admin
// calls, enforce ingress limits and origin routing, and may not publicly expose
// provider endpoints before discovery, userinfo, revocation, logout and the
// required conformance/security tests exist.
func oauthComposition(ctx context.Context, projectID, origin string) (*mapioauth.Composition, *sql.DB, error) {
	if runtimePool == nil || runtimeKeys == nil || runtimeTokens == nil {
		return nil, nil, errors.New("runtime not initialized")
	}
	db := cloudflarewasm.Open()
	var actualProject, actualOrigin string
	if err := db.QueryRowContext(ctx, "SELECT project_id FROM mapi_project").Scan(&actualProject); err != nil {
		db.Close()
		return nil, nil, err
	}
	if err := db.QueryRowContext(ctx, "SELECT origin FROM mapi_project_origin").Scan(&actualOrigin); err != nil {
		db.Close()
		return nil, nil, err
	}
	if actualProject != projectID || actualOrigin != origin {
		db.Close()
		return nil, nil, errors.New("project or origin does not match this object")
	}
	if oauthSchemas == nil {
		schemas, err := domain.NewSchemaValidator(configdefaults.DefaultBuiltinSchemaBase)
		if err != nil {
			db.Close()
			return nil, nil, err
		}
		oauthSchemas = schemas
	}
	store := mapioauth.Store{DB: db, Transaction: cloudflarewasm.Transaction, Now: time.Now}
	result, err := mapioauth.Compose(mapioauth.Config{ProjectID: projectID, Origin: origin, Store: store, Pool: runtimePool, Keys: runtimeKeys, Tokens: runtimeTokens, Schemas: oauthSchemas})
	if err != nil {
		db.Close()
		return nil, nil, err
	}
	return result, db, nil
}

//go:wasmexport mapi_oauth_admin
func oauthAdmin() uint64 {
	var args struct {
		ProjectID string          `json:"projectId"`
		Origin    string          `json:"origin"`
		Action    string          `json:"action"`
		Document  json.RawMessage `json:"document"`
		ClientID  string          `json:"clientId"`
		LogoutURI string          `json:"logoutUri"`
	}
	if err := json.Unmarshal(input, &args); err != nil {
		return failure(err)
	}
	ctx := context.Background()
	c, db, err := oauthComposition(ctx, args.ProjectID, args.Origin)
	if err != nil {
		return failure(err)
	}
	defer db.Close()
	switch args.Action {
	case "initialize":
		if err = c.Admin.InitializeSchema(ctx); err != nil {
			return failure(err)
		}
		id, err := c.Admin.EnsureSigningKey(ctx)
		if err != nil {
			return failure(err)
		}
		return marshal(map[string]string{"keyId": id, "issuer": c.Issuer})
	case "register":
		result, err := c.Admin.RegisterApplication(ctx, args.Document)
		if err != nil {
			return failure(err)
		}
		return marshal(result)
	case "rotate_client_secret":
		credential, err := c.Admin.RotateClientSecret(ctx, args.ClientID)
		if err != nil {
			return failure(err)
		}
		return marshal(credential)
	case "revoke_client_secrets":
		if err := c.Admin.RevokeClientSecrets(ctx, args.ClientID); err != nil {
			return failure(err)
		}
		return marshal(true)
	case "register_logout":
		if err := c.Admin.RegisterLogoutURI(ctx, args.ClientID, args.LogoutURI); err != nil {
			return failure(err)
		}
		return marshal(true)
	case "rotate":
		id, err := c.Admin.RotateSigningKey(ctx)
		if err != nil {
			return failure(err)
		}
		return marshal(map[string]string{"keyId": id})
	default:
		return failure(errors.New("unknown OAuth admin action"))
	}
}

//go:wasmexport mapi_oauth_request
func oauthRequest() uint64 {
	var args struct {
		ProjectID string  `json:"projectId"`
		Origin    string  `json:"origin"`
		Request   request `json:"request"`
	}
	if err := json.Unmarshal(input, &args); err != nil {
		return failure(err)
	}
	ctx := context.Background()
	c, db, err := oauthComposition(ctx, args.ProjectID, args.Origin)
	if err != nil {
		return failure(err)
	}
	defer db.Close()
	req, err := http.NewRequestWithContext(ctx, args.Request.Method, args.Request.URL, bytes.NewReader(args.Request.Body))
	if err != nil {
		return failure(err)
	}
	if req.URL.Scheme != "https" || req.URL.Scheme+"://"+req.URL.Host != args.Origin {
		return failure(errors.New("invalid OAuth request origin"))
	}
	for k, vs := range args.Request.Headers {
		req.Header[http.CanonicalHeaderKey(k)] = vs
	}
	recorder := httptest.NewRecorder()
	switch req.URL.Path {
	case "/oauth/continue":
		c.Login.ServeHTTP(recorder, req)
	case "/oauth/" + args.ProjectID + "/end_session":
		c.Logout.ServeHTTP(recorder, req)
	case "/oauth/" + args.ProjectID + "/.well-known/openid-configuration":
		c.Discovery(recorder, req)
	case "/oauth/" + args.ProjectID + "/authorize", "/oauth/" + args.ProjectID + "/token", "/oauth/" + args.ProjectID + "/jwks", "/oauth/" + args.ProjectID + "/userinfo", "/oauth/" + args.ProjectID + "/revoke":
		req.URL.Path = strings.TrimPrefix(req.URL.Path, "/oauth/"+args.ProjectID)
		c.Provider.Handler().ServeHTTP(recorder, req)
	default:
		return failure(errors.New("unsupported OAuth request"))
	}
	// The same long-lived reactor also handles Argon2 password checks. Reclaim
	// transient issuer allocations before the next request needs that arena.
	// Go can reuse Wasm pages but cannot return pages to the host.
	runtime.GC()
	return marshal(response{recorder.Code, recorder.Header(), recorder.Body.Bytes()})
}
