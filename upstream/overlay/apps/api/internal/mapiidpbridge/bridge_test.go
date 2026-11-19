package mapiidpbridge

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/go-jose/go-jose/v4"
	"github.com/go-jose/go-jose/v4/jwt"
	"github.com/zitadel/nextgen/internal/domain"
	"github.com/zitadel/nextgen/internal/service"
	"github.com/zitadel/oidc/v3/pkg/op"
)

type attemptStub struct {
	service.AuthAttemptService
	state, binding   string
	check            *domain.SSOCallbackCheck
	consumes, stores int
	result           *domain.SSOCallbackResult
	event            domain.EventType
	failStore        bool
}

func (a *attemptStub) ConsumeSSOState(_ context.Context, _, state, binding string) (*domain.SSOCallbackCheck, error) {
	if state != a.state || binding != a.binding || a.consumes != 0 {
		return nil, domain.ErrSSOStateInvalid()
	}
	a.consumes++
	return a.check, nil
}
func (a *attemptStub) GetByID(context.Context, string, string) (*domain.AuthAttempt, error) {
	return &domain.AuthAttempt{ID: "att_1", DeploymentID: "dep_1"}, nil
}
func (a *attemptStub) SetSSOCallbackResult(_ context.Context, _ string, _ *domain.SSOCallbackCheck, r *domain.SSOCallbackResult, e domain.EventType) error {
	if a.failStore {
		return errors.New("synthetic store failure")
	}
	a.stores++
	a.result = r
	a.event = e
	return nil
}

type connectionStub struct {
	service.IDPConnectionService
	document []byte
}

func (c connectionStub) GetRevision(_ context.Context, project, id string) (*domain.IDPConnection, error) {
	if project != "proj_1" || id != "idprev_1" {
		return nil, errors.New("wrong revision")
	}
	return &domain.IDPConnection{Slug: "example", RevisionID: id, Document: c.document}, nil
}

type variableStub struct {
	service.VariableService
	set *domain.VariableSet
}

func (v variableStub) GetDeploymentVariables(_ context.Context, project, id string) (*domain.VariableSet, error) {
	if project != "proj_1" || id != "dep_1" {
		return nil, errors.New("wrong deployment")
	}
	return v.set, nil
}

type keyStub struct {
	service.KeyService
	crypter op.Crypto
}

func (k keyStub) GetCrypter(_ context.Context, id string, alg jose.ContentEncryption) (op.Crypto, error) {
	if id != "key_1" || alg != jose.A256GCM {
		return nil, errors.New("wrong key")
	}
	return k.crypter, nil
}

func TestActualFlowCallbackResumesWithoutReconsumingState(t *testing.T) {
	ctx := context.Background()
	crypter := op.NewAES256GCMCrypto([32]byte{1, 2, 3}, "key_1")
	verifier := "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~"
	encryptedVerifier, err := crypter.Encrypt(verifier)
	if err != nil {
		t.Fatal(err)
	}
	encryptedSecret, err := crypter.Encrypt(`"synthetic-secret"`)
	if err != nil {
		t.Fatal(err)
	}
	variables, err := domain.NewVariableSet("proj_1", []*domain.Variable{{Name: "PROVIDER_SECRET", Value: encryptedSecret, IsSecret: true}})
	if err != nil {
		t.Fatal(err)
	}
	issuer := "https://idp.example"
	state := "proj_1.state"
	binding := "binding-secret"
	check := &domain.SSOCallbackCheck{ID: "ch_1", StateHash: domain.HashSecret(state), AuthAttemptID: "att_1", Pending: &domain.SSOStatePayload{ProviderSlug: "example", ConnectionRevisionID: "idprev_1", RedirectURI: "https://app.example/callback", BindingNonceHash: domain.HashSecret(binding), EncryptedPKCEVerifier: encryptedVerifier, OIDCNonce: "nonce", ReturnTarget: "/login"}}
	attempts := &attemptStub{state: state, binding: binding, check: check}
	document := []byte(`{"slug":"example","protocol":"oidc","oidc":{"issuer":"` + issuer + `","client_id":"client","client_secret":"${{ PROVIDER_SECRET }}","scopes":["openid"]},"claim_mapping":{"email":"email"}}`)
	input := service.FlowSSOCallbackInput{State: state, BindingNonce: binding, ConnectionSlug: "example", Code: "one-time-code", Issuer: issuer}
	b, err := New(input, attempts, connectionStub{document: document}, keyStub{crypter: crypter}, variableStub{set: variables})
	if err != nil {
		t.Fatal(err)
	}
	next, out, err := b.Advance(ctx, nil)
	if err != nil || out != nil || next == nil || next.Method != "GET" || next.URL != issuer+"/.well-known/openid-configuration" {
		t.Fatalf("discovery intent: %#v %#v %v", next, out, err)
	}
	if attempts.consumes != 1 || attempts.stores != 0 {
		t.Fatal("intermediate discovery stored upstream failure")
	}
	discovery := fmt.Sprintf(`{"issuer":%q,"authorization_endpoint":%q,"token_endpoint":%q,"userinfo_endpoint":%q,"jwks_uri":%q}`, issuer, issuer+"/authorize", issuer+"/token", issuer+"/userinfo", issuer+"/keys")
	next, out, err = b.Advance(ctx, &Response{Status: 200, ContentType: "application/json", Body: discovery})
	if err != nil || out != nil || next == nil || next.Method != "POST" || next.URL != issuer+"/token" || !strings.Contains(next.Body, "code=one-time-code") || !strings.Contains(next.Body, "code_verifier=") {
		t.Fatalf("token intent: %#v %#v %v", next, out, err)
	}
	if attempts.consumes != 1 || attempts.stores != 0 {
		t.Fatal("token intent consumed twice or parked error")
	}
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	signer, err := jose.NewSigner(jose.SigningKey{Algorithm: jose.RS256, Key: &jose.JSONWebKey{Key: key, KeyID: "key"}}, nil)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	idToken, err := jwt.Signed(signer).Claims(map[string]any{"iss": issuer, "aud": "client", "sub": "user", "exp": now.Add(time.Hour).Unix(), "iat": now.Unix(), "nonce": "nonce"}).Serialize()
	if err != nil {
		t.Fatal(err)
	}
	body, _ := json.Marshal(map[string]string{"access_token": "access", "token_type": "Bearer", "id_token": idToken})
	next, out, err = b.Advance(ctx, &Response{Status: 200, ContentType: "application/json", Body: string(body)})
	if err != nil || out != nil || next == nil || next.URL != issuer+"/keys" {
		t.Fatalf("keys intent: %#v %#v %v", next, out, err)
	}
	keys, _ := json.Marshal(jose.JSONWebKeySet{Keys: []jose.JSONWebKey{{Key: &key.PublicKey, KeyID: "key", Algorithm: "RS256", Use: "sig"}}})
	next, out, err = b.Advance(ctx, &Response{Status: 200, ContentType: "application/json", Body: string(keys)})
	if err != nil || out != nil || next == nil || next.URL != issuer+"/userinfo" || next.Authorization != "Bearer access" {
		t.Fatalf("userinfo intent: %#v %#v %v", next, out, err)
	}
	next, out, err = b.Advance(ctx, &Response{Status: 200, ContentType: "application/json", Body: `{"sub":"user","email":"user@example.test"}`})
	if err != nil || next != nil || out == nil || out.Failure != nil || out.ReturnTarget != "/login" {
		t.Fatalf("outcome: %#v %#v %v", next, out, err)
	}
	if attempts.consumes != 1 || attempts.stores != 1 || attempts.event != domain.EventTypeAuthSSOExchangeSucceeded || attempts.result.Subject != "user" || attempts.result.Claims["email"] != "user@example.test" {
		t.Fatal("upstream result or audit not committed once")
	}
	if _, _, err = b.Advance(ctx, nil); !errors.Is(err, ErrInvalidState) {
		t.Fatal("completed callback rerun")
	}
}
