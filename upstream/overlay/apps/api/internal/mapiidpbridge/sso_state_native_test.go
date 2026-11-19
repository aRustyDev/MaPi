//go:build mapi_native_e2e && !wasip1

package mapiidpbridge

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/go-jose/go-jose/v4"
	"github.com/go-jose/go-jose/v4/jwt"
	"github.com/zitadel/nextgen/internal/domain"
	"github.com/zitadel/nextgen/internal/service"
	"github.com/zitadel/nextgen/internal/storage/dialect/sqlite"
	"github.com/zitadel/oidc/v3/pkg/op"
	_ "modernc.org/sqlite"
)

// The adapter must reserve and finish the real upstream state, rather than
// manufacturing a parallel callback record. This test intentionally uses the
// native SQLite dialect and a real upstream AES-GCM crypter and audit write.
func TestNativeSSOStateLifecycle(t *testing.T) {
	ctx := context.Background()
	db, err := sql.Open("sqlite", filepath.Join(t.TempDir(), "idp.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	db.SetMaxOpenConns(1)
	native := sqlite.NewMaPiNativeTestPool(db)
	t.Cleanup(func() { _ = native.Close(ctx) })
	if err = native.Migrate(ctx); err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{"proj_idp_a", "proj_idp_b"} {
		if err = native.Statements().CreateProject(ctx, &domain.Project{ID: id, Name: id}); err != nil {
			t.Fatal(err)
		}
	}
	pool := service.NewPool(native)
	attempts := service.NewAuthAttemptService(pool, nil, nil, nil, nil)
	var encryptionKey [32]byte
	copy(encryptionKey[:], "synthetic-test-key")
	crypter := op.NewAES256GCMCrypto(encryptionKey, "synthetic-key")
	makeAttempt := func(project string) (*domain.AuthAttempt, *domain.SSOState) {
		t.Helper()
		a := &domain.AuthAttempt{ProjectID: project}
		if err := native.Statements().CreateAuthAttempt(ctx, a); err != nil {
			t.Fatal(err)
		}
		s, err := attempts.IssueSSOState(ctx, service.IssueSSOStateInput{ProjectID: project, AttemptID: a.ID, ProviderSlug: "external", ConnectionRevisionID: "idprev_synthetic", RedirectURI: "https://app.example.test/idp/callback", ReturnTarget: "/login", PKCEEncrypter: crypter})
		if err != nil {
			t.Fatal(err)
		}
		return a, s
	}
	a, s := makeAttempt("proj_idp_a")
	if s.State == "" || s.BindingNonce == "" || s.OIDCNonce == "" || s.PKCEVerifier == "" {
		t.Fatal("missing generated callback values")
	}
	if s.Check.Pending.EncryptedPKCEVerifier == s.PKCEVerifier || strings.Contains(s.Check.Pending.EncryptedPKCEVerifier, s.PKCEVerifier) {
		t.Fatal("PKCE verifier was stored in plaintext")
	}
	decrypted, err := s.Check.Pending.DecryptPKCEVerifier(crypter)
	if err != nil || decrypted != s.PKCEVerifier {
		t.Fatal("encrypted verifier did not round trip")
	}
	for _, bad := range []struct{ project, binding string }{{"proj_idp_a", ""}, {"proj_idp_a", "wrong-binding"}, {"proj_idp_b", s.BindingNonce}} {
		if _, err = attempts.ConsumeSSOState(ctx, bad.project, s.State, bad.binding); !errors.Is(err, domain.ErrSSOStateInvalid()) {
			t.Fatalf("wrong binding or project accepted: %v", err)
		}
	}
	var stateHash, payload string
	if err = db.QueryRow(`SELECT lookup_hash,challenge_payload FROM checks WHERE project_id=? AND auth_attempt_id=? AND type=?`, a.ProjectID, a.ID, int(domain.AuthCheckTypeSSOCallback)).Scan(&stateHash, &payload); err != nil {
		t.Fatal(err)
	}
	if stateHash != domain.HashSecret(s.State) || strings.Contains(payload, s.State) || strings.Contains(payload, s.BindingNonce) || strings.Contains(payload, s.PKCEVerifier) {
		t.Fatal("state, binding or verifier leaked to stored challenge")
	}
	check, err := attempts.ConsumeSSOState(ctx, a.ProjectID, s.State, s.BindingNonce)
	if err != nil {
		t.Fatal(err)
	}
	if check.AuthAttemptID != a.ID || check.StateHash != domain.HashSecret(s.State) || !check.Pending.MatchesBindingNonce(s.BindingNonce) {
		t.Fatal("consumed callback not bound to issued attempt")
	}
	if _, err = attempts.ConsumeSSOState(ctx, a.ProjectID, s.State, s.BindingNonce); !errors.Is(err, domain.ErrSSOStateInvalid()) {
		t.Fatalf("state replay accepted: %v", err)
	}
	result := &domain.SSOCallbackResult{Subject: "subject-1", ConnectionRevisionID: "idprev_synthetic", Claims: map[string]any{"email": "synthetic@example.test"}}
	if _, err = db.Exec(`CREATE TRIGGER fail_sso_audit BEFORE INSERT ON events WHEN NEW.event_type='auth.sso.exchange.succeeded' BEGIN SELECT RAISE(ABORT,'injected audit failure'); END`); err != nil {
		t.Fatal(err)
	}
	if err = attempts.SetSSOCallbackResult(ctx, a.ProjectID, check, result, domain.EventTypeAuthSSOExchangeSucceeded); err == nil {
		t.Fatal("audit failure unexpectedly committed")
	}
	stored, err := attempts.GetByID(ctx, a.ProjectID, a.ID)
	if err != nil {
		t.Fatal(err)
	}
	callback, ok := stored.SSOCallback()
	if !ok || callback.Pending != nil || callback.Result != nil {
		t.Fatal("failed audit left a callback result or resurrected consumed state")
	}
	var n int
	if err = db.QueryRow(`SELECT count(*) FROM events WHERE project_id=? AND event_type=?`, a.ProjectID, string(domain.EventTypeAuthSSOExchangeSucceeded)).Scan(&n); err != nil || n != 0 {
		t.Fatalf("failed audit persisted: %d %v", n, err)
	}
	if _, err = db.Exec(`DROP TRIGGER fail_sso_audit`); err != nil {
		t.Fatal(err)
	}
	if err = attempts.SetSSOCallbackResult(ctx, a.ProjectID, check, result, domain.EventTypeAuthSSOExchangeSucceeded); err != nil {
		t.Fatal(err)
	}
	stored, err = attempts.GetByID(ctx, a.ProjectID, a.ID)
	if err != nil {
		t.Fatal(err)
	}
	callback, ok = stored.SSOCallback()
	if !ok || callback.Result == nil || callback.Result.Subject != result.Subject || callback.Result.ConnectionRevisionID != result.ConnectionRevisionID {
		t.Fatal("committed identity missing")
	}
	if err = db.QueryRow(`SELECT count(*) FROM events WHERE project_id=? AND event_type=? AND entity_id=?`, a.ProjectID, string(domain.EventTypeAuthSSOExchangeSucceeded), check.ID).Scan(&n); err != nil || n != 1 {
		t.Fatalf("expected one committed audit: %d %v", n, err)
	}
	if err = attempts.SetSSOCallbackResult(ctx, a.ProjectID, check, result, domain.EventTypeAuthSSOExchangeSucceeded); !errors.Is(err, domain.ErrSSOStateInvalid()) {
		t.Fatalf("callback result replay accepted: %v", err)
	}
	if err = db.QueryRow(`SELECT count(*) FROM events WHERE project_id=? AND (payload LIKE ? OR payload LIKE ? OR payload LIKE ?)`, a.ProjectID, "%"+s.State+"%", "%"+s.BindingNonce+"%", "%"+s.PKCEVerifier+"%").Scan(&n); err != nil || n != 0 {
		t.Fatal("callback secrets leaked into audit")
	}

	// Exactly one simultaneous consumer obtains the pending state.
	_, race := makeAttempt("proj_idp_a")
	var wg sync.WaitGroup
	outcomes := make(chan error, 10)
	for i := 0; i < 10; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, e := attempts.ConsumeSSOState(ctx, "proj_idp_a", race.State, race.BindingNonce)
			outcomes <- e
		}()
	}
	wg.Wait()
	close(outcomes)
	successes := 0
	for e := range outcomes {
		if e == nil {
			successes++
		} else if !errors.Is(e, domain.ErrSSOStateInvalid()) {
			t.Fatalf("unexpected consume failure: %v", e)
		}
	}
	if successes != 1 {
		t.Fatalf("concurrent consumers succeeded: %d", successes)
	}

	// Reissuing a callback for the same attempt invalidates a formerly consumed
	// handle, so its late result cannot overwrite the new ceremony.
	a2, first := makeAttempt("proj_idp_a")
	consumed, err := attempts.ConsumeSSOState(ctx, a2.ProjectID, first.State, first.BindingNonce)
	if err != nil {
		t.Fatal(err)
	}
	next, err := attempts.IssueSSOState(ctx, service.IssueSSOStateInput{ProjectID: a2.ProjectID, AttemptID: a2.ID, ProviderSlug: "external", ConnectionRevisionID: "idprev_new", RedirectURI: "https://app.example.test/idp/callback", ReturnTarget: "/login", PKCEEncrypter: crypter})
	if err != nil {
		t.Fatal(err)
	}
	if err = attempts.SetSSOCallbackResult(ctx, a2.ProjectID, consumed, result, domain.EventTypeAuthSSOExchangeSucceeded); !errors.Is(err, domain.ErrSSOStateInvalid()) {
		t.Fatalf("superseded callback wrote result: %v", err)
	}
	if _, err = attempts.ConsumeSSOState(ctx, a2.ProjectID, next.State, next.BindingNonce); err != nil {
		t.Fatalf("fresh state damaged by stale callback: %v", err)
	}

	expiredTTL := time.Nanosecond
	expired := &domain.AuthAttempt{ProjectID: "proj_idp_a", TimeToLive: &expiredTTL}
	if err = native.Statements().CreateAuthAttempt(ctx, expired); err != nil {
		t.Fatal(err)
	}
	expiredState, err := domain.NewSSOState(expired.ProjectID, "external", "idprev_synthetic", "https://app.example.test/idp/callback", "/login", crypter)
	if err != nil {
		t.Fatal(err)
	}
	if err = native.Statements().IssueSSOState(ctx, expired.ProjectID, expired.ID, expiredState.Check); err != nil {
		t.Fatal(err)
	}
	if _, err = attempts.ConsumeSSOState(ctx, expired.ProjectID, expiredState.State, expiredState.BindingNonce); !errors.Is(err, domain.ErrSSOStateInvalid()) {
		t.Fatalf("expired state accepted: %v", err)
	}
}

// This drives the actual FlowSSOCallback through the adapter, with its
// underlying auth-attempt, callback state, result and audit all owned by the
// real upstream SQLite service. Only external configuration and responses are
// synthetic. No network call runs in the upstream transaction.
func TestNativeFlowCallbackBridge(t *testing.T) {
	ctx := context.Background()
	db, err := sql.Open("sqlite", filepath.Join(t.TempDir(), "bridge.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	db.SetMaxOpenConns(1)
	native := sqlite.NewMaPiNativeTestPool(db)
	t.Cleanup(func() { _ = native.Close(ctx) })
	if err = native.Migrate(ctx); err != nil {
		t.Fatal(err)
	}
	if err = native.Statements().CreateProject(ctx, &domain.Project{ID: "proj_1", Name: "Synthetic"}); err != nil {
		t.Fatal(err)
	}
	attempts := service.NewAuthAttemptService(service.NewPool(native), nil, nil, nil, nil)
	crypter := op.NewAES256GCMCrypto([32]byte{1, 2, 3}, "key_1")
	encryptedSecret, err := crypter.Encrypt(`"synthetic-secret"`)
	if err != nil {
		t.Fatal(err)
	}
	vars, err := domain.NewVariableSet("proj_1", []*domain.Variable{{Name: "PROVIDER_SECRET", Value: encryptedSecret, IsSecret: true}})
	if err != nil {
		t.Fatal(err)
	}
	issuer := "https://idp.example"
	document := []byte(`{"slug":"example","protocol":"oidc","oidc":{"issuer":"` + issuer + `","client_id":"client","client_secret":"${{ PROVIDER_SECRET }}","scopes":["openid"]},"claim_mapping":{"email":"email"}}`)
	newCeremony := func() (*domain.AuthAttempt, *domain.SSOState, *Bridge) {
		t.Helper()
		a := &domain.AuthAttempt{ProjectID: "proj_1", DeploymentID: "dep_1"}
		if e := native.Statements().CreateAuthAttempt(ctx, a); e != nil {
			t.Fatal(e)
		}
		s, e := attempts.IssueSSOState(ctx, service.IssueSSOStateInput{ProjectID: "proj_1", AttemptID: a.ID, ProviderSlug: "example", ConnectionRevisionID: "idprev_1", RedirectURI: "https://app.example/callback", ReturnTarget: "/login", PKCEEncrypter: crypter})
		if e != nil {
			t.Fatal(e)
		}
		b, e := New(service.FlowSSOCallbackInput{State: s.State, BindingNonce: s.BindingNonce, ConnectionSlug: "example", Code: "one-time-code", Issuer: issuer}, attempts, connectionStub{document: document}, keyStub{crypter: crypter}, variableStub{set: vars})
		if e != nil {
			t.Fatal(e)
		}
		return a, s, b
	}
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	signer, err := jose.NewSigner(jose.SigningKey{Algorithm: jose.RS256, Key: &jose.JSONWebKey{Key: key, KeyID: "key"}}, nil)
	if err != nil {
		t.Fatal(err)
	}
	jwks, err := json.Marshal(jose.JSONWebKeySet{Keys: []jose.JSONWebKey{{Key: &key.PublicKey, KeyID: "key", Algorithm: "RS256", Use: "sig"}}})
	if err != nil {
		t.Fatal(err)
	}
	run := func(a *domain.AuthAttempt, s *domain.SSOState, b *Bridge, failCommit bool) {
		t.Helper()
		next, out, e := b.Advance(ctx, nil)
		if e != nil || out != nil || next == nil || next.Method != "GET" || next.URL != issuer+"/.well-known/openid-configuration" {
			t.Fatalf("discovery intent: %#v %#v %v", next, out, e)
		}
		if _, e = attempts.ConsumeSSOState(ctx, a.ProjectID, s.State, s.BindingNonce); !errors.Is(e, domain.ErrSSOStateInvalid()) {
			t.Fatalf("state was not burned: %v", e)
		}
		discovery := fmt.Sprintf(`{"issuer":%q,"authorization_endpoint":%q,"token_endpoint":%q,"userinfo_endpoint":%q,"jwks_uri":%q}`, issuer, issuer+"/authorize", issuer+"/token", issuer+"/userinfo", issuer+"/keys")
		next, out, e = b.Advance(ctx, &Response{Status: 200, ContentType: "application/json", Body: discovery})
		if e != nil || out != nil || next == nil || next.Method != "POST" || next.URL != issuer+"/token" || !strings.Contains(next.Body, "code_verifier="+s.PKCEVerifier) {
			t.Fatalf("token intent: %#v %#v %v", next, out, e)
		}
		now := time.Now()
		idToken, e := jwt.Signed(signer).Claims(map[string]any{"iss": issuer, "aud": "client", "sub": "user", "exp": now.Add(time.Hour).Unix(), "iat": now.Unix(), "nonce": s.OIDCNonce}).Serialize()
		if e != nil {
			t.Fatal(e)
		}
		token, e := json.Marshal(map[string]string{"access_token": "access", "token_type": "Bearer", "id_token": idToken})
		if e != nil {
			t.Fatal(e)
		}
		next, out, e = b.Advance(ctx, &Response{Status: 200, ContentType: "application/json", Body: string(token)})
		if e != nil || out != nil || next == nil || next.URL != issuer+"/keys" {
			t.Fatalf("keys intent: %#v %#v %v", next, out, e)
		}
		next, out, e = b.Advance(ctx, &Response{Status: 200, ContentType: "application/json", Body: string(jwks)})
		if e != nil || out != nil || next == nil || next.URL != issuer+"/userinfo" {
			t.Fatalf("userinfo intent: %#v %#v %v", next, out, e)
		}
		var count int
		if e = db.QueryRow(`SELECT count(*) FROM events WHERE project_id=? AND event_type IN (?,?) AND entity_id=?`, a.ProjectID, string(domain.EventTypeAuthSSOExchangeSucceeded), string(domain.EventTypeAuthSSOExchangeFailed), s.Check.ID).Scan(&count); e != nil || count != 0 {
			t.Fatalf("intermediate outcome audit: %d %v", count, e)
		}
		if failCommit {
			if _, e = db.Exec(`CREATE TRIGGER fail_callback_audit BEFORE INSERT ON events WHEN NEW.event_type IN ('auth.sso.exchange.succeeded','auth.sso.exchange.failed') BEGIN SELECT RAISE(ABORT,'injected audit failure'); END`); e != nil {
				t.Fatal(e)
			}
		}
		next, out, e = b.Advance(ctx, &Response{Status: 200, ContentType: "application/json", Body: `{"sub":"user","email":"user@example.test"}`})
		if failCommit {
			if e == nil || next != nil {
				t.Fatalf("failed outcome audit accepted: %#v %v", out, e)
			}
			if _, e = db.Exec(`DROP TRIGGER fail_callback_audit`); e != nil {
				t.Fatal(e)
			}
		} else if e != nil || next != nil || out == nil || out.Failure != nil || out.ReturnTarget != "/login" {
			t.Fatalf("callback result: %#v %v", out, e)
		}
		aNow, e := attempts.GetByID(ctx, a.ProjectID, a.ID)
		if e != nil {
			t.Fatal(e)
		}
		check, ok := aNow.SSOCallback()
		if !ok || check.Pending != nil {
			t.Fatal("unexpected pending state")
		}
		if failCommit {
			if check.Result != nil {
				t.Fatal("failed audit persisted result")
			}
		} else if check.Result == nil || check.Result.Subject != "user" || check.Result.Claims["email"] != "user@example.test" {
			t.Fatal("real upstream result missing")
		}
		if e = db.QueryRow(`SELECT count(*) FROM events WHERE project_id=? AND event_type=? AND entity_id=?`, a.ProjectID, string(domain.EventTypeAuthSSOExchangeSucceeded), s.Check.ID).Scan(&count); e != nil {
			t.Fatal(e)
		}
		expected := 1
		if failCommit {
			expected = 0
		}
		if count != expected {
			t.Fatalf("committed audit count=%d", count)
		}
		if _, _, e = b.Advance(ctx, nil); !errors.Is(e, ErrInvalidState) {
			t.Fatalf("bridge replay accepted: %v", e)
		}
	}
	a, s, b := newCeremony()
	wrong, err := New(service.FlowSSOCallbackInput{State: s.State, BindingNonce: "wrong-browser", ConnectionSlug: "example", Code: "one-time-code", Issuer: issuer}, attempts, connectionStub{document: document}, keyStub{crypter: crypter}, variableStub{set: vars})
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err = wrong.Advance(ctx, nil); !errors.Is(err, domain.ErrSSOStateInvalid()) {
		t.Fatalf("wrong browser consumed callback: %v", err)
	}
	run(a, s, b, false)
	a, s, b = newCeremony()
	run(a, s, b, true)

	// Known outbound failure parks the upstream generic failure and audit.
	// This is a one-way transition: no replay or second result is allowed.
	a, s, b = newCeremony()
	next, out, err := b.Advance(ctx, nil)
	if err != nil || out != nil || next == nil {
		t.Fatalf("abort setup: %#v %v", out, err)
	}
	if err = b.Abort(ctx); err != nil {
		t.Fatal(err)
	}
	stored, err := attempts.GetByID(ctx, a.ProjectID, a.ID)
	if err != nil {
		t.Fatal(err)
	}
	check, ok := stored.SSOCallback()
	if !ok || check.Pending != nil || check.Result == nil || check.Result.ErrorKey != domain.FlowStepErrorSSOFailed {
		t.Fatal("abort did not park upstream failure")
	}
	var count int
	if err = db.QueryRow(`SELECT count(*) FROM events WHERE project_id=? AND event_type=? AND entity_id=?`, a.ProjectID, string(domain.EventTypeAuthSSOExchangeFailed), s.Check.ID).Scan(&count); err != nil || count != 1 {
		t.Fatalf("abort audit count=%d %v", count, err)
	}
	if err = b.Abort(ctx); !errors.Is(err, ErrInvalidState) {
		t.Fatalf("abort replay accepted: %v", err)
	}
	if _, _, err = b.Advance(ctx, nil); !errors.Is(err, ErrInvalidState) {
		t.Fatalf("aborted callback resumed: %v", err)
	}
}
