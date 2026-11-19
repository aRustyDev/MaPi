//go:build wasip1 && mapi_oauth && mapi_profiles_browser_test

package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"runtime"
	"strings"
	"time"

	"github.com/go-jose/go-jose/v4"
	"github.com/zitadel/nextgen/internal/cloudflarewasm"
	"github.com/zitadel/nextgen/internal/mapioauth"
	"github.com/zitadel/nextgen/internal/secrets"
	"github.com/zitadel/nextgen/internal/service"
)

func profilesBrowser(ctx context.Context, project, origin string) (*mapioauth.IsolatedProfiles, mapioauth.FAPILogin, error) {
	_, db, err := oauthComposition(ctx, project, origin)
	if err != nil {
		return nil, mapioauth.FAPILogin{}, err
	}
	store := mapioauth.Store{DB: db, Transaction: cloudflarewasm.Transaction, Now: time.Now}
	profiles, err := mapioauth.ComposeIsolatedProfiles(mapioauth.Config{ProjectID: project, Origin: origin, Store: store, Pool: runtimePool, Keys: runtimeKeys, Tokens: runtimeTokens, Schemas: oauthSchemas})
	if err != nil {
		db.Close()
		return nil, mapioauth.FAPILogin{}, err
	}
	profiles.FAPIScopes = []string{"openid", "offline_access", "accounts"}
	login, err := mapioauth.ComposePrivateFAPILogin(profiles.Private, runtimePool, runtimeTokens)
	if err != nil {
		db.Close()
		return nil, mapioauth.FAPILogin{}, err
	}
	return profiles, login, nil
}

//go:wasmexport mapi_profiles_browser_setup
func profilesBrowserSetup() uint64 {
	var a struct {
		ProjectID, Origin, RedirectURI string
		PublicKey, PublicKey2          json.RawMessage
	}
	if err := json.Unmarshal(input, &a); err != nil {
		return failure(err)
	}
	ctx := context.Background()
	profiles, _, err := profilesBrowser(ctx, a.ProjectID, a.Origin)
	if err != nil {
		return failure(err)
	}
	defer profiles.Private.Store.DB.Close()
	if err = profiles.InitializeSchema(ctx); err != nil {
		return failure(err)
	}
	if _, err = profiles.Bearer.Admin.EnsureSigningKey(ctx); err != nil {
		return failure(err)
	}
	if _, err = profiles.FAPI.Keys.Rotate(ctx, false); err != nil {
		return failure(err)
	}
	register := func(slug, profile string) (string, string, error) {
		document, e := json.Marshal(map[string]any{"slug": slug, "name": "Local Profile Test", "clients": []any{map[string]any{"slug": "web", "type": "confidential", "grant_types": []string{"authorization_code", "refresh_token"}, "redirect_uris": []string{a.RedirectURI, a.RedirectURI + "?dummy1=lorem&dummy2=ipsum"}}}})
		if e != nil {
			return "", "", e
		}
		apps := service.NewApplicationService(runtimePool, oauthSchemas, secrets.NewRandomSecretGenerator())
		app, e := apps.CreateOrRevise(ctx, a.ProjectID, document)
		if e != nil {
			return "", "", e
		}
		if len(app.Secrets) != 1 {
			return "", "", errors.New("missing test client")
		}
		entry := app.Secrets[0]
		if e = profiles.Clients.Assign(ctx, entry.ClientID, profile); e != nil {
			return "", "", e
		}
		return entry.ClientID, entry.Secret, nil
	}
	addFAPI := func(slug string, raw json.RawMessage) (string, error) {
		fapi, _, err := register(slug, "fapi")
		if err != nil {
			return "", err
		}
		var key jose.JSONWebKey
		if err = json.Unmarshal(raw, &key); err != nil {
			return "", err
		}
		if err = profiles.Private.Assertions.SetKeys(ctx, fapi, []jose.JSONWebKey{key}); err != nil {
			return "", err
		}
		if _, err = profiles.Private.Policies.Put(ctx, fapi, a.Origin+"/fapi/"+a.ProjectID+"/resource", []string{"accounts"}, true, 0); err != nil {
			return "", err
		}
		return fapi, nil
	}
	fapi, err := addFAPI("local-fapi", a.PublicKey)
	if err != nil {
		return failure(err)
	}
	var fapi2 string
	if len(a.PublicKey2) > 0 {
		fapi2, err = addFAPI("local-fapi-2", a.PublicKey2)
		if err != nil {
			return failure(err)
		}
	}

	bearer, secret, err := register("local-bearer", "bearer")
	if err != nil {
		return failure(err)
	}
	return marshal(map[string]string{"clientId": fapi, "issuer": profiles.Private.Assertions.Issuer, "bearerClientId": bearer, "bearerSecret": secret, "bearerIssuer": profiles.Bearer.Issuer, "clientId2": fapi2})
}

//go:wasmexport mapi_profiles_browser_request
func profilesBrowserRequest() uint64 {
	defer runtime.GC()
	var a struct {
		ProjectID, Origin string
		Request           request
	}
	if err := json.Unmarshal(input, &a); err != nil {
		return failure(err)
	}
	ctx := context.Background()
	p, login, err := profilesBrowser(ctx, a.ProjectID, a.Origin)
	if err != nil {
		return failure(err)
	}
	defer p.Private.Store.DB.Close()
	r, err := http.NewRequest(a.Request.Method, a.Request.URL, bytes.NewReader(a.Request.Body))
	if err != nil {
		return failure(err)
	}
	if r.URL.Scheme != "https" || r.URL.Scheme+"://"+r.URL.Host != a.Origin {
		return failure(errors.New("wrong origin"))
	}
	for k, v := range a.Request.Headers {
		r.Header[http.CanonicalHeaderKey(k)] = v
	}
	w := httptest.NewRecorder()
	issuer := p.Private.Assertions.Issuer
	switch r.URL.Path {
	case "/fapi/" + a.ProjectID + "/par":
		mapioauth.FAPIPARHTTP{Private: p.Private}.ServeHTTP(w, r)
	case "/fapi/" + a.ProjectID + "/authorize":
		mapioauth.FAPILoginHTTP{Private: p.Private, Login: login, Origin: a.Origin, Issuer: issuer}.Authorize(w, r)
	case "/fapi/continue":
		mapioauth.FAPIConsentHTTP{Login: login, Origin: a.Origin, Issuer: issuer}.ServeHTTP(w, r)
	case "/fapi/" + a.ProjectID + "/token":
		mapioauth.FAPITokenHTTP{Exchange: p.FAPI.Exchange}.ServeHTTP(w, r)
	case "/fapi/" + a.ProjectID + "/revoke":
		mapioauth.FAPIRevocationHTTP{Revoker: p.FAPI.Revocation}.ServeHTTP(w, r)
	case "/fapi/" + a.ProjectID + "/resource":
		rows, e := p.Private.Store.DB.QueryContext(ctx, `SELECT client_id FROM mapi_isolated_profile_clients WHERE project_id=? AND profile='fapi'`, a.ProjectID)
		if e != nil {
			return failure(e)
		}
		var clients []string
		for rows.Next() {
			var client string
			if e = rows.Scan(&client); e != nil {
				rows.Close()
				return failure(e)
			}
			clients = append(clients, client)
		}
		if e = rows.Err(); e != nil {
			rows.Close()
			return failure(e)
		}
		rows.Close()
		mapioauth.FAPIResourceHTTP{Tokens: p.FAPI.Tokens, ResourceURL: issuer + "/resource", Policy: mapioauth.FAPIResourcePolicy{Audience: issuer + "/resource", AllowedClients: clients, RequiredScopes: []string{"accounts"}}}.ServeHTTP(w, r)
	case "/fapi/" + a.ProjectID + "/jwks":
		keys, e := p.FAPI.Keys.PublicKeys(ctx)
		if e != nil {
			return failure(e)
		}
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		_ = json.NewEncoder(w).Encode(keys)
	case "/fapi/" + a.ProjectID + "/.well-known/openid-configuration":
		p.FAPIDiscovery(w, r)
	case "/oauth/continue":
		p.Bearer.Login.ServeHTTP(w, r)
	case "/oauth/" + a.ProjectID + "/authorize", "/oauth/" + a.ProjectID + "/token", "/oauth/" + a.ProjectID + "/jwks", "/oauth/" + a.ProjectID + "/userinfo", "/oauth/" + a.ProjectID + "/revoke":
		r.URL.Path = strings.TrimPrefix(r.URL.Path, "/oauth/"+a.ProjectID)
		p.Bearer.Provider.Handler().ServeHTTP(w, r)
	default:
		return failure(errors.New("unsupported private profile test route"))
	}
	return marshal(response{w.Code, w.Header(), w.Body.Bytes()})
}
