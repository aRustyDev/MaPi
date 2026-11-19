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
	"github.com/zitadel/nextgen/internal/mapidpop"
	"github.com/zitadel/nextgen/internal/mapioauth"
	"github.com/zitadel/nextgen/internal/secrets"
	"github.com/zitadel/nextgen/internal/service"
)

// This diagnostic export uses a fixed nonce exclusively in an isolated test.
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
	return marshal(map[string]any{"ok": true, "auditEvents": auditCount})
}
