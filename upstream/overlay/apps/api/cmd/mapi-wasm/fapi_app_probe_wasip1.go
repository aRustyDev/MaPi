//go:build wasip1 && mapi_oauth && mapi_fapi_app_test

package main

import (
	"context"
	"crypto"
	"crypto/ecdsa"
	"crypto/ed25519"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"time"

	"github.com/go-jose/go-jose/v4"
	"github.com/go-jose/go-jose/v4/jwt"
	"github.com/zitadel/nextgen/internal/cloudflarewasm"
	"github.com/zitadel/nextgen/internal/domain"
	"github.com/zitadel/nextgen/internal/mapidpop"
	"github.com/zitadel/nextgen/internal/mapioauth"
	"github.com/zitadel/nextgen/internal/secrets"
	"github.com/zitadel/nextgen/internal/service"
)

// Test-only entry: credentials are synthesized locally, and it has no HTTP mount.
//
//go:wasmexport mapi_fapi_app_probe
func fapiAppProbe() uint64 {
	var args struct {
		ProjectID, Origin, SessionCredential, UserID, SessionID string
		ProoflessPAR                                            bool
	}
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
	app, err := apps.CreateOrRevise(ctx, args.ProjectID, []byte(`{"slug":"fapi-app-test","name":"FAPI App Test","clients":[{"slug":"web","type":"confidential","grant_types":["authorization_code","refresh_token"],"redirect_uris":["https://rp.example/callback"]}]}`))
	if err != nil {
		return failure(err)
	}
	if len(app.Secrets) != 1 {
		return failure(errors.New("missing FAPI test client"))
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
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return failure(err)
	}
	if err = p.Assertions.SetKeys(ctx, client, []jose.JSONWebKey{{Key: pub, KeyID: "test-client", Algorithm: "EdDSA", Use: "sig"}}); err != nil {
		return failure(err)
	}
	signer, err := jose.NewSigner(jose.SigningKey{Algorithm: jose.EdDSA, Key: &jose.JSONWebKey{Key: priv, KeyID: "test-client"}}, nil)
	if err != nil {
		return failure(err)
	}
	assertion := func(id string) (string, error) {
		return jwt.Signed(signer).Claims(map[string]any{"iss": client, "sub": client, "aud": p.Assertions.Issuer, "jti": id, "exp": time.Now().Add(time.Minute).Unix()}).Serialize()
	}
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return failure(err)
	}
	jwk := jose.JSONWebKey{Key: &key.PublicKey}
	thumb, err := jwk.Thumbprint(crypto.SHA256)
	if err != nil {
		return failure(err)
	}
	jkt := base64.RawURLEncoding.EncodeToString(thumb)
	dpop, err := jose.NewSigner(jose.SigningKey{Algorithm: jose.ES256, Key: key}, (&jose.SignerOptions{}).WithHeader("typ", "dpop+jwt").WithHeader("jwk", jwk))
	if err != nil {
		return failure(err)
	}
	proof := func(id, endpoint, nonce string) (string, error) {
		return jwt.Signed(dpop).Claims(map[string]any{"jti": id, "htm": "POST", "htu": endpoint, "iat": time.Now().Unix(), "nonce": nonce}).Serialize()
	}
	composed, err := mapioauth.ComposePrivateFAPI(p, runtimePool, runtimeKeys)
	if err != nil {
		return failure(err)
	}
	if _, err = composed.Keys.Rotate(ctx, false); err != nil {
		return failure(err)
	}
	login, err := mapioauth.ComposePrivateFAPILogin(p, runtimePool, runtimeTokens)
	if err != nil {
		return failure(err)
	}
	verifier := "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~"
	hash := sha256.Sum256([]byte(verifier))
	as, err := assertion("app-par")
	if err != nil {
		return failure(err)
	}
	form := url.Values{"client_id": {client}, "client_assertion_type": {"urn:ietf:params:oauth:client-assertion-type:jwt-bearer"}, "client_assertion": {as}, "response_type": {"code"}, "redirect_uri": {"https://rp.example/callback"}, "scope": {"openid offline_access"}, "state": {"app-state"}, "nonce": {"app-nonce"}, "code_challenge": {base64.RawURLEncoding.EncodeToString(hash[:])}, "code_challenge_method": {"S256"}, "dpop_jkt": {jkt}}
	post := func(h http.Handler, endpoint string, form url.Values, raw string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(http.MethodPost, endpoint, strings.NewReader(form.Encode()))
		r.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		if raw != "" {
			r.Header.Set("DPoP", raw)
		}
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		return w
	}
	parHandler := mapioauth.FAPIPARHTTP{Private: p}
	var raw, nonce string
	var w *httptest.ResponseRecorder
	emptyForm := make(url.Values, len(form))
	for k, v := range form {
		emptyForm[k] = append([]string(nil), v...)
	}
	emptyForm.Set("dpop_jkt", "")
	if w := post(parHandler, p.PAR.Endpoint, emptyForm, ""); w.Code != 400 {
		return failure(errors.New("empty PAR JKT accepted"))
	}
	emptyHeader := httptest.NewRequest(http.MethodPost, p.PAR.Endpoint, strings.NewReader(form.Encode()))
	emptyHeader.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	emptyHeader.Header.Set("DPoP", "")
	emptyResponse := httptest.NewRecorder()
	parHandler.ServeHTTP(emptyResponse, emptyHeader)
	if emptyResponse.Code != 400 {
		return failure(errors.New("empty PAR DPoP header accepted"))
	}
	// When both mechanisms are present, their keys must match. Failure must
	// roll back client assertion and proof replay records for the real retry.
	other := sha256.Sum256([]byte("different PAR key"))
	mismatchForm := make(url.Values, len(form))
	for k, v := range form {
		mismatchForm[k] = append([]string(nil), v...)
	}
	mismatchForm.Set("dpop_jkt", base64.RawURLEncoding.EncodeToString(other[:]))
	parNonce, err := p.Nonces.Issue(ctx, mapidpop.NonceScope{ProjectID: args.ProjectID, ClientID: client, Purpose: "par"})
	if err != nil {
		return failure(err)
	}
	mismatchedProof, err := proof("app-par-mismatch", p.PAR.Endpoint, parNonce)
	if err != nil {
		return failure(err)
	}
	mismatch := post(parHandler, p.PAR.Endpoint, mismatchForm, mismatchedProof)
	if mismatch.Code != 400 || mismatch.Header().Get("DPoP-Nonce") != "" {
		return failure(errors.New("mismatched PAR binding accepted"))
	}
	if args.ProoflessPAR {
		// RFC 9449 permits a PAR key commitment without a PAR proof.
		w = post(parHandler, p.PAR.Endpoint, form, "")
		if w.Header().Get("DPoP-Nonce") != "" {
			return failure(errors.New("proofless PAR unexpectedly challenged"))
		}
	} else {
		// Header-only PAR must bind the code to the verified proof key.
		form.Del("dpop_jkt")
		raw, err = proof("app-par-proof", p.PAR.Endpoint, "")
		if err != nil {
			return failure(err)
		}
		w = post(parHandler, p.PAR.Endpoint, form, raw)
		nonce = w.Header().Get("DPoP-Nonce")
		if w.Code != 400 || nonce == "" {
			return failure(fmt.Errorf("PAR challenge failed: %d", w.Code))
		}
		raw, err = proof("app-par-proof", p.PAR.Endpoint, nonce)
		if err != nil {
			return failure(err)
		}
		w = post(parHandler, p.PAR.Endpoint, form, raw)
	}
	var pr struct {
		RequestURI string `json:"request_uri"`
	}
	if w.Code != 201 || json.Unmarshal(w.Body.Bytes(), &pr) != nil || pr.RequestURI == "" {
		return failure(fmt.Errorf("PAR retry failed: %d", w.Code))
	}
	// A failure after writing the login audit rolls the login and PAR consume back.
	injected := errors.New("injected audit rollback")
	broken := login
	originalAudit := login.Audit
	broken.Audit = func(ctx context.Context, op string, g mapioauth.AuthorizationCode, jkt string) error {
		if e := originalAudit(ctx, op, g, jkt); e != nil {
			return e
		}
		return injected
	}
	begin := func(l mapioauth.FAPILogin) (string, string, error) {
		var handle, binding string
		e := p.PAR.Consume(ctx, args.ProjectID, client, pr.RequestURI, func(ctx context.Context, req mapioauth.PushedAuthorizationRequest) error {
			if req.DPoPJKT != jkt {
				return errors.New("PAR key commitment lost")
			}
			var e error
			handle, binding, e = l.BeginInTransaction(ctx, req)
			return e
		})
		return handle, binding, e
	}
	var loginAuditBefore int
	if err = db.QueryRowContext(ctx, `SELECT count(*) FROM events WHERE project_id=? AND event_type='mapi.fapi.login_started'`, args.ProjectID).Scan(&loginAuditBefore); err != nil {
		return failure(err)
	}
	if _, _, err = begin(broken); !errors.Is(err, injected) {
		return failure(errors.New("PAR login rollback failed"))
	}
	var loginAuditAfter int
	if err = db.QueryRowContext(ctx, `SELECT count(*) FROM events WHERE project_id=? AND event_type='mapi.fapi.login_started'`, args.ProjectID).Scan(&loginAuditAfter); err != nil || loginAuditAfter != loginAuditBefore {
		return failure(errors.New("failed login audit persisted"))
	}
	var count int
	if err = db.QueryRowContext(ctx, "SELECT count(*) FROM mapi_fapi_logins WHERE project_id=? AND client_id=?", args.ProjectID, client).Scan(&count); err != nil || count != 0 {
		return failure(errors.New("partial login survived rollback"))
	}
	handle, binding, err := begin(login)
	if err != nil {
		return failure(err)
	}
	if _, _, err = begin(login); !errors.Is(err, mapioauth.ErrInvalidPAR) {
		return failure(errors.New("PAR replay accepted"))
	}
	if _, err = login.Complete(ctx, handle, "bad", args.SessionCredential); err == nil {
		return failure(errors.New("bad browser binding accepted"))
	}
	if _, err = login.Complete(ctx, handle, binding, "bad"); err == nil {
		return failure(errors.New("bad upstream session accepted"))
	}
	completed, err := login.Complete(ctx, handle, binding, args.SessionCredential)
	if err != nil {
		return failure(err)
	}
	if _, err = login.Complete(ctx, handle, binding, args.SessionCredential); err == nil {
		return failure(errors.New("login replay accepted"))
	}
	as, err = assertion("app-token")
	if err != nil {
		return failure(err)
	}
	tokenForm := url.Values{"grant_type": {"authorization_code"}, "client_id": {client}, "client_assertion_type": {"urn:ietf:params:oauth:client-assertion-type:jwt-bearer"}, "client_assertion": {as}, "code": {completed.Code}, "redirect_uri": {"https://rp.example/callback"}, "code_verifier": {verifier}}
	endpoint := p.Assertions.Issuer + "/token"
	raw, err = proof("app-token-proof", endpoint, "")
	if err != nil {
		return failure(err)
	}
	tokenHandler := mapioauth.FAPITokenHTTP{Exchange: composed.Exchange}
	if missing := post(tokenHandler, endpoint, tokenForm, ""); missing.Code != 400 || missing.Header().Get("DPoP-Nonce") != "" {
		return failure(errors.New("token exchange without proof accepted"))
	}
	w = post(tokenHandler, endpoint, tokenForm, raw)
	nonce = w.Header().Get("DPoP-Nonce")
	if w.Code != 400 || nonce == "" {
		return failure(fmt.Errorf("token challenge failed: %d", w.Code))
	}
	raw, err = proof("app-token-proof", endpoint+"?ignored=yes#fragment", nonce)
	if err != nil {
		return failure(err)
	}
	missingVerifier := url.Values{}
	for key, values := range tokenForm {
		missingVerifier[key] = append([]string(nil), values...)
	}
	missingVerifier.Del("code_verifier")
	if missing := post(tokenHandler, endpoint, missingVerifier, raw); missing.Code != 400 || !strings.Contains(missing.Body.String(), "invalid_grant") {
		return failure(errors.New("missing PKCE verifier did not return invalid_grant"))
	}
	// A valid proof for a different key cannot redeem the bound code. The
	// failed transaction must leave the original assertion and code usable.
	wrongKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return failure(err)
	}
	wrongSigner, err := jose.NewSigner(jose.SigningKey{Algorithm: jose.ES256, Key: wrongKey}, (&jose.SignerOptions{}).WithHeader("typ", "dpop+jwt").WithHeader("jwk", jose.JSONWebKey{Key: &wrongKey.PublicKey}))
	if err != nil {
		return failure(err)
	}
	wrongProof, err := jwt.Signed(wrongSigner).Claims(map[string]any{"jti": "app-wrong-key", "htm": "POST", "htu": endpoint, "iat": time.Now().Unix(), "nonce": nonce}).Serialize()
	if err != nil {
		return failure(err)
	}
	if w = post(tokenHandler, endpoint, tokenForm, wrongProof); w.Code != 400 || w.Header().Get("DPoP-Nonce") != "" {
		return failure(errors.New("wrong DPoP key accepted or leaked challenge"))
	}
	var auditBefore int
	if err = db.QueryRowContext(ctx, `SELECT count(*) FROM events WHERE project_id=? AND event_type IN ('mapi.fapi.token.exchanged','auth.token.issued','mapi.fapi.id_token.issued')`, args.ProjectID).Scan(&auditBefore); err != nil {
		return failure(err)
	}
	badExchange := composed.Exchange
	orig := badExchange.Audit
	badExchange.Audit = func(ctx context.Context, g mapioauth.FAPIExchangeGrant) error {
		if e := orig(ctx, g); e != nil {
			return e
		}
		return injected
	}
	if w = post(mapioauth.FAPITokenHTTP{Exchange: badExchange}, endpoint, tokenForm, raw); w.Code != 500 {
		return failure(errors.New("token audit rollback failed"))
	}
	var auditAfter int
	if err = db.QueryRowContext(ctx, `SELECT count(*) FROM events WHERE project_id=? AND event_type IN ('mapi.fapi.token.exchanged','auth.token.issued','mapi.fapi.id_token.issued')`, args.ProjectID).Scan(&auditAfter); err != nil || auditBefore != auditAfter {
		return failure(errors.New("failed token audit persisted"))
	}
	w = post(tokenHandler, endpoint, tokenForm, raw)
	if w.Code != 200 {
		return failure(fmt.Errorf("token retry failed: %d %s", w.Code, w.Body.String()))
	}
	var tokens struct {
		AccessToken  string `json:"access_token"`
		IDToken      string `json:"id_token"`
		TokenType    string `json:"token_type"`
		RefreshToken string `json:"refresh_token"`
	}
	if json.Unmarshal(w.Body.Bytes(), &tokens) != nil || tokens.AccessToken == "" || tokens.IDToken == "" || tokens.RefreshToken == "" || tokens.TokenType != "DPoP" {
		return failure(errors.New("missing DPoP tokens"))
	}
	as, err = assertion("app-proof-replay")
	if err != nil {
		return failure(err)
	}
	tokenForm.Set("client_assertion", as)
	if replay := post(tokenHandler, endpoint, tokenForm, raw); replay.Code != 400 || !strings.Contains(replay.Body.String(), "invalid_dpop_proof") {
		return failure(errors.New("token proof replay accepted"))
	}
	as, err = assertion("app-token-replay")
	if err != nil {
		return failure(err)
	}
	tokenForm.Set("client_assertion", as)
	raw, err = proof("app-token-replay", endpoint, nonce)
	if err != nil {
		return failure(err)
	}
	if post(tokenHandler, endpoint, tokenForm, raw).Code == 200 {
		return failure(errors.New("code replay accepted"))
	}
	for _, eventType := range []string{"mapi.fapi.login_started", "mapi.fapi.code_issued", "mapi.fapi.token.exchanged"} {
		if err = db.QueryRowContext(ctx, `SELECT count(*) FROM events WHERE project_id=? AND event_type=? AND entity_id=?`, args.ProjectID, eventType, client).Scan(&count); err != nil || count != 1 {
			return failure(fmt.Errorf("missing committed audit %s", eventType))
		}
	}
	// Verify the actual signed ID token and authoritative subject/session.
	idJWT, err := jwt.ParseSigned(tokens.IDToken, []jose.SignatureAlgorithm{jose.ES256})
	if err != nil || len(idJWT.Headers) != 1 {
		return failure(errors.New("invalid ID token"))
	}
	keys, err := composed.Keys.PublicKeys(ctx)
	if err != nil {
		return failure(err)
	}
	matched := keys.Key(idJWT.Headers[0].KeyID)
	if len(matched) != 1 {
		return failure(errors.New("ID signing key missing"))
	}
	var idClaims struct {
		jwt.Claims
		Nonce     string `json:"nonce"`
		SessionID string `json:"sid"`
	}
	if err = idJWT.Claims(matched[0].Key, &idClaims); err != nil {
		return failure(fmt.Errorf("ID signature: %w", err))
	}
	if err = idClaims.ValidateWithLeeway(jwt.Expected{Issuer: p.Assertions.Issuer, AnyAudience: jwt.Audience{client}, Time: time.Now()}, 0); err != nil {
		return failure(fmt.Errorf("ID standard claims: %w", err))
	}
	if idClaims.Subject != args.UserID {
		return failure(errors.New("ID subject differs from upstream session"))
	}
	if idClaims.SessionID != args.SessionID {
		return failure(fmt.Errorf("ID session differs from upstream session, expected present: %t", args.SessionID != ""))
	}
	if idClaims.Nonce != "app-nonce" {
		return failure(errors.New("ID nonce differs"))
	}
	// Resource validation checks proof signature, ath, key binding and current
	// authoritative session; its replay record commits with its audit record.
	resourceURL := "https://resource.example/profile"
	resourceNonce, err := p.Nonces.Issue(ctx, mapidpop.NonceScope{ProjectID: args.ProjectID, ClientID: client, Purpose: "resource"})
	if err != nil {
		return failure(err)
	}
	accessHash := sha256.Sum256([]byte(tokens.AccessToken))
	ath := base64.RawURLEncoding.EncodeToString(accessHash[:])
	resourceProof := func(id string) (string, error) {
		return jwt.Signed(dpop).Claims(map[string]any{"jti": id, "htm": "GET", "htu": resourceURL + "?ignored=yes#fragment", "iat": time.Now().Unix(), "nonce": resourceNonce, "ath": ath}).Serialize()
	}
	raw, err = resourceProof("app-resource")
	if err != nil {
		return failure(err)
	}
	identity, err := composed.Tokens.ValidateResource(ctx, tokens.AccessToken, raw, "GET", resourceURL, client)
	if err != nil || identity.Subject != args.UserID || identity.SessionID != args.SessionID {
		return failure(errors.New("resource/session binding failed"))
	}
	if _, err = composed.Tokens.ValidateResource(ctx, tokens.AccessToken, raw, "GET", resourceURL, client); err == nil {
		return failure(errors.New("resource replay accepted"))
	}
	// Refresh accepts an equivalent or narrower scope but never expands it,
	// rotates the refresh token or weakens sender binding.
	refreshAssertion, err := assertion("refresh-scope-assertion")
	if err != nil {
		return failure(err)
	}
	refreshProof, err := proof("refresh-scope-proof", endpoint, nonce)
	if err != nil {
		return failure(err)
	}
	refreshValues := url.Values{"grant_type": {"refresh_token"}, "client_assertion_type": {"urn:ietf:params:oauth:client-assertion-type:jwt-bearer"}, "client_assertion": {refreshAssertion}, "refresh_token": {tokens.RefreshToken}, "scope": {"openid payments.write"}}
	if response := post(tokenHandler, endpoint, refreshValues, refreshProof); response.Code != 400 || !strings.Contains(response.Body.String(), "invalid_scope") {
		return failure(errors.New("expanded refresh scope accepted"))
	}
	refreshValues.Set("scope", "offline_access openid")
	refreshResponse := post(tokenHandler, endpoint, refreshValues, refreshProof)
	if refreshResponse.Code != 200 {
		return failure(errors.New("equivalent refresh scope rejected"))
	}
	var refreshBody struct {
		Scope   string `json:"scope"`
		Refresh string `json:"refresh_token"`
	}
	if err = json.Unmarshal(refreshResponse.Body.Bytes(), &refreshBody); err != nil || refreshBody.Scope != "openid offline_access" || refreshBody.Refresh != "" {
		return failure(errors.New("invalid refresh response scope"))
	}
	refreshAssertion, err = assertion("refresh-subset-assertion")
	if err != nil {
		return failure(err)
	}
	refreshProof, err = proof("refresh-subset-proof", endpoint, nonce)
	if err != nil {
		return failure(err)
	}
	refreshValues.Set("client_assertion", refreshAssertion)
	refreshValues.Set("scope", "openid")
	refreshResponse = post(tokenHandler, endpoint, refreshValues, refreshProof)
	if refreshResponse.Code != 200 {
		return failure(errors.New("narrowed refresh scope rejected"))
	}
	if err = json.Unmarshal(refreshResponse.Body.Bytes(), &refreshBody); err != nil || refreshBody.Scope != "openid" {
		return failure(errors.New("refresh scope not narrowed"))
	}
	refreshAssertion, err = assertion("refresh-no-openid-assertion")
	if err != nil {
		return failure(err)
	}
	refreshProof, err = proof("refresh-no-openid-proof", endpoint, nonce)
	if err != nil {
		return failure(err)
	}
	refreshValues.Set("client_assertion", refreshAssertion)
	refreshValues.Set("scope", "offline_access")
	refreshResponse = post(tokenHandler, endpoint, refreshValues, refreshProof)
	if refreshResponse.Code != 200 {
		return failure(errors.New("refresh subset without openid rejected"))
	}
	if err = json.Unmarshal(refreshResponse.Body.Bytes(), &refreshBody); err != nil || refreshBody.Scope != "offline_access" {
		return failure(errors.New("non-OIDC refresh subset incorrect"))
	}
	// RFC 9449 permits a confidential, client-authenticated refresh to use
	// a new DPoP key; the new access token must bind to that verified key.
	refreshAssertion, err = assertion("refresh-rotated-key-assertion")
	if err != nil {
		return failure(err)
	}
	rotatedProof, err := jwt.Signed(wrongSigner).Claims(map[string]any{"jti": "refresh-rotated-key-proof", "htm": "POST", "htu": endpoint, "iat": time.Now().Unix(), "nonce": nonce}).Serialize()
	if err != nil {
		return failure(err)
	}
	refreshValues.Set("client_assertion", refreshAssertion)
	refreshValues.Del("scope")
	refreshResponse = post(tokenHandler, endpoint, refreshValues, rotatedProof)
	if refreshResponse.Code != 200 {
		return failure(errors.New("confidential refresh key rotation rejected"))
	}
	var rotatedBody struct {
		Access string `json:"access_token"`
	}
	if err = json.Unmarshal(refreshResponse.Body.Bytes(), &rotatedBody); err != nil || rotatedBody.Access == "" {
		return failure(errors.New("rotated-key access token missing"))
	}
	rotatedJWT, err := jwt.ParseSigned(rotatedBody.Access, []jose.SignatureAlgorithm{jose.ES256})
	if err != nil {
		return failure(err)
	}
	rotatedKeys, err := composed.Keys.PublicKeys(ctx)
	if err != nil {
		return failure(err)
	}
	rotatedMatches := rotatedKeys.Key(rotatedJWT.Headers[0].KeyID)
	if len(rotatedMatches) != 1 {
		return failure(errors.New("rotated token signing key missing"))
	}
	var rotatedClaims struct {
		Confirmation struct {
			JKT string `json:"jkt"`
		} `json:"cnf"`
	}
	if err = rotatedJWT.Claims(rotatedMatches[0].Key, &rotatedClaims); err != nil {
		return failure(err)
	}
	rotatedJWK := jose.JSONWebKey{Key: &wrongKey.PublicKey}
	rotatedThumb, err := rotatedJWK.Thumbprint(crypto.SHA256)
	if err != nil {
		return failure(err)
	}
	if rotatedClaims.Confirmation.JKT != base64.RawURLEncoding.EncodeToString(rotatedThumb) || rotatedClaims.Confirmation.JKT == jkt {
		return failure(errors.New("access token not bound to rotated key"))
	}
	// Pending state and tokens retain the policy generation in which they
	// were authorized; a disable/regrant must not revive any of them.
	makePAR := func(id string) (string, error) {
		values := url.Values{}
		for k, v := range form {
			values[k] = append([]string(nil), v...)
		}
		as, e := assertion(id)
		if e != nil {
			return "", e
		}
		values.Set("client_assertion", as)
		request := httptest.NewRequest(http.MethodPost, p.PAR.Endpoint, strings.NewReader(values.Encode()))
		return p.PAR.Push(ctx, request, values)
	}
	bump := func() error {
		v, e := p.Policies.Get(ctx, client)
		if e != nil {
			return e
		}
		v, e = p.Policies.Put(ctx, client, v.Audience, v.Scopes, false, v.Version)
		if e != nil {
			return e
		}
		_, e = p.Policies.Put(ctx, client, v.Audience, v.Scopes, true, v.Version)
		return e
	}
	stalePAR, e := makePAR("generation-par")
	if e != nil {
		return failure(e)
	}
	if e = bump(); e != nil {
		return failure(e)
	}
	if e = p.PAR.Consume(ctx, args.ProjectID, client, stalePAR, func(context.Context, mapioauth.PushedAuthorizationRequest) error { return nil }); !errors.Is(e, mapioauth.ErrInvalidPAR) {
		return failure(errors.New("old PAR revived after regrant"))
	}
	raw, e = resourceProof("generation-old-access")
	if e != nil {
		return failure(e)
	}
	if _, e = composed.Tokens.ValidateResource(ctx, tokens.AccessToken, raw, "GET", resourceURL, client); !errors.Is(e, mapioauth.ErrInvalidAccess) {
		return failure(errors.New("old access token revived after regrant"))
	}
	generationNonce, e := p.Nonces.Issue(ctx, mapidpop.NonceScope{ProjectID: args.ProjectID, ClientID: client, Purpose: "token"})
	if e != nil {
		return failure(e)
	}
	refreshAssertion, e = assertion("generation-refresh-assertion")
	if e != nil {
		return failure(e)
	}
	refreshProof, e = proof("generation-refresh-proof", endpoint, generationNonce)
	if e != nil {
		return failure(e)
	}
	if _, e = composed.Exchange.ExchangeRefresh(ctx, mapioauth.FAPIExchangeRequest{ClientID: client, AssertionType: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer", Assertion: refreshAssertion, Proof: refreshProof, RefreshToken: tokens.RefreshToken}); !errors.Is(e, mapioauth.ErrInvalidRefresh) {
		return failure(errors.New("old refresh token revived after regrant"))
	}
	staleLogin, e := makePAR("generation-login")
	if e != nil {
		return failure(e)
	}
	var genHandle, genBinding string
	if e = p.PAR.Consume(ctx, args.ProjectID, client, staleLogin, func(ctx context.Context, req mapioauth.PushedAuthorizationRequest) error {
		var err error
		genHandle, genBinding, err = login.BeginInTransaction(ctx, req)
		return err
	}); e != nil {
		return failure(e)
	}
	if e = bump(); e != nil {
		return failure(e)
	}
	if _, e = login.Complete(ctx, genHandle, genBinding, args.SessionCredential); !errors.Is(e, mapioauth.ErrInvalidLogin) {
		return failure(errors.New("old login revived after regrant"))
	}
	staleCode, e := makePAR("generation-code")
	if e != nil {
		return failure(e)
	}
	if e = p.PAR.Consume(ctx, args.ProjectID, client, staleCode, func(ctx context.Context, req mapioauth.PushedAuthorizationRequest) error {
		var err error
		genHandle, genBinding, err = login.BeginInTransaction(ctx, req)
		return err
	}); e != nil {
		return failure(e)
	}
	genCompleted, e := login.Complete(ctx, genHandle, genBinding, args.SessionCredential)
	if e != nil {
		return failure(e)
	}
	if e = bump(); e != nil {
		return failure(e)
	}
	codeAssertion, e := assertion("generation-code-assertion")
	if e != nil {
		return failure(e)
	}
	codeProof, e := proof("generation-code-proof", endpoint, generationNonce)
	if e != nil {
		return failure(e)
	}
	if _, e = composed.Exchange.ExchangeCode(ctx, mapioauth.FAPIExchangeRequest{ClientID: client, AssertionType: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer", Assertion: codeAssertion, Proof: codeProof, Code: genCompleted.Code, RedirectURI: genCompleted.RedirectURI, Verifier: verifier}); !errors.Is(e, mapioauth.ErrInvalidCode) {
		return failure(errors.New("old code revived after regrant"))
	}
	sessions := service.NewSessionService(runtimePool, service.StatementsUserRefResolver{Pool: runtimePool}, service.SessionConfig{DefaultTTL: domain.SessionDefaultTTL, MaxTTL: 720 * time.Hour})
	if err = sessions.Delete(ctx, service.DeleteSessionInput{ProjectID: args.ProjectID, SessionID: args.SessionID}); err != nil {
		return failure(err)
	}
	raw, err = resourceProof("app-after-revoke")
	if err != nil {
		return failure(err)
	}
	if _, err = composed.Tokens.ValidateResource(ctx, tokens.AccessToken, raw, "GET", resourceURL, client); err == nil {
		return failure(errors.New("revoked upstream session accepted"))
	}
	return marshal(map[string]any{"ok": true, "userId": args.UserID, "sessionId": args.SessionID, "tokenType": tokens.TokenType})
}
