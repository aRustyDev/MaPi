package mapioauth

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/go-jose/go-jose/v4"
	"github.com/zitadel/nextgen/internal/api"
	"github.com/zitadel/nextgen/internal/domain"
	"github.com/zitadel/nextgen/internal/service"
	servicemocks "github.com/zitadel/nextgen/internal/service/mocks"
	"github.com/zitadel/oidc/v3/pkg/oidc"
	"github.com/zitadel/oidc/v3/pkg/op"
	"go.uber.org/mock/gomock"
)

func TestLoginHTTPUsesUpstreamSessionAndCSRF(t *testing.T) {
	ctx := context.Background()
	store, code := fixture(t)
	store.Now = time.Now
	inner := store.Transaction
	inTransaction := false
	store.Transaction = func(fn func() error) error {
		return inner(func() error { inTransaction = true; defer func() { inTransaction = false }(); return fn() })
	}
	controller := gomock.NewController(t)
	pool := servicemocks.NewMockPool(controller)
	statements := servicemocks.NewMockAllStatements(controller)
	pool.EXPECT().Statements().Return(statements).AnyTimes()
	keys := servicemocks.NewMockKeyService(controller)
	crypter := op.NewAES256GCMCrypto([32]byte{1, 2, 3}, "enc_key_token")
	keys.EXPECT().GetCrypter(gomock.Any(), "enc_key_token", jose.A256GCM).Return(crypter, nil).AnyTimes()
	now := time.Now()
	user, sessionID := code.UserID, code.SessionID
	session := &domain.Session{ProjectID: code.ProjectID, ID: sessionID, UserID: &user, TokenID: "tkn_test", CreatedAt: now, ExpiresAt: now.Add(time.Hour), Factors: []domain.AuthFactor{domain.SetAuthFactorPassword(now)}}
	credential, err := session.Token(crypter)
	if err != nil {
		t.Fatal(err)
	}
	revoked := false
	statements.EXPECT().GetTokenByID(gomock.Any(), code.ProjectID, session.TokenID).DoAndReturn(func(context.Context, string, string) (*domain.Token, error) {
		if !inTransaction {
			t.Error("token was checked outside issuance transaction")
		}
		if revoked {
			return nil, errors.New("revoked")
		}
		return &domain.Token{ProjectID: code.ProjectID, TokenID: session.TokenID, Type: domain.TokenTypeSessionToken, SessionID: &sessionID}, nil
	}).AnyTimes()
	statements.EXPECT().GetSessionByID(gomock.Any(), code.ProjectID, sessionID).DoAndReturn(func(context.Context, string, string) (*domain.Session, error) {
		if !inTransaction {
			t.Error("session was checked outside issuance transaction")
		}
		return session, nil
	}).AnyTimes()
	db := service.NewPool(pool)
	tokens := service.NewTokenService(keys, db)
	sessions := service.NewSessionService(db, nil, service.SessionConfig{DefaultTTL: time.Hour, MaxTTL: 24 * time.Hour})
	bridge := LoginBridge{Store: store, ProjectID: code.ProjectID, LoginTTL: time.Minute, CodeTTL: time.Minute,
		CheckClient: func(_ context.Context, project, client, redirect, scope string) error {
			if !inTransaction {
				t.Error("client was checked outside issuance transaction")
			}
			if project != code.ProjectID || client != code.ClientID || redirect != code.RedirectURI || scope != "openid" {
				return ErrInvalidClient
			}
			return nil
		},
		Session: NextgenSessionValidator(tokens, sessions, time.Now),
		Audit: func(ctx context.Context, _ AuthorizationCode) error {
			if !inTransaction {
				t.Error("audit was written outside issuance transaction")
			}
			_, err := store.DB.ExecContext(ctx, "INSERT INTO issued_tokens VALUES ('audit')")
			return err
		},
	}
	if err := bridge.CreateSchema(ctx); err != nil {
		t.Fatal(err)
	}
	h := LoginHTTP{Bridge: bridge, Origin: "https://issuer.example"}
	request := &op.ClientRequest[oidc.AuthRequest]{Request: &op.Request[oidc.AuthRequest]{Data: &oidc.AuthRequest{ClientID: code.ClientID, RedirectURI: code.RedirectURI, Scopes: []string{"openid"}, State: "state-value", Nonce: code.Nonce, CodeChallenge: code.CodeChallenge}}}
	redirect, err := h.Begin(ctx, request)
	if err != nil {
		t.Fatal(err)
	}
	loginURL, err := url.Parse(redirect.URL)
	if err != nil {
		t.Fatal(err)
	}
	handle := loginURL.Query().Get("mapi_oauth")
	if !validLoginSecret(handle) {
		t.Fatal("missing opaque handle")
	}
	cookies := (&http.Response{Header: redirect.Header}).Cookies()
	if len(cookies) != 1 || !cookies[0].Secure || !cookies[0].HttpOnly || cookies[0].SameSite != http.SameSiteLaxMode || cookies[0].Name != loginBindingName(handle) {
		t.Fatal("browser binding cookie not secure")
	}
	binding := cookies[0]
	makeRequest := func(method, origin, csrf string, cookie *http.Cookie) *http.Request {
		values := url.Values{"request": {handle}, "csrf": {csrf}}
		r := httptest.NewRequest(method, "https://issuer.example/oauth/continue", strings.NewReader(values.Encode()))
		r.Header.Set("Origin", origin)
		r.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		r.AddCookie(cookie)
		r.AddCookie(&http.Cookie{Name: "__Host-zitadel_session", Value: credential})
		return r
	}
	post := func(origin, csrf string, cookie *http.Cookie) *httptest.ResponseRecorder {
		w := httptest.NewRecorder()
		h.ServeHTTP(w, makeRequest(http.MethodPost, origin, csrf, cookie))
		return w
	}
	csrf := api.CSRFToken(credential)
	get := httptest.NewRequest(http.MethodGet, "https://issuer.example/oauth/continue?request="+handle, nil)
	get.AddCookie(binding)
	get.AddCookie(&http.Cookie{Name: "__Host-zitadel_session", Value: credential})
	getResponse := httptest.NewRecorder()
	h.ServeHTTP(getResponse, get)
	if getResponse.Code != 200 || getResponse.Header().Get("Referrer-Policy") != "strict-origin" || !strings.Contains(getResponse.Body.String(), csrf) || strings.Contains(getResponse.Body.String(), credential) {
		t.Fatal("continuation form did not safely bind to the session")
	}
	if w := post("https://attacker.example", csrf, binding); w.Code != 403 {
		t.Fatalf("cross-origin POST: %d", w.Code)
	}
	if w := post(h.Origin, "wrong", binding); w.Code != 403 {
		t.Fatalf("wrong CSRF: %d", w.Code)
	}
	duplicate := makeRequest(http.MethodPost, h.Origin, csrf, binding)
	duplicate.AddCookie(binding)
	duplicateResponse := httptest.NewRecorder()
	h.ServeHTTP(duplicateResponse, duplicate)
	if duplicateResponse.Code != 403 {
		t.Fatalf("ambiguous binding cookie accepted: %d", duplicateResponse.Code)
	}
	incorrect := *binding
	incorrect.Value = strings.Repeat("a", 43)
	if w := post(h.Origin, csrf, &incorrect); w.Code != 403 {
		t.Fatalf("wrong browser binding: %d", w.Code)
	}
	revoked = true
	if w := post(h.Origin, csrf, binding); w.Code != 403 {
		t.Fatalf("revoked session: %d", w.Code)
	}
	revoked = false
	session.Factors = []domain.AuthFactor{domain.SetAuthFactorUser(now)}
	if w := post(h.Origin, csrf, binding); w.Code != 403 {
		t.Fatalf("identifier-only session: %d", w.Code)
	}
	session.Factors = []domain.AuthFactor{domain.SetAuthFactorPassword(now)}
	session.TokenID = "superseded"
	if w := post(h.Origin, csrf, binding); w.Code != 403 {
		t.Fatalf("superseded session: %d", w.Code)
	}
	session.TokenID = "tkn_test"
	w := post(h.Origin, csrf, binding)
	if w.Code != http.StatusSeeOther {
		t.Fatalf("completion: %d %s", w.Code, w.Body.String())
	}
	location, err := url.Parse(w.Header().Get("Location"))
	if err != nil || location.Host != "app.example" || location.Query().Get("state") != "state-value" || location.Query().Get("code") == "" {
		t.Fatalf("bad redirect: %s", w.Header().Get("Location"))
	}
	if replay := post(h.Origin, csrf, binding); replay.Code != 403 {
		t.Fatalf("replayed completion: %d", replay.Code)
	}
}
