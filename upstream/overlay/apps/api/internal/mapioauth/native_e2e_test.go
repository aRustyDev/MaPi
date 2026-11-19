//go:build mapi_native_e2e && !wasip1

package mapioauth

import (
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/go-jose/go-jose/v4"
	"github.com/go-jose/go-jose/v4/jwt"
	"github.com/zitadel/nextgen/internal/api"
	"github.com/zitadel/nextgen/internal/cache"
	"github.com/zitadel/nextgen/internal/crypto"
	"github.com/zitadel/nextgen/internal/domain"
	"github.com/zitadel/nextgen/internal/service"
	"github.com/zitadel/nextgen/internal/storage/dialect/sqlite"
	configdefaults "github.com/zitadel/nextgen/packages/config/defaults"
	"github.com/zitadel/oidc/v3/pkg/op"
)

type nativeFixture struct {
	BaseURL, ProjectID, ProjectSecret, DBPath string
	User                                      struct{ ID, Email, Password string }
	Key                                       struct{ ID, PEM string }
}

// TestNativeRealRP is run only by scripts/test-native-oidc.mjs with an isolated
// pinned native server. The browser's official component is separately tested
// in workerd; this test drives the same flow HTTP contracts as that component.
func TestNativeRealRP(t *testing.T) {
	var f nativeFixture
	if err := json.Unmarshal([]byte(os.Getenv("MAPI_NATIVE_OIDC_FIXTURE")), &f); err != nil || f.BaseURL == "" {
		t.Skip("requires the isolated native fixture runner")
	}
	ctx := context.Background()
	db, err := sql.Open("sqlite", f.DBPath)
	if err != nil {
		t.Fatal(err)
	}
	db.SetMaxOpenConns(1)
	t.Cleanup(func() { _ = db.Close() })
	var lock sync.Mutex
	store := Store{DB: db, Now: time.Now, Transaction: func(fn func() error) error {
		lock.Lock()
		defer lock.Unlock()
		if _, err := db.Exec("BEGIN"); err != nil {
			return err
		}
		if err := fn(); err != nil {
			_, _ = db.Exec("ROLLBACK")
			return err
		}
		_, err := db.Exec("COMMIT")
		return err
	}}
	pool := service.NewPool(sqlite.NewMaPiNativeTestPool(db))
	rsaKey, err := crypto.ParseRSAKey(f.Key.PEM)
	if err != nil {
		t.Fatal("invalid synthetic key")
	}
	master, err := domain.NewMasterKeys([]domain.MasterKey{domain.NewMasterKey(f.Key.ID, *rsaKey, true)})
	if err != nil {
		t.Fatal(err)
	}
	crypters, err := cache.NewMeteredLRU[service.CrypterCacheKey, op.Crypto](cache.NameCrypter, 64)
	if err != nil {
		t.Fatal(err)
	}
	signing, err := cache.NewMeteredLRU[service.SigningKeyCacheKey, domain.SigningKey](cache.NameSigningKey, 64)
	if err != nil {
		t.Fatal(err)
	}
	keys := service.NewKeyService(pool, *master, crypters, signing)
	validator, err := domain.NewSchemaValidator(configdefaults.DefaultBuiltinSchemaBase)
	if err != nil {
		t.Fatal(err)
	}
	composition, err := Compose(Config{ProjectID: f.ProjectID, Origin: "https://issuer.example", Store: store, Pool: pool, Keys: keys, Tokens: service.NewTokenService(keys, pool), Schemas: validator})
	if err != nil {
		t.Fatal(err)
	}
	if err := composition.Admin.InitializeSchema(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := composition.Admin.EnsureSigningKey(ctx); err != nil {
		t.Fatal(err)
	}
	document := []byte(`{"slug":"rp","name":"Independent RP","clients":[{"slug":"web","type":"confidential","grant_types":["authorization_code","refresh_token"],"redirect_uris":["https://rp.example/callback"]}]}`)
	app, err := composition.Admin.RegisterApplication(ctx, document)
	if err != nil || len(app.Secrets) != 1 {
		t.Fatalf("could not register synthetic RP: %v", err)
	}
	clientID, clientSecret := app.Secrets[0].ClientID, app.Secrets[0].Secret
	verifier := "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~"
	challenge := sha256.Sum256([]byte(verifier))
	parameters := url.Values{"client_id": {clientID}, "redirect_uri": {"https://rp.example/callback"}, "response_type": {"code"}, "scope": {"openid offline_access"}, "state": {"rp-state"}, "nonce": {"rp-nonce"}, "code_challenge_method": {"S256"}, "code_challenge": {base64.RawURLEncoding.EncodeToString(challenge[:])}}
	auth := httptest.NewRecorder()
	composition.Provider.Handler().ServeHTTP(auth, httptest.NewRequest(http.MethodGet, "https://issuer.example/authorize?"+parameters.Encode(), nil))
	if auth.Code != http.StatusFound {
		t.Fatalf("authorize status: %d", auth.Code)
	}
	login, err := url.Parse(auth.Header().Get("Location"))
	if err != nil || login.Host != "issuer.example" {
		t.Fatal("invalid login redirect")
	}
	handle := login.Query().Get("mapi_oauth")
	bindings := auth.Result().Cookies()
	if len(bindings) != 1 || !bindings[0].Secure || !bindings[0].HttpOnly {
		t.Fatal("missing browser binding")
	}

	// The same API requests the official component makes: start, identify,
	// verify password, then exchange its one-time handoff on the server.
	jar, _ := cookiejar.New(nil)
	client := &http.Client{Jar: jar, Timeout: 20 * time.Second}
	var current struct {
		ID           string `json:"id"`
		SessionToken string `json:"session_token"`
		HandoffToken string `json:"handoff_token"`
		Step         struct {
			Fields []struct {
				Name string `json:"name"`
			} `json:"fields"`
		} `json:"step"`
	}
	postJSON := func(path string, body any, bearer string, result any) *http.Response {
		b, err := json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
		r, err := http.NewRequest(http.MethodPost, f.BaseURL+path, bytes.NewReader(b))
		if err != nil {
			t.Fatal(err)
		}
		r.Header.Set("Content-Type", "application/json")
		if bearer != "" {
			r.Header.Set("Authorization", "Bearer "+bearer)
		}
		response, err := client.Do(r)
		if err != nil {
			t.Fatal(err)
		}
		defer response.Body.Close()
		if response.StatusCode < 200 || response.StatusCode >= 300 {
			t.Fatalf("native %s status %d", path, response.StatusCode)
		}
		if err := json.NewDecoder(response.Body).Decode(result); err != nil {
			t.Fatal(err)
		}
		return response
	}
	postJSON("/flows", map[string]any{"project_id": f.ProjectID, "purpose": "login"}, "", &current)
	for i := 0; i < 6 && current.HandoffToken == ""; i++ {
		fields := map[string]string{}
		for _, field := range current.Step.Fields {
			name := strings.ToLower(field.Name[strings.LastIndexAny(field.Name, "#/. ")+1:])
			switch name {
			case "email":
				fields[field.Name] = f.User.Email
			case "password":
				fields[field.Name] = f.User.Password
			default:
				t.Fatalf("unknown login field %q", name)
			}
		}
		body := map[string]any{"action": "submit", "fields": fields}
		if current.SessionToken != "" {
			body["session_token"] = current.SessionToken
		}
		id := current.ID
		current = struct {
			ID           string `json:"id"`
			SessionToken string `json:"session_token"`
			HandoffToken string `json:"handoff_token"`
			Step         struct {
				Fields []struct {
					Name string `json:"name"`
				} `json:"fields"`
			} `json:"step"`
		}{}
		postJSON("/flows/"+url.PathEscape(id)+"/submit", body, "", &current)
	}
	if current.HandoffToken == "" {
		t.Fatal("native flow did not produce handoff")
	}
	var exchange map[string]any
	exchangeResponse := postJSON("/sessions/exchange?project_id="+url.QueryEscape(f.ProjectID), map[string]string{"handoff_token": current.HandoffToken}, f.ProjectSecret, &exchange)
	var sessionCookie string
	for _, c := range exchangeResponse.Cookies() {
		if c.Name == "zitadel_session" || c.Name == "__Host-zitadel_session" {
			sessionCookie = c.Value
		}
	}
	if sessionCookie == "" {
		t.Fatal("upstream session cookie missing")
	}

	continuation := func() *httptest.ResponseRecorder {
		body := url.Values{"request": {handle}, "csrf": {api.CSRFToken(sessionCookie)}}
		r := httptest.NewRequest(http.MethodPost, "https://issuer.example/oauth/continue", strings.NewReader(body.Encode()))
		r.Header.Set("Origin", "https://issuer.example")
		r.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		r.AddCookie(bindings[0])
		r.AddCookie(&http.Cookie{Name: "__Host-zitadel_session", Value: sessionCookie})
		w := httptest.NewRecorder()
		composition.Login.ServeHTTP(w, r)
		return w
	}
	finished := continuation()
	if finished.Code != http.StatusSeeOther {
		t.Fatalf("continuation status: %d", finished.Code)
	}
	callback, err := url.Parse(finished.Header().Get("Location"))
	if err != nil || callback.Host != "rp.example" || callback.Query().Get("state") != "rp-state" {
		t.Fatal("invalid RP callback")
	}
	codeValue := callback.Query().Get("code")
	if codeValue == "" {
		t.Fatal("authorization code missing")
	}
	if replay := continuation(); replay.Code != http.StatusForbidden {
		t.Fatalf("login replay status: %d", replay.Code)
	}
	tokenRequest := func() *httptest.ResponseRecorder {
		body := url.Values{"grant_type": {"authorization_code"}, "code": {codeValue}, "redirect_uri": {"https://rp.example/callback"}, "code_verifier": {verifier}}
		r := httptest.NewRequest(http.MethodPost, "https://issuer.example/token", strings.NewReader(body.Encode()))
		r.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		r.SetBasicAuth(clientID, clientSecret)
		w := httptest.NewRecorder()
		composition.Provider.Handler().ServeHTTP(w, r)
		return w
	}
	tokens := tokenRequest()
	if tokens.Code != http.StatusOK {
		t.Fatalf("token status: %d", tokens.Code)
	}
	var response struct {
		AccessToken  string `json:"access_token"`
		IDToken      string `json:"id_token"`
		RefreshToken string `json:"refresh_token"`
	}
	if err := json.Unmarshal(tokens.Body.Bytes(), &response); err != nil || response.AccessToken == "" || response.IDToken == "" || response.RefreshToken == "" {
		t.Fatal("incomplete RP token response")
	}
	if err := composition.Tokens.ValidateAccess(ctx, response.AccessToken, clientID); err != nil {
		t.Fatal("issued token failed validation")
	}
	// The RP verifies the ID token with the public JWKS and its own expected
	// issuer, audience, subject and nonce; no provider-private keys are used.
	jwksResponse := httptest.NewRecorder()
	composition.Provider.Handler().ServeHTTP(jwksResponse, httptest.NewRequest(http.MethodGet, "https://issuer.example/jwks", nil))
	var jwks jose.JSONWebKeySet
	if jwksResponse.Code != 200 || json.Unmarshal(jwksResponse.Body.Bytes(), &jwks) != nil || len(jwks.Keys) != 1 {
		t.Fatal("RP could not load JWKS")
	}
	signed, err := jwt.ParseSigned(response.IDToken, []jose.SignatureAlgorithm{jose.RS256})
	if err != nil {
		t.Fatal("invalid ID token")
	}
	var claims tokenClaims
	if err := signed.Claims(jwks.Keys[0].Key, &claims); err != nil {
		t.Fatal("ID token signature rejected")
	}
	if err := claims.ValidateWithLeeway(jwt.Expected{Issuer: composition.Issuer, AnyAudience: jwt.Audience{clientID}, Subject: f.User.ID, Time: time.Now()}, 0); err != nil || claims.Nonce != "rp-nonce" {
		t.Fatal("ID token claims rejected")
	}
	if replay := tokenRequest(); replay.Code < 400 {
		t.Fatalf("authorization code replay status: %d", replay.Code)
	}
}
