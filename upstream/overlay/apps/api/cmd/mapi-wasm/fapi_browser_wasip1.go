//go:build wasip1 && mapi_oauth && mapi_fapi_browser_test

package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"runtime"
	"time"

	"github.com/go-jose/go-jose/v4"
	"github.com/zitadel/nextgen/internal/cloudflarewasm"
	"github.com/zitadel/nextgen/internal/mapioauth"
	"github.com/zitadel/nextgen/internal/secrets"
	"github.com/zitadel/nextgen/internal/service"
)

func privateBrowser(ctx context.Context, project, origin string) (*mapioauth.PrivatePAR, *mapioauth.PrivateFAPI, mapioauth.FAPILogin, error) {
	_, db, err := oauthComposition(ctx, project, origin)
	if err != nil {
		return nil, nil, mapioauth.FAPILogin{}, err
	}
	store := mapioauth.Store{DB: db, Transaction: cloudflarewasm.Transaction, Now: time.Now}
	p, err := mapioauth.NewPrivatePAR(mapioauth.PrivatePARConfig{ProjectID: project, Issuer: origin + "/oauth/" + project, Store: store, Pool: runtimePool})
	if err != nil {
		db.Close()
		return nil, nil, mapioauth.FAPILogin{}, err
	}
	composition, err := mapioauth.ComposePrivateFAPI(p, runtimePool, runtimeKeys)
	if err != nil {
		db.Close()
		return nil, nil, mapioauth.FAPILogin{}, err
	}
	login, err := mapioauth.ComposePrivateFAPILogin(p, runtimePool, runtimeTokens)
	if err != nil {
		db.Close()
		return nil, nil, mapioauth.FAPILogin{}, err
	}
	return p, composition, login, nil
}

//go:wasmexport mapi_fapi_browser_setup
func fapiBrowserSetup() uint64 {
	var args struct {
		ProjectID, Origin, RedirectURI string
		PublicKey, PublicKey2          json.RawMessage
	}
	if err := json.Unmarshal(input, &args); err != nil {
		return failure(err)
	}
	p, c, _, err := privateBrowser(context.Background(), args.ProjectID, args.Origin)
	if err != nil {
		return failure(err)
	}
	defer p.Store.DB.Close()
	if err = p.InitializeSchema(context.Background()); err != nil {
		return failure(err)
	}
	if _, err = c.Keys.Rotate(context.Background(), false); err != nil {
		return failure(err)
	}
	register := func(slug string, raw json.RawMessage) (string, error) {
		redirects := []string{args.RedirectURI, args.RedirectURI + "?dummy1=lorem&dummy2=ipsum"}
		document, err := json.Marshal(map[string]any{"slug": slug, "name": "FAPI Browser Test", "clients": []any{map[string]any{"slug": "web", "type": "confidential", "grant_types": []string{"authorization_code", "refresh_token"}, "redirect_uris": redirects}}})
		if err != nil {
			return "", err
		}
		apps := service.NewApplicationService(runtimePool, oauthSchemas, secrets.NewRandomSecretGenerator())
		app, err := apps.CreateOrRevise(context.Background(), args.ProjectID, document)
		if err != nil {
			return "", err
		}
		if len(app.Secrets) != 1 {
			return "", errors.New("missing client")
		}
		var key jose.JSONWebKey
		if err = json.Unmarshal(raw, &key); err != nil {
			return "", err
		}
		if err = p.Assertions.SetKeys(context.Background(), app.Secrets[0].ClientID, []jose.JSONWebKey{key}); err != nil {
			return "", err
		}
		if _, err = p.Policies.Put(context.Background(), app.Secrets[0].ClientID, args.Origin+"/oauth/"+args.ProjectID+"/resource", []string{"accounts"}, true, 0); err != nil {
			return "", err
		}
		return app.Secrets[0].ClientID, nil
	}
	client, err := register("fapi-browser-test", args.PublicKey)
	if err != nil {
		return failure(err)
	}
	result := map[string]string{"clientId": client, "issuer": p.Assertions.Issuer}
	if len(args.PublicKey2) > 0 {
		second, e := register("fapi-browser-test-2", args.PublicKey2)
		if e != nil {
			return failure(e)
		}
		result["clientId2"] = second
	}
	return marshal(result)
}

//go:wasmexport mapi_fapi_browser_request
func fapiBrowserRequest() uint64 {
	defer runtime.GC()
	var args struct {
		ProjectID, Origin string
		Request           request
	}
	if err := json.Unmarshal(input, &args); err != nil {
		return failure(err)
	}
	p, c, login, err := privateBrowser(context.Background(), args.ProjectID, args.Origin)
	if err != nil {
		return failure(err)
	}
	defer p.Store.DB.Close()
	r, err := http.NewRequest(args.Request.Method, args.Request.URL, bytes.NewReader(args.Request.Body))
	if err != nil {
		return failure(err)
	}
	if r.URL.Scheme != "https" || r.URL.Scheme+"://"+r.URL.Host != args.Origin {
		return failure(errors.New("invalid origin"))
	}
	for k, v := range args.Request.Headers {
		r.Header[http.CanonicalHeaderKey(k)] = v
	}
	w := httptest.NewRecorder()
	issuer := p.Assertions.Issuer
	loginHTTP := mapioauth.FAPILoginHTTP{Private: p, Login: login, Origin: args.Origin, Issuer: issuer}
	switch r.URL.Path {
	case "/oauth/" + args.ProjectID + "/par":
		mapioauth.FAPIPARHTTP{Private: p}.ServeHTTP(w, r)
	case "/oauth/" + args.ProjectID + "/authorize":
		loginHTTP.Authorize(w, r)
	case "/oauth/continue":
		mapioauth.FAPIConsentHTTP{Login: login, Origin: args.Origin, Issuer: issuer}.ServeHTTP(w, r)
	case "/oauth/" + args.ProjectID + "/token":
		mapioauth.FAPITokenHTTP{Exchange: c.Exchange}.ServeHTTP(w, r)
	case "/oauth/" + args.ProjectID + "/resource":
		rows, e := p.Store.DB.QueryContext(context.Background(), `SELECT client_id FROM mapi_fapi_client_policy WHERE project_id=? AND enabled=1`, args.ProjectID)
		if e != nil {
			return failure(e)
		}
		var allowed []string
		for rows.Next() {
			var client string
			if e = rows.Scan(&client); e != nil {
				rows.Close()
				return failure(e)
			}
			allowed = append(allowed, client)
		}
		if e = rows.Err(); e != nil {
			rows.Close()
			return failure(e)
		}
		rows.Close()
		mapioauth.FAPIResourceHTTP{Tokens: c.Tokens, ResourceURL: issuer + "/resource", Policy: mapioauth.FAPIResourcePolicy{Audience: issuer + "/resource", AllowedClients: allowed, RequiredScopes: []string{"accounts"}}}.ServeHTTP(w, r)
	case "/oauth/" + args.ProjectID + "/revoke":
		mapioauth.FAPIRevocationHTTP{Revoker: c.Revocation}.ServeHTTP(w, r)
	case "/oauth/" + args.ProjectID + "/jwks":
		keys, e := c.Keys.PublicKeys(context.Background())
		if e != nil {
			return failure(e)
		}
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		_ = json.NewEncoder(w).Encode(keys)
	case "/oauth/" + args.ProjectID + "/.well-known/openid-configuration":
		// Local test metadata only; it does not assert final-profile conformance.
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		_ = json.NewEncoder(w).Encode(map[string]any{"issuer": issuer, "authorization_endpoint": issuer + "/authorize", "token_endpoint": issuer + "/token", "pushed_authorization_request_endpoint": issuer + "/par", "jwks_uri": issuer + "/jwks", "scopes_supported": []string{"openid", "offline_access", "accounts"}, "response_types_supported": []string{"code"}, "grant_types_supported": []string{"authorization_code", "refresh_token"}, "subject_types_supported": []string{"public"}, "id_token_signing_alg_values_supported": []string{"ES256"}, "token_endpoint_auth_methods_supported": []string{"private_key_jwt"}, "token_endpoint_auth_signing_alg_values_supported": []string{"ES256"}, "code_challenge_methods_supported": []string{"S256"}, "require_pushed_authorization_requests": true, "dpop_signing_alg_values_supported": []string{"ES256"}, "authorization_response_iss_parameter_supported": true})
	default:
		return failure(errors.New("unsupported test route"))
	}
	return marshal(response{w.Code, w.Header(), w.Body.Bytes()})
}
