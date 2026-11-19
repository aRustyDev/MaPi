//go:build mapi_native_e2e && !wasip1

package mapioauth

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func exerciseFAPIReload(t *testing.T, p *PrivatePAR, db *sql.DB, now *time.Time, client string, assertion func(string) string) {
	t.Helper()
	ctx := context.Background()
	project := p.Grants.ProjectID
	if _, err := db.Exec(`CREATE TABLE fapi_reload_test_audit(stage TEXT NOT NULL)`); err != nil {
		t.Fatal(err)
	}
	failAudit := false
	login := FAPILogin{Store: p.Store, ProjectID: project, LoginTTL: 5 * time.Minute, CodeTTL: time.Minute, Codes: p.Grants, CheckClient: p.PAR.CheckClient, PolicyVersion: p.PAR.PolicyVersion,
		Session: func(_ context.Context, project, cookie string) (LoginIdentity, error) {
			if cookie != "session-A" && cookie != "session-B" {
				return LoginIdentity{}, ErrInvalidLogin
			}
			return LoginIdentity{ProjectID: project, UserID: "user-" + cookie, SessionID: cookie}, nil
		},
		Audit: func(ctx context.Context, stage string, _ AuthorizationCode, _ string) error {
			if _, err := db.ExecContext(ctx, `INSERT INTO fapi_reload_test_audit VALUES (?)`, stage); err != nil {
				return err
			}
			if failAudit {
				return errors.New("injected login audit")
			}
			return nil
		}}
	httpLogin := FAPILoginHTTP{Private: p, Login: login, Origin: "https://issuer.example", Issuer: p.Assertions.Issuer}
	verifier := "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~"
	sum := sha256.Sum256([]byte(verifier))
	makePAR := func(id, prompt string) string {
		values := url.Values{"client_id": {client}, "client_assertion_type": {privateKeyAssertionType}, "client_assertion": {assertion("reload-" + id)}, "response_type": {"code"}, "redirect_uri": {"https://rp.example/callback"}, "scope": {"openid"}, "code_challenge": {base64.RawURLEncoding.EncodeToString(sum[:])}, "code_challenge_method": {"S256"}}
		if prompt != "" {
			values.Set("prompt", prompt)
		}
		r := httptest.NewRequest(http.MethodPost, p.PAR.Endpoint, strings.NewReader(values.Encode()))
		uri, err := p.PAR.Push(ctx, r, values)
		if err != nil {
			t.Fatal(err)
		}
		return uri
	}
	authorize := func(uri, session string, cookies ...*http.Cookie) *httptest.ResponseRecorder {
		values := url.Values{"client_id": {client}, "request_uri": {uri}}
		r := httptest.NewRequest(http.MethodGet, p.Assertions.Issuer+"/authorize?"+values.Encode(), nil)
		for _, cookie := range cookies {
			r.AddCookie(cookie)
		}
		if session != "" {
			r.AddCookie(&http.Cookie{Name: "__Host-zitadel_session", Value: session})
		}
		w := httptest.NewRecorder()
		httpLogin.Authorize(w, r)
		return w
	}
	cookiePair := func(w *httptest.ResponseRecorder) (*http.Cookie, *http.Cookie) {
		var reload, binding *http.Cookie
		for _, c := range w.Result().Cookies() {
			if strings.HasPrefix(c.Name, "__Host-mapi-par-") {
				reload = c
			}
			if strings.HasPrefix(c.Name, "__Host-mapi-oauth-") {
				binding = c
			}
			if !c.Secure || !c.HttpOnly {
				t.Fatal("insecure browser binding cookie")
			}
		}
		if reload == nil || binding == nil {
			t.Fatal("missing reload binding cookies")
		}
		return reload, binding
	}
	var before int
	if err := db.QueryRow(`SELECT COUNT(*) FROM fapi_reload_test_audit`).Scan(&before); err != nil {
		t.Fatal(err)
	}
	uri := makePAR("rollback", "")
	failAudit = true
	if w := authorize(uri, "session-A"); w.Code != 400 {
		t.Fatal("failed login audit accepted")
	}
	failAudit = false
	var count int
	if err := db.QueryRow(`SELECT COUNT(*) FROM mapi_fapi_reload`).Scan(&count); err != nil || count != 0 {
		t.Fatal("failed login left reload mapping")
	}
	first := authorize(uri, "session-A")
	if first.Code != http.StatusSeeOther {
		t.Fatalf("initial authorization: %d", first.Code)
	}
	reload, binding := cookiePair(first)
	destination := first.Header().Get("Location")
	if w := authorize(uri, "session-A"); w.Code != 400 {
		t.Fatal("different browser resumed PAR")
	}
	if w := authorize(uri, "session-A", reload); w.Code != 400 {
		t.Fatal("missing browser binding accepted")
	}
	if w := authorize(uri, "session-B", reload, binding); w.Code != 400 {
		t.Fatal("different session resumed login")
	}
	if w := authorize(uri, "session-A", reload, reload, binding); w.Code != 400 {
		t.Fatal("duplicate cookie accepted")
	}
	var good atomic.Int32
	var wg sync.WaitGroup
	for n := 0; n < 10; n++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			w := authorize(uri, "session-A", reload, binding)
			if w.Code == http.StatusSeeOther && w.Header().Get("Location") == destination {
				good.Add(1)
			}
		}()
	}
	wg.Wait()
	if good.Load() != 10 {
		t.Fatalf("same-browser reloads=%d", good.Load())
	}
	if err := db.QueryRow(`SELECT COUNT(*) FROM fapi_reload_test_audit`).Scan(&count); err != nil || count != before+1 {
		t.Fatal("reload created another authorization")
	}
	if _, err := login.Complete(ctx, reload.Value, binding.Value, "session-B"); err == nil {
		t.Fatal("different session completed login")
	}
	completed, err := login.Complete(ctx, reload.Value, binding.Value, "session-A")
	if err != nil || completed.Code == "" {
		t.Fatalf("same session completion: %v", err)
	}
	if w := authorize(uri, "session-A", reload, binding); w.Code != 400 {
		t.Fatal("completed login resumed")
	}
	// If authorization began anonymously, the first verified session binds it.
	anonymous := makePAR("anonymous", "")
	w := authorize(anonymous, "")
	if w.Code != 303 {
		t.Fatal("anonymous authorization failed")
	}
	reload, binding = cookiePair(w)
	if w = authorize(anonymous, "", reload, binding); w.Code != 303 {
		t.Fatal("anonymous reload failed")
	}
	if w = authorize(anonymous, "session-A", reload, binding); w.Code != 303 {
		t.Fatal("first session binding failed")
	}
	if w = authorize(anonymous, "session-B", reload, binding); w.Code != 400 {
		t.Fatal("bound anonymous login accepted different session")
	}
	if _, err = login.Complete(ctx, reload.Value, binding.Value, "session-A"); err != nil {
		t.Fatal(err)
	}
	// Preview binds the first verified session even without an intervening
	// authorization-page reload.
	previewURI := makePAR("preview-session", "")
	w = authorize(previewURI, "")
	if w.Code != 303 {
		t.Fatal("preview setup failed")
	}
	reload, binding = cookiePair(w)
	if _, err = login.RedirectURI(ctx, reload.Value, binding.Value, "session-A"); err != nil {
		t.Fatalf("session preview failed: %v", err)
	}
	if w = authorize(previewURI, "session-B", reload, binding); w.Code != 400 {
		t.Fatal("preview-bound session changed")
	}
	if _, err = login.Complete(ctx, reload.Value, binding.Value, "session-B"); !errors.Is(err, ErrInvalidLogin) {
		t.Fatal("preview session binding bypassed")
	}
	if _, err = login.Complete(ctx, reload.Value, binding.Value, "session-A"); err != nil {
		t.Fatal(err)
	}
	// Consent prompt cannot use the ordinary completion path.
	consent := makePAR("consent", "consent")
	w = authorize(consent, "session-A")
	if w.Code != 303 {
		t.Fatal("consent authorization failed")
	}
	reload, binding = cookiePair(w)
	if _, err = login.Complete(ctx, reload.Value, binding.Value, "session-A"); !errors.Is(err, ErrInvalidLogin) {
		t.Fatalf("consent bypass: %v", err)
	}
	if _, err = login.CompleteWithConsent(ctx, reload.Value, binding.Value, "session-A"); err != nil {
		t.Fatalf("explicit consent failed: %v", err)
	}
	// The PAR expiry still governs reload, even if login remains pending.
	expired := makePAR("expiry", "")
	w = authorize(expired, "")
	if w.Code != 303 {
		t.Fatal("expiry authorization failed")
	}
	reload, binding = cookiePair(w)
	original := *now
	*now = original.Add(time.Minute)
	if w = authorize(expired, "", reload, binding); w.Code != 400 {
		t.Fatal("expired PAR resumed")
	}
	*now = original
	// A durable policy update fences a previously bound browser reload.
	fenced := makePAR("policy", "")
	w = authorize(fenced, "")
	if w.Code != 303 {
		t.Fatal("policy authorization failed")
	}
	reload, binding = cookiePair(w)
	v, err := p.Policies.Get(ctx, client)
	if err != nil {
		t.Fatal(err)
	}
	v, err = p.Policies.Put(ctx, client, v.Audience, v.Scopes, false, v.Version)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = p.Policies.Put(ctx, client, v.Audience, v.Scopes, true, v.Version); err != nil {
		t.Fatal(err)
	}
	if w = authorize(fenced, "", reload, binding); w.Code != 400 {
		t.Fatal("policy-revoked reload resumed")
	}
}
