//go:build wasip1 && mapi_oauth && mapi_flow && mapi_fapi_app_test

package main

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"

	"github.com/go-jose/go-jose/v4"
	"github.com/go-jose/go-jose/v4/jwt"
	"github.com/zitadel/nextgen/internal/cloudflarewasm"
	"github.com/zitadel/nextgen/internal/mapioauth"
	"github.com/zitadel/nextgen/internal/secrets"
	"github.com/zitadel/nextgen/internal/service"
	"time"
)

//go:wasmexport mapi_fapi_reload_probe
func fapiReloadProbe() uint64 {
	var args struct{ ProjectID, Origin, SessionCredential string }
	if err := json.Unmarshal(input, &args); err != nil {
		return failure(err)
	}
	ctx := context.Background()
	_, db, err := oauthComposition(ctx, args.ProjectID, args.Origin)
	if err != nil {
		return failure(err)
	}
	defer db.Close()
	apps := service.NewApplicationService(runtimePool, oauthSchemas, secrets.NewRandomSecretGenerator())
	app, err := apps.CreateOrRevise(ctx, args.ProjectID, []byte(`{"slug":"fapi-reload-test","name":"FAPI reload test","clients":[{"slug":"web","type":"confidential","grant_types":["authorization_code"],"redirect_uris":["https://rp.example/callback"]}]}`))
	if err != nil || len(app.Secrets) != 1 {
		return failure(errors.New("reload client unavailable"))
	}
	client := app.Secrets[0].ClientID
	store := mapioauth.Store{DB: db, Transaction: cloudflarewasm.Transaction, Now: time.Now}
	p, err := mapioauth.NewPrivatePAR(mapioauth.PrivatePARConfig{ProjectID: args.ProjectID, Issuer: args.Origin + "/oauth/" + args.ProjectID, Store: store, Pool: runtimePool})
	if err != nil {
		return failure(err)
	}
	if err = p.InitializeSchema(ctx); err != nil {
		return failure(err)
	}
	if _, err = p.Policies.Put(ctx, client, client, nil, true, 0); err != nil {
		return failure(err)
	}
	public, key, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return failure(err)
	}
	if err = p.Assertions.SetKeys(ctx, client, []jose.JSONWebKey{{Key: public, KeyID: "reload-client", Algorithm: "EdDSA", Use: "sig"}}); err != nil {
		return failure(err)
	}
	signer, err := jose.NewSigner(jose.SigningKey{Algorithm: jose.EdDSA, Key: &jose.JSONWebKey{Key: key, KeyID: "reload-client"}}, nil)
	if err != nil {
		return failure(err)
	}
	assertion := func(id string) (string, error) {
		return jwt.Signed(signer).Claims(map[string]any{"iss": client, "sub": client, "aud": p.Assertions.Issuer, "jti": id, "exp": time.Now().Add(time.Minute).Unix()}).Serialize()
	}
	verifier := "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~"
	digest := sha256.Sum256([]byte(verifier))
	makePAR := func(id string) (string, error) {
		a, e := assertion(id)
		if e != nil {
			return "", e
		}
		values := url.Values{"client_id": {client}, "client_assertion_type": {"urn:ietf:params:oauth:client-assertion-type:jwt-bearer"}, "client_assertion": {a}, "response_type": {"code"}, "redirect_uri": {"https://rp.example/callback"}, "scope": {"openid"}, "code_challenge": {base64.RawURLEncoding.EncodeToString(digest[:])}, "code_challenge_method": {"S256"}}
		r := httptest.NewRequest(http.MethodPost, p.PAR.Endpoint, strings.NewReader(values.Encode()))
		return p.PAR.Push(ctx, r, values)
	}
	login, err := mapioauth.ComposePrivateFAPILogin(p, runtimePool, runtimeTokens)
	if err != nil {
		return failure(err)
	}
	browser := mapioauth.FAPILoginHTTP{Private: p, Login: login, Origin: args.Origin, Issuer: p.Assertions.Issuer}
	authorize := func(uri, session string, cookies ...*http.Cookie) *httptest.ResponseRecorder {
		q := url.Values{"client_id": {client}, "request_uri": {uri}}
		r := httptest.NewRequest(http.MethodGet, p.Assertions.Issuer+"/authorize?"+q.Encode(), nil)
		for _, c := range cookies {
			r.AddCookie(c)
		}
		if session != "" {
			r.AddCookie(&http.Cookie{Name: "__Host-zitadel_session", Value: session})
		}
		w := httptest.NewRecorder()
		browser.Authorize(w, r)
		return w
	}
	uri, err := makePAR("reload-first")
	if err != nil {
		return failure(err)
	}
	first := authorize(uri, args.SessionCredential)
	if first.Code != 303 {
		return failure(errors.New("initial reload authorization failed"))
	}
	var reload, binding *http.Cookie
	for _, c := range first.Result().Cookies() {
		if strings.HasPrefix(c.Name, "__Host-mapi-par-") {
			reload = c
		}
		if strings.HasPrefix(c.Name, "__Host-mapi-oauth-") {
			binding = c
		}
		if !c.Secure || !c.HttpOnly {
			return failure(errors.New("insecure reload cookie"))
		}
	}
	if reload == nil || binding == nil {
		return failure(errors.New("missing reload cookies"))
	}
	if w := authorize(uri, args.SessionCredential); w.Code != 400 {
		return failure(errors.New("different browser resumed"))
	}
	if w := authorize(uri, args.SessionCredential, reload); w.Code != 400 {
		return failure(errors.New("missing binding resumed"))
	}
	if w := authorize(uri, "invalid-session", reload, binding); w.Code != 400 {
		return failure(errors.New("different session resumed"))
	}
	for i := 0; i < 4; i++ {
		w := authorize(uri, args.SessionCredential, reload, binding)
		if w.Code != 303 || w.Header().Get("Location") != first.Header().Get("Location") {
			return failure(errors.New("same browser reload changed flow"))
		}
	}
	var count int
	if err = db.QueryRowContext(ctx, `SELECT COUNT(*) FROM mapi_fapi_logins WHERE project_id=? AND client_id=?`, args.ProjectID, client).Scan(&count); err != nil || count != 1 {
		return failure(errors.New("reload created multiple logins"))
	}
	if _, err = login.Complete(ctx, reload.Value, binding.Value, args.SessionCredential); err != nil {
		return failure(err)
	}
	if w := authorize(uri, args.SessionCredential, reload, binding); w.Code != 400 {
		return failure(errors.New("completed login resumed"))
	}
	uri, err = makePAR("reload-policy")
	if err != nil {
		return failure(err)
	}
	first = authorize(uri, "")
	if first.Code != 303 {
		return failure(errors.New("anonymous reload authorization failed"))
	}
	reload = nil
	binding = nil
	for _, c := range first.Result().Cookies() {
		if strings.HasPrefix(c.Name, "__Host-mapi-par-") {
			reload = c
		}
		if strings.HasPrefix(c.Name, "__Host-mapi-oauth-") {
			binding = c
		}
	}
	if reload == nil || binding == nil {
		return failure(errors.New("anonymous reload cookies missing"))
	}
	if w := authorize(uri, args.SessionCredential, reload, binding); w.Code != 303 {
		return failure(errors.New("first session binding failed"))
	}
	policy, err := p.Policies.Get(ctx, client)
	if err != nil {
		return failure(err)
	}
	policy, err = p.Policies.Put(ctx, client, policy.Audience, policy.Scopes, false, policy.Version)
	if err != nil {
		return failure(err)
	}
	if _, err = p.Policies.Put(ctx, client, policy.Audience, policy.Scopes, true, policy.Version); err != nil {
		return failure(err)
	}
	if w := authorize(uri, args.SessionCredential, reload, binding); w.Code != 400 {
		return failure(errors.New("revoked policy resumed login"))
	}
	return marshal(map[string]any{"ok": true})
}
