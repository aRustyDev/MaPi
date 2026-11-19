//go:build wasip1 && mapi_oauth && mapi_assertion_test

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

// This diagnostic export uses a server-issued nonce in an isolated test.
//
//go:wasmexport mapi_private_par_probe
func privatePARProbe() uint64 {
	var args struct{ ProjectID, Origin string }
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
	app, err := apps.CreateOrRevise(ctx, args.ProjectID, []byte(`{"slug":"private-par-test","name":"Private PAR Test","clients":[{"slug":"web","type":"confidential","grant_types":["authorization_code"],"redirect_uris":["https://rp.example/callback"]}]}`))
	if err != nil {
		return failure(err)
	}
	if len(app.Secrets) != 1 {
		return failure(errors.New("test client unavailable"))
	}
	client := app.Secrets[0].ClientID
	store := mapioauth.Store{DB: db, Transaction: cloudflarewasm.Transaction, Now: time.Now}
	private, err := mapioauth.NewPrivatePAR(mapioauth.PrivatePARConfig{ProjectID: args.ProjectID, Issuer: args.Origin + "/oauth/" + args.ProjectID, Store: store, Pool: runtimePool})
	if err != nil {
		return failure(err)
	}
	if err = private.InitializeSchema(ctx); err != nil {
		return failure(err)
	}
	if err = private.InitializeSchema(ctx); err != nil {
		return failure(err)
	}
	createdPolicy, err := private.Policies.Put(ctx, client, client, []string{"payments.read"}, true, 0)
	if err != nil {
		return failure(err)
	}
	if _, err = private.Policies.Put(ctx, client, client, nil, true, 0); !errors.Is(err, mapioauth.ErrFAPIPolicyConflict) {
		return failure(errors.New("duplicate policy creation accepted"))
	}
	policyFailure := errors.New("policy audit rollback")
	badPolicy := private.Policies
	policyAudit := badPolicy.Audit
	badPolicy.Audit = func(ctx context.Context, v mapioauth.FAPIClientPolicy) error {
		if e := policyAudit(ctx, v); e != nil {
			return e
		}
		return policyFailure
	}
	if _, err = badPolicy.Put(ctx, client, "https://rollback.example", nil, true, createdPolicy.Version); !errors.Is(err, policyFailure) {
		return failure(errors.New("policy audit failure ignored"))
	}
	reloaded, err := mapioauth.NewPrivatePAR(mapioauth.PrivatePARConfig{ProjectID: args.ProjectID, Issuer: private.Assertions.Issuer, Store: store, Pool: runtimePool})
	if err != nil {
		return failure(err)
	}
	persisted, err := reloaded.Policies.Get(ctx, client)
	if err != nil || persisted.Version != createdPolicy.Version || persisted.Audience != client {
		return failure(errors.New("policy rollback or reload failed"))
	}
	if _, err = reloaded.Policies.Get(ctx, "missing-client"); !errors.Is(err, mapioauth.ErrFAPIPolicyDenied) {
		return failure(errors.New("missing policy allowed"))
	}

	serverNonce, err := private.Nonces.Issue(ctx, mapidpop.NonceScope{ProjectID: args.ProjectID, ClientID: client, Purpose: "par"})
	if err != nil {
		return failure(err)
	}
	public, clientKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return failure(err)
	}
	if err = private.Assertions.SetKeys(ctx, client, []jose.JSONWebKey{{Key: public, KeyID: "client-key", Algorithm: "EdDSA", Use: "sig"}}); err != nil {
		return failure(err)
	}
	clientSigner, err := jose.NewSigner(jose.SigningKey{Algorithm: jose.EdDSA, Key: &jose.JSONWebKey{Key: clientKey, KeyID: "client-key"}}, nil)
	if err != nil {
		return failure(err)
	}
	assertion := func(id string) (string, error) {
		return jwt.Signed(clientSigner).Claims(map[string]any{"iss": client, "sub": client, "aud": private.Assertions.Issuer, "jti": id, "exp": time.Now().Add(time.Minute).Unix()}).Serialize()
	}
	proofKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return failure(err)
	}
	proofJWK := jose.JSONWebKey{Key: &proofKey.PublicKey}
	thumb, err := proofJWK.Thumbprint(crypto.SHA256)
	if err != nil {
		return failure(err)
	}
	jkt := base64.RawURLEncoding.EncodeToString(thumb)
	proofSigner, err := jose.NewSigner(jose.SigningKey{Algorithm: jose.ES256, Key: proofKey}, (&jose.SignerOptions{}).WithHeader("typ", "dpop+jwt").WithHeader("jwk", proofJWK))
	if err != nil {
		return failure(err)
	}
	proof := func(id, nonce string) (string, error) {
		return jwt.Signed(proofSigner).Claims(map[string]any{"jti": id, "htm": "POST", "htu": private.PAR.Endpoint, "iat": time.Now().Unix(), "nonce": nonce}).Serialize()
	}
	firstAssertion, err := assertion("assertion-1")
	if err != nil {
		return failure(err)
	}
	challenge := sha256.Sum256([]byte("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~"))
	form := url.Values{"client_id": {client}, "client_assertion_type": {"urn:ietf:params:oauth:client-assertion-type:jwt-bearer"}, "client_assertion": {firstAssertion}, "response_type": {"code"}, "redirect_uri": {"https://rp.example/callback"}, "scope": {"openid"}, "state": {"state"}, "nonce": {"nonce"}, "code_challenge": {base64.RawURLEncoding.EncodeToString(challenge[:])}, "code_challenge_method": {"S256"}, "dpop_jkt": {jkt}}
	request := func(dpop string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(http.MethodPost, private.PAR.Endpoint, strings.NewReader(form.Encode()))
		r.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		if dpop != "" {
			r.Header.Set("DPoP", dpop)
		}
		w := httptest.NewRecorder()
		(mapioauth.PARHTTP{PAR: private.PAR}).ServeHTTP(w, r)
		return w
	}
	invalid, err := proof("proof-1", "wrong-nonce")
	if err != nil {
		return failure(err)
	}
	if request(invalid).Code != http.StatusBadRequest {
		return failure(errors.New("invalid DPoP accepted"))
	}
	count := func(table string) (int, error) {
		var n int
		if table == "mapi_oauth_client_assertion_jtis" {
			err := db.QueryRowContext(ctx, "SELECT count(*) FROM mapi_oauth_client_assertion_jtis WHERE project_id=? AND client_id=?", args.ProjectID, client).Scan(&n)
			return n, err
		}
		err := db.QueryRowContext(ctx, "SELECT count(*) FROM "+table).Scan(&n)
		return n, err
	}
	for _, table := range []string{"mapi_oauth_client_assertion_jtis", "mapi_dpop_replay", "mapi_oauth_par"} {
		n, err := count(table)
		if err != nil || n != 0 {
			return failure(fmt.Errorf("failed proof retained %s", table))
		}
	}
	good, err := proof("proof-1", serverNonce)
	if err != nil {
		return failure(err)
	}
	response := request(good)
	if response.Code != http.StatusCreated {
		return failure(fmt.Errorf("valid PAR returned %d", response.Code))
	}
	var parsed struct {
		RequestURI string `json:"request_uri"`
	}
	if err = json.Unmarshal(response.Body.Bytes(), &parsed); err != nil || parsed.RequestURI == "" {
		return failure(errors.New("missing PAR request URI"))
	}
	second, err := assertion("assertion-2")
	if err != nil {
		return failure(err)
	}
	form.Set("client_assertion", second)
	if request(good).Code != http.StatusBadRequest {
		return failure(errors.New("DPoP replay accepted"))
	}
	next, err := proof("proof-2", serverNonce)
	if err != nil {
		return failure(err)
	}
	if request(next).Code != http.StatusCreated {
		return failure(errors.New("valid retry did not commit"))
	}
	replay, err := proof("proof-3", serverNonce)
	if err != nil {
		return failure(err)
	}
	if request(replay).Code != http.StatusBadRequest {
		return failure(errors.New("client assertion replay accepted"))
	}
	if _, err = db.ExecContext(ctx, `CREATE TABLE mapi_test_fapi_login(value TEXT NOT NULL)`); err != nil {
		return failure(err)
	}
	abort := errors.New("test abort")
	err = private.PAR.Consume(ctx, args.ProjectID, client, parsed.RequestURI, func(ctx context.Context, p mapioauth.PushedAuthorizationRequest) error {
		if _, err := db.ExecContext(ctx, `INSERT INTO mapi_test_fapi_login VALUES('failed')`); err != nil {
			return err
		}
		return abort
	})
	if !errors.Is(err, abort) {
		return failure(errors.New("failed PAR consume did not roll back"))
	}
	if n, err := count("mapi_test_fapi_login"); err != nil || n != 0 {
		return failure(errors.New("failed PAR login persisted"))
	}
	err = private.PAR.Consume(ctx, args.ProjectID, client, parsed.RequestURI, func(ctx context.Context, p mapioauth.PushedAuthorizationRequest) error {
		if p.DPoPJKT != jkt || p.ClientID != client {
			return errors.New("binding mismatch")
		}
		_, err := db.ExecContext(ctx, `INSERT INTO mapi_test_fapi_login VALUES('ok')`)
		return err
	})
	if err != nil {
		return failure(err)
	}
	if err = private.PAR.Consume(ctx, args.ProjectID, client, parsed.RequestURI, func(context.Context, mapioauth.PushedAuthorizationRequest) error { return nil }); !errors.Is(err, mapioauth.ErrInvalidPAR) {
		return failure(errors.New("PAR replay accepted"))
	}
	for _, table := range []string{"mapi_oauth_client_assertion_jtis", "mapi_dpop_replay"} {
		n, err := count(table)
		if err != nil || n != 2 {
			return failure(fmt.Errorf("unexpected %s count", table))
		}
	}
	var auditCount int
	if err = db.QueryRowContext(ctx, `SELECT count(*) FROM events WHERE project_id=? AND event_type IN ('mapi.fapi.client_assertion.accepted','mapi.fapi.par.pushed','mapi.fapi.par.consumed')`, args.ProjectID).Scan(&auditCount); err != nil {
		return failure(err)
	}
	if auditCount != 5 {
		return failure(errors.New("PAR audit transaction mismatch"))
	}
	for _, tc := range []struct {
		id    string
		bound bool
	}{{"jkt-only", true}, {"unbound", false}} {
		auth, err := assertion(tc.id)
		if err != nil {
			return failure(err)
		}
		form.Set("client_assertion", auth)
		if tc.bound {
			form.Set("dpop_jkt", jkt)
		} else {
			form.Del("dpop_jkt")
		}
		response := request("")
		if response.Code != http.StatusCreated {
			return failure(fmt.Errorf("%s PAR failed", tc.id))
		}
		var candidate struct {
			RequestURI string `json:"request_uri"`
		}
		if err = json.Unmarshal(response.Body.Bytes(), &candidate); err != nil || candidate.RequestURI == "" {
			return failure(errors.New("PAR handle missing"))
		}
		err = private.PAR.Consume(ctx, args.ProjectID, client, candidate.RequestURI, func(_ context.Context, p mapioauth.PushedAuthorizationRequest) error {
			if tc.bound && p.DPoPJKT != jkt {
				return errors.New("JKT commitment lost")
			}
			if !tc.bound && p.DPoPJKT != "" {
				return errors.New("unbound PAR unexpectedly bound")
			}
			return nil
		})
		if err != nil {
			return failure(err)
		}
	}
	if err = db.QueryRowContext(ctx, `SELECT count(*) FROM events WHERE project_id=? AND event_type IN ('mapi.fapi.client_assertion.accepted','mapi.fapi.par.pushed','mapi.fapi.par.consumed')`, args.ProjectID).Scan(&auditCount); err != nil {
		return failure(err)
	}
	if auditCount != 11 {
		return failure(errors.New("optional PAR audit mismatch"))
	}
	// A real private HTTP challenge follows client authentication and rolls
	// back the assertion replay write before issuing the scoped nonce.
	challengeAssertion, err := assertion("challenge-retry-assertion")
	if err != nil {
		return failure(err)
	}
	form.Set("client_assertion", challengeAssertion)
	challengeRequest := func(raw string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(http.MethodPost, private.PAR.Endpoint, strings.NewReader(form.Encode()))
		r.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		r.Header.Set("DPoP", raw)
		w := httptest.NewRecorder()
		(mapioauth.FAPIPARHTTP{Private: private}).ServeHTTP(w, r)
		return w
	}
	missingNonceProof, err := proof("challenge-retry-proof", "not-issued")
	if err != nil {
		return failure(err)
	}
	challenged := challengeRequest(missingNonceProof)
	freshNonce := challenged.Header().Get("DPoP-Nonce")
	if challenged.Code != http.StatusBadRequest || freshNonce == "" {
		return failure(errors.New("nonce challenge missing"))
	}
	retryProof, err := proof("challenge-retry-proof", freshNonce)
	if err != nil {
		return failure(err)
	}
	if response := challengeRequest(retryProof); response.Code != http.StatusCreated {
		return failure(fmt.Errorf("nonce retry returned %d", response.Code))
	}
	// Test grant storage only; callers must verify real proofs and sessions
	// in the same transaction before passing a thumbprint to these primitives.
	verifier := "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~"
	grant := mapioauth.AuthorizationCode{ProjectID: args.ProjectID, ClientID: client, RedirectURI: "https://rp.example/callback", UserID: "synthetic-user", SessionID: "synthetic-session", Scope: "openid", Nonce: "login-nonce", PolicyVersion: 1, CodeChallenge: base64.RawURLEncoding.EncodeToString(challenge[:]), ExpiresAt: time.Now().Add(30 * time.Second)}
	var code string
	injected := errors.New("injected rollback")
	err = store.Transaction(func() error {
		var e error
		code, e = private.Grants.IssueCodeInTransaction(ctx, grant, jkt)
		if e != nil {
			return e
		}
		return injected
	})
	if !errors.Is(err, injected) {
		return failure(errors.New("grant rollback injection failed"))
	}
	err = store.Transaction(func() error {
		_, e := private.Grants.ConsumeCodeInTransaction(ctx, code, client, grant.RedirectURI, verifier, jkt)
		return e
	})
	if !errors.Is(err, mapioauth.ErrInvalidCode) {
		return failure(errors.New("rolled-back grant persisted"))
	}
	err = store.Transaction(func() error { var e error; code, e = private.Grants.IssueCodeInTransaction(ctx, grant, jkt); return e })
	if err != nil {
		return failure(err)
	}
	err = store.Transaction(func() error {
		_, e := private.Grants.ConsumeCodeInTransaction(ctx, code, client, grant.RedirectURI, verifier, jkt)
		return e
	})
	if err != nil {
		return failure(err)
	}
	err = store.Transaction(func() error {
		_, e := private.Grants.ConsumeCodeInTransaction(ctx, code, client, grant.RedirectURI, verifier, jkt)
		return e
	})
	if !errors.Is(err, mapioauth.ErrInvalidCode) {
		return failure(errors.New("code replay accepted"))
	}
	refreshGrant := mapioauth.FAPIRefresh{RefreshGrant: mapioauth.RefreshGrant{ProjectID: args.ProjectID, ClientID: client, UserID: grant.UserID, SessionID: grant.SessionID, Scope: "openid offline_access", ExpiresAt: time.Now().Add(time.Hour)}, DPoPJKT: jkt, PolicyVersion: 1}
	var refresh string
	err = store.Transaction(func() error {
		var e error
		refresh, e = private.Grants.IssueRefreshInTransaction(ctx, refreshGrant)
		return e
	})
	if err != nil {
		return failure(err)
	}
	err = store.Transaction(func() error { _, e := private.Grants.RefreshInTransaction(ctx, refresh, client, ""); return e })
	if !errors.Is(err, mapioauth.ErrInvalidRefresh) {
		return failure(errors.New("unbound refresh accepted"))
	}
	err = store.Transaction(func() error { _, e := private.Grants.RefreshInTransaction(ctx, refresh, client, jkt); return e })
	if err != nil {
		return failure(err)
	}
	err = store.Transaction(func() error {
		changed, e := private.Grants.RevokeRefreshInTransaction(ctx, refresh, client)
		if e != nil {
			return e
		}
		if !changed {
			return errors.New("refresh not revoked")
		}
		return nil
	})
	if err != nil {
		return failure(err)
	}
	err = store.Transaction(func() error { _, e := private.Grants.RefreshInTransaction(ctx, refresh, client, jkt); return e })
	if !errors.Is(err, mapioauth.ErrInvalidRefresh) {
		return failure(errors.New("revoked refresh accepted"))
	}
	// Exercise the real assertion and DPoP verifier inside the same DO
	// transaction as code consumption. The mint/session callbacks are test
	// doubles and do not represent an issuer or an authoritative session.
	tokenNonce, err := private.Nonces.Issue(ctx, mapidpop.NonceScope{ProjectID: args.ProjectID, ClientID: client, Purpose: "token"})
	if err != nil {
		return failure(err)
	}
	if _, err = db.ExecContext(ctx, `CREATE TABLE mapi_test_exchange_audit (client TEXT NOT NULL)`); err != nil {
		return failure(err)
	}
	failAudit := true
	exchange := mapioauth.FAPIExchange{Private: private,
		CheckSession: func(_ context.Context, projectID, userID, sessionID string) error {
			if projectID != args.ProjectID || userID != grant.UserID || sessionID != grant.SessionID {
				return errors.New("bad test session")
			}
			return nil
		},
		Mint: func(_ context.Context, g mapioauth.FAPIExchangeGrant) ([]byte, error) {
			if g.DPoPJKT != jkt {
				return nil, errors.New("wrong token JKT")
			}
			return []byte("synthetic"), nil
		},
		Audit: func(ctx context.Context, g mapioauth.FAPIExchangeGrant) error {
			if _, e := db.ExecContext(ctx, `INSERT INTO mapi_test_exchange_audit VALUES (?)`, g.ClientID); e != nil {
				return e
			}
			if failAudit {
				return injected
			}
			return nil
		},
	}
	err = store.Transaction(func() error { var e error; code, e = private.Grants.IssueCodeInTransaction(ctx, grant, jkt); return e })
	if err != nil {
		return failure(err)
	}
	clientAssertion, err := assertion("token-assertion")
	if err != nil {
		return failure(err)
	}
	tokenProof, err := jwt.Signed(proofSigner).Claims(map[string]any{"jti": "token-proof", "htm": "POST", "htu": private.Assertions.Issuer + "/token", "iat": time.Now().Unix(), "nonce": tokenNonce}).Serialize()
	if err != nil {
		return failure(err)
	}
	exchangeRequest := mapioauth.FAPIExchangeRequest{ClientID: client, AssertionType: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer", Assertion: clientAssertion, Proof: tokenProof, Code: code, RedirectURI: grant.RedirectURI, Verifier: verifier}
	if result, e := exchange.ExchangeCode(ctx, exchangeRequest); !errors.Is(e, injected) || result != nil {
		return failure(errors.New("token exchange rollback failed"))
	}
	var exchangeAudit int
	if e := db.QueryRowContext(ctx, `SELECT COUNT(*) FROM mapi_test_exchange_audit`).Scan(&exchangeAudit); e != nil || exchangeAudit != 0 {
		return failure(errors.New("failed token audit persisted"))
	}
	failAudit = false
	if result, e := exchange.ExchangeCode(ctx, exchangeRequest); e != nil || string(result) != "synthetic" {
		return failure(errors.New("token exchange retry failed"))
	}
	// Install synthetic session rows, then exercise actual Nextgen session
	// reads and project encryption services. This test does not claim a real
	// browser login created this session.
	stamp := time.Now().Add(-time.Second).UnixNano()
	if _, err = db.ExecContext(ctx, `INSERT INTO users(project_id,id,schema_url,status,created_at,updated_at) VALUES(?,?,?,'active',?,?)`, args.ProjectID, grant.UserID, "synthetic", stamp, stamp); err != nil {
		return failure(err)
	}
	if _, err = db.ExecContext(ctx, `INSERT INTO sessions(project_id,id,created_at,updated_at,time_to_live,user_id) VALUES(?,?,?,?,?,?)`, args.ProjectID, grant.SessionID, stamp, stamp, int64(time.Hour), grant.UserID); err != nil {
		return failure(err)
	}
	if _, err = db.ExecContext(ctx, `INSERT INTO checks(project_id,id,session_id,type,last_verified_at) VALUES(?,?,?,?,?)`, args.ProjectID, "fapi_test_check", grant.SessionID, int(domain.AuthCheckTypePassword), stamp); err != nil {
		return failure(err)
	}
	composed, err := mapioauth.ComposePrivateFAPI(private, runtimePool, runtimeKeys)
	if err != nil {
		return failure(err)
	}
	if _, err = composed.Keys.Rotate(ctx, false); err != nil {
		return failure(err)
	}
	grant.ExpiresAt = time.Now().Add(30 * time.Second)
	err = store.Transaction(func() error { var e error; code, e = private.Grants.IssueCodeInTransaction(ctx, grant, jkt); return e })
	if err != nil {
		return failure(err)
	}
	clientAssertion, err = assertion("signed-token-assertion")
	if err != nil {
		return failure(err)
	}
	tokenProof, err = jwt.Signed(proofSigner).Claims(map[string]any{"jti": "signed-token-proof", "htm": "POST", "htu": private.Assertions.Issuer + "/token", "iat": time.Now().Unix(), "nonce": tokenNonce}).Serialize()
	if err != nil {
		return failure(err)
	}
	exchangeRequest.Assertion = clientAssertion
	exchangeRequest.Proof = tokenProof
	exchangeRequest.Code = code
	// Fail after the real ID audit write and prove the entire exchange,
	// including code consumption and assertion/proof replays, rolls back.
	failingIssuer := composed.Tokens
	auditID := failingIssuer.AuditIDToken
	failingIssuer.AuditIDToken = func(ctx context.Context, g mapioauth.FAPIExchangeGrant, id string) error {
		if e := auditID(ctx, g, id); e != nil {
			return e
		}
		return injected
	}
	failingExchange := composed.Exchange
	failingExchange.Mint = failingIssuer.Mint
	if result, e := failingExchange.ExchangeCode(ctx, exchangeRequest); !errors.Is(e, injected) || result != nil {
		return failure(errors.New("ID token audit rollback failed"))
	}
	var idAudit int
	if err = db.QueryRowContext(ctx, `SELECT COUNT(*) FROM events WHERE project_id=? AND entity_type=?`, args.ProjectID, "fapi_id_token").Scan(&idAudit); err != nil || idAudit != 0 {
		return failure(errors.New("ID token audit persisted after rollback"))
	}
	signedResult, err := composed.Exchange.ExchangeCode(ctx, exchangeRequest)
	if err != nil {
		return failure(err)
	}
	var signed struct {
		AccessToken string `json:"access_token"`
		IDToken     string `json:"id_token"`
		TokenType   string `json:"token_type"`
	}
	if err = json.Unmarshal(signedResult, &signed); err != nil || signed.AccessToken == "" || signed.IDToken == "" || signed.TokenType != "DPoP" {
		return failure(errors.New("signed token missing"))
	}
	// Verify the ID token independently with the ES256 public key, as a
	// relying party would, then exercise authoritative validation.
	parsedID, err := jwt.ParseSigned(signed.IDToken, []jose.SignatureAlgorithm{jose.ES256})
	if err != nil {
		return failure(err)
	}
	idKeys, err := composed.Keys.PublicKeys(ctx)
	if err != nil {
		return failure(err)
	}
	matchingKeys := idKeys.Key(parsedID.Headers[0].KeyID)
	if len(matchingKeys) != 1 {
		return failure(errors.New("ID signing key missing"))
	}
	var idClaims struct {
		Issuer     string `json:"iss"`
		Subject    string `json:"sub"`
		Nonce      string `json:"nonce"`
		AccessHash string `json:"at_hash"`
		AuthTime   int64  `json:"auth_time"`
	}
	if err = parsedID.Claims(matchingKeys[0].Key, &idClaims); err != nil {
		return failure(err)
	}
	accessDigest := sha256.Sum256([]byte(signed.AccessToken))
	if idClaims.Issuer != private.Assertions.Issuer || idClaims.Subject != grant.UserID || idClaims.Nonce != grant.Nonce || idClaims.AuthTime == 0 || idClaims.AccessHash != base64.RawURLEncoding.EncodeToString(accessDigest[:16]) {
		return failure(errors.New("ID claims invalid"))
	}
	if _, err = composed.Tokens.ValidateIDToken(ctx, signed.IDToken, client, grant.Nonce, signed.AccessToken); err != nil {
		return failure(err)
	}
	if _, err = composed.Tokens.ValidateIDToken(ctx, signed.IDToken, client, "wrong-nonce", signed.AccessToken); err == nil {
		return failure(errors.New("wrong ID nonce accepted"))
	}
	if _, err = composed.Tokens.ValidateIDToken(ctx, signed.IDToken, "wrong-client", grant.Nonce, signed.AccessToken); err == nil {
		return failure(errors.New("wrong ID audience accepted"))
	}
	if _, err = composed.Tokens.ValidateIDToken(ctx, signed.IDToken, client, grant.Nonce, "wrong-access"); err == nil {
		return failure(errors.New("wrong ID at_hash accepted"))
	}
	if _, err = composed.Keys.Rotate(ctx, true); err != nil {
		return failure(err)
	}
	if _, err = composed.Tokens.ValidateIDToken(ctx, signed.IDToken, client, grant.Nonce, signed.AccessToken); err != nil {
		return failure(errors.New("old ID key failed after rotation"))
	}
	otherIDIssuer := *private
	otherIDIssuer.Assertions.Issuer = "https://other.example/oauth/" + args.ProjectID
	otherIDTokens := composed.Tokens
	otherIDTokens.Private = &otherIDIssuer
	if _, err = otherIDTokens.ValidateIDToken(ctx, signed.IDToken, client, grant.Nonce, signed.AccessToken); err == nil {
		return failure(errors.New("wrong ID issuer accepted"))
	}
	resourceNonce, err := private.Nonces.Issue(ctx, mapidpop.NonceScope{ProjectID: args.ProjectID, ClientID: client, Purpose: "resource"})
	if err != nil {
		return failure(err)
	}
	resourceURL := "https://resource.example/profile"
	resourceProof := func(id, ath string) (string, error) {
		return jwt.Signed(proofSigner).Claims(map[string]any{"jti": id, "htm": "GET", "htu": resourceURL, "iat": time.Now().Unix(), "nonce": resourceNonce, "ath": ath}).Serialize()
	}
	accessHash := sha256.Sum256([]byte(signed.AccessToken))
	ath := base64.RawURLEncoding.EncodeToString(accessHash[:])
	badProof, err := resourceProof("resource-bad-ath", "invalid")
	if err != nil {
		return failure(err)
	}
	if _, err = composed.Tokens.ValidateResource(ctx, signed.AccessToken, badProof, "GET", resourceURL, client); err == nil {
		return failure(errors.New("incorrect ath accepted"))
	}
	wrongProofKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return failure(err)
	}
	wrongSigner, err := jose.NewSigner(jose.SigningKey{Algorithm: jose.ES256, Key: wrongProofKey}, (&jose.SignerOptions{}).WithHeader("typ", "dpop+jwt").WithHeader("jwk", jose.JSONWebKey{Key: &wrongProofKey.PublicKey}))
	if err != nil {
		return failure(err)
	}
	wrongJKTProof, err := jwt.Signed(wrongSigner).Claims(map[string]any{"jti": "resource-wrong-jkt", "htm": "GET", "htu": resourceURL, "iat": time.Now().Unix(), "nonce": resourceNonce, "ath": ath}).Serialize()
	if err != nil {
		return failure(err)
	}
	if _, err = composed.Tokens.ValidateResource(ctx, signed.AccessToken, wrongJKTProof, "GET", resourceURL, client); err == nil {
		return failure(errors.New("wrong JKT accepted"))
	}
	otherProject := composed.Tokens
	otherProject.Keys.ProjectID = "another-project"
	if _, err = otherProject.ValidateResource(ctx, signed.AccessToken, wrongJKTProof, "GET", resourceURL, client); err == nil {
		return failure(errors.New("cross-project token accepted"))
	}
	goodResource, err := resourceProof("resource-good", ath)
	if err != nil {
		return failure(err)
	}
	if _, err = composed.Tokens.ValidateResource(ctx, signed.AccessToken, goodResource, "GET", resourceURL, "wrong-audience"); err == nil {
		return failure(errors.New("wrong audience accepted"))
	}
	rollbackIssuer := composed.Tokens
	rollbackIssuer.AuditAccess = func(ctx context.Context, id mapioauth.AccessIdentity) error {
		if _, e := db.ExecContext(ctx, `INSERT INTO mapi_test_exchange_audit VALUES (?)`, id.ClientID); e != nil {
			return e
		}
		return injected
	}
	if _, err = rollbackIssuer.ValidateResource(ctx, signed.AccessToken, goodResource, "GET", resourceURL, client); !errors.Is(err, injected) {
		return failure(errors.New("resource audit failure did not roll back"))
	}
	id, err := composed.Tokens.ValidateResource(ctx, signed.AccessToken, goodResource, "GET", resourceURL, client)
	if err != nil || id.Subject != grant.UserID {
		return failure(errors.New("signed resource validation failed"))
	}
	if _, err = composed.Tokens.ValidateResource(ctx, signed.AccessToken, goodResource, "GET", resourceURL, client); err == nil {
		return failure(errors.New("resource proof replay accepted"))
	}
	// Exercise client-scoped resource authorization and the actual RFC 7009
	// HTTP endpoint with no DPoP header (nor ath) on revocation.
	customIssuer := composed.Tokens
	policyVersion, err := private.Policies.Put(ctx, client, "https://resource.example/payments", []string{"payments.read"}, true, 1)
	if err != nil {
		return failure(err)
	}
	var customRaw []byte
	if err = store.Transaction(func() error {
		var e error
		customRaw, e = customIssuer.Mint(ctx, mapioauth.FAPIExchangeGrant{ProjectID: args.ProjectID, ClientID: client, UserID: grant.UserID, SessionID: grant.SessionID, Scope: "openid payments.read", Nonce: "custom-nonce", DPoPJKT: jkt, PolicyVersion: policyVersion.Version})
		return e
	}); err != nil {
		return failure(err)
	}
	var customTokens struct {
		Access string `json:"access_token"`
	}
	if err = json.Unmarshal(customRaw, &customTokens); err != nil || customTokens.Access == "" {
		return failure(errors.New("scoped token missing"))
	}
	customHash := sha256.Sum256([]byte(customTokens.Access))
	customATH := base64.RawURLEncoding.EncodeToString(customHash[:])
	customProof, err := resourceProof("custom-resource-proof", customATH)
	if err != nil {
		return failure(err)
	}
	resourcePolicy := mapioauth.FAPIResourcePolicy{Audience: "https://resource.example/payments", AllowedClients: []string{client}, RequiredScopes: []string{"payments.read"}}
	wrongPolicy := resourcePolicy
	wrongPolicy.RequiredScopes = []string{"payments.write"}
	if _, err = customIssuer.AuthorizeResource(ctx, customTokens.Access, customProof, "GET", resourceURL, wrongPolicy); !errors.Is(err, mapioauth.ErrInsufficientScope) {
		return failure(errors.New("insufficient scope accepted"))
	}
	if _, err = customIssuer.AuthorizeResource(ctx, customTokens.Access, customProof, "GET", resourceURL, resourcePolicy); err != nil {
		return failure(err)
	}
	httpRevoke := func(token, id string) *httptest.ResponseRecorder {
		as, e := assertion(id)
		if e != nil {
			return nil
		}
		values := url.Values{"client_id": {client}, "client_assertion_type": {"urn:ietf:params:oauth:client-assertion-type:jwt-bearer"}, "client_assertion": {as}, "token": {token}}
		r := httptest.NewRequest(http.MethodPost, private.Assertions.Issuer+"/revoke", strings.NewReader(values.Encode()))
		r.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		w := httptest.NewRecorder()
		(mapioauth.FAPIRevocationHTTP{Revoker: composed.Revocation}).ServeHTTP(w, r)
		return w
	}
	if w := httpRevoke("unknown-token", "http-revoke-unknown"); w == nil || w.Code != 200 || w.Body.Len() != 0 {
		return failure(errors.New("unknown token revocation not nondisclosing"))
	}
	if w := httpRevoke(customTokens.Access, "http-revoke-access"); w == nil || w.Code != 200 || w.Body.Len() != 0 {
		return failure(errors.New("RFC 7009 access revocation failed"))
	}
	customAfter, err := resourceProof("custom-resource-revoked", customATH)
	if err != nil {
		return failure(err)
	}
	if _, err = customIssuer.AuthorizeResource(ctx, customTokens.Access, customAfter, "GET", resourceURL, resourcePolicy); !errors.Is(err, mapioauth.ErrInvalidAccess) {
		return failure(errors.New("HTTP-revoked scoped access accepted"))
	}
	var httpRefresh string
	if err = store.Transaction(func() error {
		var e error
		httpRefresh, e = private.Grants.IssueRefreshInTransaction(ctx, refreshGrant)
		return e
	}); err != nil {
		return failure(err)
	}
	if w := httpRevoke(httpRefresh, "http-revoke-refresh"); w == nil || w.Code != 200 || w.Body.Len() != 0 {
		return failure(errors.New("RFC 7009 refresh revocation failed"))
	}
	err = store.Transaction(func() error { _, e := private.Grants.RefreshInTransaction(ctx, httpRefresh, client, jkt); return e })
	if !errors.Is(err, mapioauth.ErrInvalidRefresh) {
		return failure(errors.New("HTTP-revoked refresh accepted"))
	}
	if _, err = private.Policies.Put(ctx, client, client, []string{"payments.read"}, true, policyVersion.Version); err != nil {
		return failure(err)
	}
	// Authenticated token revocation is project-scoped, sender-bound and
	// audited in the same transaction as the token-hash tombstone.
	revokeNonce, err := private.Nonces.Issue(ctx, mapidpop.NonceScope{ProjectID: args.ProjectID, ClientID: client, Purpose: "revocation"})
	if err != nil {
		return failure(err)
	}
	revProof := func(signer jose.Signer, jti string) (string, error) {
		return jwt.Signed(signer).Claims(map[string]any{"jti": jti, "htm": "POST", "htu": private.Assertions.Issuer + "/revoke", "iat": time.Now().Unix(), "nonce": revokeNonce, "ath": ath}).Serialize()
	}
	revokeAssertion, err := assertion("revoke-assertion")
	if err != nil {
		return failure(err)
	}
	goodRevokeProof, err := revProof(proofSigner, "revoke-proof")
	if err != nil {
		return failure(err)
	}
	revokeRequest := mapioauth.FAPIRevokeRequest{ClientID: client, AssertionType: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer", Assertion: revokeAssertion, Proof: goodRevokeProof, Token: signed.AccessToken}
	badRevoke := revokeRequest
	badRevoke.Assertion, err = assertion("revoke-wrong-key-assertion")
	if err != nil {
		return failure(err)
	}
	badRevoke.Proof, err = revProof(wrongSigner, "revoke-wrong-key-proof")
	if err != nil {
		return failure(err)
	}
	if err = composed.Revocation.RevokeAccess(ctx, badRevoke); err != nil {
		return failure(errors.New("wrong-key revocation nondisclosure failed"))
	}
	var wrongCount int
	if err = db.QueryRowContext(ctx, `SELECT COUNT(*) FROM mapi_fapi_revoked_access WHERE project_id=? AND token_hash=?`, args.ProjectID, accessHash[:]).Scan(&wrongCount); err != nil || wrongCount != 0 {
		return failure(errors.New("wrong key revoked access token"))
	}
	failingRevoker := composed.Revocation
	originalRevokeAudit := failingRevoker.Audit
	failingRevoker.Audit = func(ctx context.Context, id mapioauth.AccessIdentity) error {
		if e := originalRevokeAudit(ctx, id); e != nil {
			return e
		}
		return injected
	}
	if err = failingRevoker.RevokeAccess(ctx, revokeRequest); !errors.Is(err, injected) {
		return failure(errors.New("revoke audit failure not propagated"))
	}
	var tombstones int
	if err = db.QueryRowContext(ctx, `SELECT COUNT(*) FROM mapi_fapi_revoked_access WHERE project_id=? AND token_hash=?`, args.ProjectID, accessHash[:]).Scan(&tombstones); err != nil || tombstones != 0 {
		return failure(errors.New("failed revocation persisted"))
	}
	if err = composed.Revocation.RevokeAccess(ctx, revokeRequest); err != nil {
		return failure(err)
	}
	freshAfterRevoke, err := resourceProof("resource-token-revoked", ath)
	if err != nil {
		return failure(err)
	}
	if _, err = composed.Tokens.ValidateResource(ctx, signed.AccessToken, freshAfterRevoke, "GET", resourceURL, client); !errors.Is(err, mapioauth.ErrInvalidAccess) {
		return failure(errors.New("revoked access token accepted"))
	}
	if err = composed.Revocation.RevokeAccess(ctx, revokeRequest); !errors.Is(err, mapioauth.ErrInvalidClient) {
		return failure(errors.New("revoke assertion replay accepted"))
	}
	revokeRequest.Assertion, err = assertion("revoke-assertion-2")
	if err != nil {
		return failure(err)
	}
	if err = composed.Revocation.RevokeAccess(ctx, revokeRequest); !errors.Is(err, mapioauth.ErrInvalidDPoP) {
		return failure(errors.New("revoke proof replay accepted"))
	}
	revokeRequest.Proof, err = revProof(proofSigner, "revoke-proof-2")
	if err != nil {
		return failure(err)
	}
	if err = composed.Revocation.RevokeAccess(ctx, revokeRequest); err != nil {
		return failure(errors.New("idempotent revocation failed"))
	}
	if _, err = db.ExecContext(ctx, `DELETE FROM sessions WHERE project_id=? AND id=?`, args.ProjectID, grant.SessionID); err != nil {
		return failure(err)
	}
	if _, err = composed.Tokens.ValidateIDToken(ctx, signed.IDToken, client, grant.Nonce, signed.AccessToken); err == nil {
		return failure(errors.New("revoked ID session accepted"))
	}
	revokedProof, err := resourceProof("resource-after-revoke", ath)
	if err != nil {
		return failure(err)
	}
	if _, err = composed.Tokens.ValidateResource(ctx, signed.AccessToken, revokedProof, "GET", resourceURL, client); err == nil {
		return failure(errors.New("revoked session accepted"))
	}
	return marshal(map[string]any{"ok": true, "auditEvents": auditCount})
}
