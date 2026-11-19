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
	"testing"
	"time"

	"github.com/go-jose/go-jose/v4"
	"github.com/go-jose/go-jose/v4/jwt"
	"github.com/zitadel/nextgen/internal/mapidpop"
)

func exerciseFAPIGenerationFence(t *testing.T, p *PrivatePAR, db *sql.DB, now time.Time, client, jkt string, assertion func(string) string, proofSigner jose.Signer) {
	t.Helper()
	ctx := context.Background()
	project := p.Grants.ProjectID
	if _, err := db.Exec(`CREATE TABLE fapi_generation_test_audit(stage TEXT NOT NULL)`); err != nil {
		t.Fatal(err)
	}
	audit := func(ctx context.Context, stage string) error {
		_, err := db.ExecContext(ctx, `INSERT INTO fapi_generation_test_audit VALUES (?)`, stage)
		return err
	}
	login := FAPILogin{Store: p.Store, ProjectID: project, LoginTTL: time.Minute, CodeTTL: time.Minute, Codes: p.Grants, CheckClient: p.PAR.CheckClient, PolicyVersion: p.PAR.PolicyVersion,
		Session: func(_ context.Context, project, cookie string) (LoginIdentity, error) {
			if cookie != "verified" {
				return LoginIdentity{}, ErrInvalidLogin
			}
			return LoginIdentity{ProjectID: project, UserID: "generation-user", SessionID: "generation-session"}, nil
		},
		Audit: func(ctx context.Context, stage string, _ AuthorizationCode, _ string) error { return audit(ctx, stage) }}
	verifier := "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~"
	digest := sha256.Sum256([]byte(verifier))
	challenge := base64.RawURLEncoding.EncodeToString(digest[:])
	makePAR := func(id string) string {
		form := url.Values{"client_id": {client}, "client_assertion_type": {privateKeyAssertionType}, "client_assertion": {assertion("generation-" + id)}, "response_type": {"code"}, "redirect_uri": {"https://rp.example/callback"}, "scope": {"openid"}, "code_challenge": {challenge}, "code_challenge_method": {"S256"}}
		req := httptest.NewRequest(http.MethodPost, p.PAR.Endpoint, strings.NewReader(form.Encode()))
		uri, err := p.PAR.Push(ctx, req, form)
		if err != nil {
			t.Fatal(err)
		}
		return uri
	}
	bump := func() {
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
	}
	begin := func(ctx context.Context, r PushedAuthorizationRequest) error {
		_, _, err := login.BeginInTransaction(ctx, r)
		return err
	}
	// A failed policy update leaves both version and pending authorization live.
	uri := makePAR("rollback")
	current, err := p.Policies.Get(ctx, client)
	if err != nil {
		t.Fatal(err)
	}
	failed := p.Policies
	failure := errors.New("generation audit failure")
	failed.Audit = func(context.Context, FAPIClientPolicy) error { return failure }
	if _, err = failed.Put(ctx, client, current.Audience, current.Scopes, false, current.Version); !errors.Is(err, failure) {
		t.Fatal("policy failure missing")
	}
	if err = p.PAR.Consume(ctx, project, client, uri, begin); err != nil {
		t.Fatalf("failed policy update fenced valid PAR: %v", err)
	}
	stalePAR := makePAR("old-par")
	bump()
	if err = p.PAR.Consume(ctx, project, client, stalePAR, begin); !errors.Is(err, ErrInvalidPAR) {
		t.Fatalf("PAR survived policy regrant: %v", err)
	}
	uri = makePAR("old-login")
	var handle, browser string
	if err = p.PAR.Consume(ctx, project, client, uri, func(ctx context.Context, r PushedAuthorizationRequest) error {
		var e error
		handle, browser, e = login.BeginInTransaction(ctx, r)
		return e
	}); err != nil {
		t.Fatal(err)
	}
	bump()
	if _, err = login.Complete(ctx, handle, browser, "verified"); !errors.Is(err, ErrInvalidLogin) {
		t.Fatalf("login survived policy regrant: %v", err)
	}
	uri = makePAR("old-code")
	if err = p.PAR.Consume(ctx, project, client, uri, func(ctx context.Context, r PushedAuthorizationRequest) error {
		var e error
		handle, browser, e = login.BeginInTransaction(ctx, r)
		return e
	}); err != nil {
		t.Fatal(err)
	}
	completed, err := login.Complete(ctx, handle, browser, "verified")
	if err != nil {
		t.Fatal(err)
	}
	bump()
	nonce, err := p.Nonces.Issue(ctx, mapidpop.NonceScope{ProjectID: project, ClientID: client, Purpose: "token"})
	if err != nil {
		t.Fatal(err)
	}
	makeProof := func(id string) string {
		raw, err := jwt.Signed(proofSigner).Claims(map[string]any{"jti": id, "htm": "POST", "htu": p.Assertions.Issuer + "/token", "iat": now.Unix(), "nonce": nonce}).Serialize()
		if err != nil {
			t.Fatal(err)
		}
		return raw
	}
	exchange := FAPIExchange{Private: p, CheckSession: func(context.Context, string, string, string) error { return nil }, Mint: func(context.Context, FAPIExchangeGrant) ([]byte, error) { return []byte("never"), nil }, Audit: func(ctx context.Context, _ FAPIExchangeGrant) error { return audit(ctx, "exchange") }}
	req := FAPIExchangeRequest{ClientID: client, AssertionType: privateKeyAssertionType, Assertion: assertion("generation-code-exchange"), Proof: makeProof("generation-code-proof"), Code: completed.Code, RedirectURI: completed.RedirectURI, Verifier: verifier}
	var before int
	if err = db.QueryRow(`SELECT COUNT(*) FROM fapi_generation_test_audit`).Scan(&before); err != nil {
		t.Fatal(err)
	}
	if _, err = exchange.ExchangeCode(ctx, req); !errors.Is(err, ErrInvalidCode) {
		t.Fatalf("code survived policy regrant: %v", err)
	}
	var after int
	if err = db.QueryRow(`SELECT COUNT(*) FROM fapi_generation_test_audit`).Scan(&after); err != nil || before != after {
		t.Fatal("failed code exchange audited")
	}
	codeHash := sha256.Sum256([]byte(completed.Code))
	var count int
	if err = db.QueryRow(`SELECT COUNT(*) FROM mapi_fapi_codes WHERE code_hash=?`, codeHash[:]).Scan(&count); err != nil || count != 1 {
		t.Fatal("failed exchange consumed code")
	}
	if err = db.QueryRow(`SELECT COUNT(*) FROM mapi_fapi_policy_bindings WHERE kind=? AND token_hash=?`, "code", codeHash[:]).Scan(&count); err != nil || count != 1 {
		t.Fatal("failed exchange consumed code generation")
	}
	v, err := p.Policies.Get(ctx, client)
	if err != nil {
		t.Fatal(err)
	}
	var refresh string
	if err = p.Store.Transaction(func() error {
		var e error
		refresh, e = p.Grants.IssueRefreshInTransaction(ctx, FAPIRefresh{RefreshGrant: RefreshGrant{ProjectID: project, ClientID: client, UserID: "generation-user", SessionID: "generation-session", Scope: "openid offline_access", ExpiresAt: now.Add(time.Hour)}, DPoPJKT: jkt, PolicyVersion: v.Version})
		return e
	}); err != nil {
		t.Fatal(err)
	}
	bump()
	req = FAPIExchangeRequest{ClientID: client, AssertionType: privateKeyAssertionType, Assertion: assertion("generation-refresh-exchange"), Proof: makeProof("generation-refresh-proof"), RefreshToken: refresh}
	if _, err = exchange.ExchangeRefresh(ctx, req); !errors.Is(err, ErrInvalidRefresh) {
		t.Fatalf("refresh survived policy regrant: %v", err)
	}
}
