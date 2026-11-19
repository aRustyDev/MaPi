package mapioauth

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/go-jose/go-jose/v4"
	"github.com/zitadel/nextgen/internal/domain"
	"github.com/zitadel/oidc/v3/pkg/oidc"
	"github.com/zitadel/oidc/v3/pkg/op"
)

func TestProviderHTTPAuthorizationCode(t *testing.T) {
	store, grant := fixture(t)
	grant.RedirectURI = "https://shop.example/callback"
	grant.Scope = "openid offline_access"
	if err := store.CreateRefreshSchema(context.Background()); err != nil {
		t.Fatal(err)
	}
	apps := applicationStatementsFixture{client: &domain.ApplicationClient{ProjectID: "proj_A", ApplicationID: "app_A", ID: "row_A", Slug: "web", ClientID: "client_A"}, app: &domain.Application{ID: "app_A", RevisionID: "rev_A", Document: []byte(`{"slug":"shop","name":"Shop","clients":[{"slug":"web","client_id":"client_A","grant_types":["authorization_code","refresh_token"],"redirect_uris":["https://shop.example/callback"]}]}`)}, secrets: []*domain.ApplicationClientSecret{{SecretHash: domain.HashSecret("secret")}}}
	p := &Provider{ProjectID: "proj_A", LoginOrigin: "https://issuer.example", Registry: ClientRegistry{Statements: apps}, Store: store}
	var gotLogin bool
	p.BeginLogin = func(_ context.Context, request *op.ClientRequest[oidc.AuthRequest]) (*op.Redirect, error) {
		a := request.Data
		gotLogin = true
		if a.ClientID != "client_A" || a.RedirectURI != grant.RedirectURI {
			t.Error("incorrect login binding")
		}
		return op.NewRedirect("https://issuer.example/login"), nil
	}
	private, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	p.PublicKeys = func(context.Context) (jose.JSONWebKeySet, error) {
		return jose.JSONWebKeySet{Keys: []jose.JSONWebKey{{Key: &private.PublicKey, KeyID: "kid", Use: "sig", Algorithm: "RS256"}}}, nil
	}
	p.MintCodeTokens = func(ctx context.Context, g AuthorizationCode) (*oidc.AccessTokenResponse, error) {
		if g.SessionID != grant.SessionID {
			t.Error("incorrect session binding")
		}
		refresh, err := store.IssueRefresh(ctx, RefreshGrant{ProjectID: g.ProjectID, ClientID: g.ClientID, UserID: g.UserID, SessionID: g.SessionID, Scope: g.Scope, ExpiresAt: store.Now().Add(time.Hour)})
		if err != nil {
			return nil, err
		}
		return &oidc.AccessTokenResponse{AccessToken: "test-access", IDToken: "test-id", TokenType: "Bearer", RefreshToken: refresh}, nil
	}
	p.MintRefreshTokens = func(context.Context, RefreshGrant) (*oidc.AccessTokenResponse, error) {
		return &oidc.AccessTokenResponse{AccessToken: "new-access", TokenType: "Bearer"}, nil
	}
	p.AuditReuse = func(context.Context, RefreshGrant) error { return nil }
	h := p.Handler()
	keyResponse := httptest.NewRecorder()
	h.ServeHTTP(keyResponse, httptest.NewRequest(http.MethodGet, "https://issuer.example/jwks", nil))
	if keyResponse.Code != http.StatusOK || !strings.Contains(keyResponse.Body.String(), `"kid":"kid"`) {
		t.Fatalf("jwks: %d %s", keyResponse.Code, keyResponse.Body.String())
	}
	query := url.Values{"client_id": {"client_A"}, "redirect_uri": {grant.RedirectURI}, "response_type": {"code"}, "scope": {"openid"}, "code_challenge": {grant.CodeChallenge}, "code_challenge_method": {"S256"}}
	req := httptest.NewRequest(http.MethodGet, "https://issuer.example/authorize?"+query.Encode(), nil)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)
	if w.Code != 302 || !gotLogin {
		t.Fatalf("authorize: %d %s", w.Code, w.Body.String())
	}
	// A buggy login integration cannot redirect a validated request off-origin.
	p.BeginLogin = func(context.Context, *op.ClientRequest[oidc.AuthRequest]) (*op.Redirect, error) {
		return op.NewRedirect("https://evil.example/login"), nil
	}
	badLogin := httptest.NewRecorder()
	h.ServeHTTP(badLogin, httptest.NewRequest(http.MethodGet, "https://issuer.example/authorize?"+query.Encode(), nil))
	if badLogin.Code == http.StatusFound && strings.HasPrefix(badLogin.Header().Get("Location"), "https://evil.example/") {
		t.Fatal("off-origin login redirect accepted")
	}
	p.PublicKeys = func(context.Context) (jose.JSONWebKeySet, error) {
		return jose.JSONWebKeySet{Keys: []jose.JSONWebKey{{Key: private, KeyID: "kid", Use: "sig", Algorithm: "RS256"}}}, nil
	}
	privateKeyResponse := httptest.NewRecorder()
	h.ServeHTTP(privateKeyResponse, httptest.NewRequest(http.MethodGet, "https://issuer.example/jwks", nil))
	if privateKeyResponse.Code == http.StatusOK {
		t.Fatal("private key published")
	}
	query.Set("redirect_uri", "https://evil.example/callback")
	gotLogin = false
	req = httptest.NewRequest(http.MethodGet, "https://issuer.example/authorize?"+query.Encode(), nil)
	w = httptest.NewRecorder()
	h.ServeHTTP(w, req)
	if gotLogin || w.Code == 302 {
		t.Fatalf("unregistered redirect accepted: %d", w.Code)
	}
	code, err := store.Issue(context.Background(), grant)
	if err != nil {
		t.Fatal(err)
	}
	tokenRequest := func(values url.Values, secret string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodPost, "https://issuer.example/token", strings.NewReader(values.Encode()))
		req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		req.SetBasicAuth("client_A", secret)
		w := httptest.NewRecorder()
		h.ServeHTTP(w, req)
		return w
	}
	values := url.Values{"grant_type": {"authorization_code"}, "code": {code}, "redirect_uri": {grant.RedirectURI}, "code_verifier": {verifier}}
	w = tokenRequest(values, "wrong")
	if w.Code == 200 {
		t.Fatal("wrong secret accepted")
	}
	w = tokenRequest(values, "secret")
	if w.Code != 200 {
		t.Fatalf("exchange: %d %s", w.Code, w.Body.String())
	}
	var tokens oidc.AccessTokenResponse
	if err := json.Unmarshal(w.Body.Bytes(), &tokens); err != nil || tokens.RefreshToken == "" {
		t.Fatalf("invalid token response: %s %v", w.Body.String(), err)
	}
	w = tokenRequest(values, "secret")
	if w.Code == 200 {
		t.Fatal("code replay accepted")
	}
	refresh := url.Values{"grant_type": {"refresh_token"}, "refresh_token": {tokens.RefreshToken}}
	w = tokenRequest(refresh, "secret")
	if w.Code != 200 {
		t.Fatalf("refresh: %d %s", w.Code, w.Body.String())
	}
	var rotated oidc.AccessTokenResponse
	if err := json.Unmarshal(w.Body.Bytes(), &rotated); err != nil || rotated.RefreshToken == tokens.RefreshToken || rotated.RefreshToken == "" {
		t.Fatalf("invalid rotation: %s %v", w.Body.String(), err)
	}
	w = tokenRequest(refresh, "secret")
	if w.Code == 200 {
		t.Fatal("refresh replay accepted")
	}
	refresh.Set("refresh_token", rotated.RefreshToken)
	w = tokenRequest(refresh, "secret")
	if w.Code == 200 {
		t.Fatal("reused refresh family remains valid")
	}
}
