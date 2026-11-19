package mapioauth

import (
	"context"
	"crypto/sha256"
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

type fapiLoginTestCodes struct{ store Store }

func (c fapiLoginTestCodes) IssueCodeInTransaction(ctx context.Context, grant AuthorizationCode, jkt string) (string, error) {
	_, err := c.store.DB.ExecContext(ctx, "INSERT INTO fapi_test_codes VALUES (?,?,?,?)", grant.ProjectID, grant.UserID, grant.SessionID, jkt)
	return "code-test", err
}

func TestFAPILoginKeepsPARBindingAndAtomicity(t *testing.T) {
	ctx := context.Background()
	store, grant := fixture(t)
	now := store.Now()
	store.Now = func() time.Time { return now }
	for _, q := range []string{"CREATE TABLE fapi_test_codes (project_id TEXT,user_id TEXT,session_id TEXT,jkt TEXT)", "CREATE TABLE fapi_test_audit (stage TEXT)"} {
		if _, err := store.DB.Exec(q); err != nil {
			t.Fatal(err)
		}
	}
	key := sha256.Sum256([]byte("dpop-public-key"))
	jkt := base64.RawURLEncoding.EncodeToString(key[:])
	auditFail := ""
	clientAllowed := true
	check := func(_ context.Context, project, client, redirect, scope string) error {
		if !clientAllowed || project != grant.ProjectID || client != grant.ClientID || redirect != grant.RedirectURI || scope != "openid" {
			return ErrInvalidClient
		}
		return nil
	}
	audit := func(ctx context.Context, stage string) error {
		if _, err := store.DB.ExecContext(ctx, "INSERT INTO fapi_test_audit VALUES (?)", stage); err != nil {
			return err
		}
		if auditFail == stage {
			return errors.New("injected audit failure")
		}
		return nil
	}
	par := PARStore{Store: store, ProjectID: grant.ProjectID, Endpoint: "https://issuer.example/par", TTL: time.Minute,
		PolicyVersion: func(context.Context, string, string, string) (int64, error) { return 1, nil },
		Authenticate:  func(context.Context, *http.Request, url.Values) (string, error) { return grant.ClientID, nil },
		VerifyDPoP: func(_ context.Context, client, proof, claimed, endpoint string) (string, error) {
			if client != grant.ClientID || proof != "proof" || claimed != jkt || endpoint != "https://issuer.example/par" {
				return "", ErrInvalidDPoP
			}
			return jkt, nil
		},
		CheckClient: check, Audit: func(ctx context.Context, stage string, _ PushedAuthorizationRequest) error {
			return audit(ctx, "par_"+stage)
		},
	}
	login := FAPILogin{Store: store, ProjectID: grant.ProjectID, LoginTTL: time.Minute, CodeTTL: time.Minute, Codes: fapiLoginTestCodes{store}, CheckClient: check, PolicyVersion: func(context.Context, string, string, string) (int64, error) { return 1, nil },
		Session: func(_ context.Context, project, cookie string) (LoginIdentity, error) {
			if project != grant.ProjectID || cookie != "verified-session" {
				return LoginIdentity{}, ErrInvalidLogin
			}
			return LoginIdentity{ProjectID: project, UserID: grant.UserID, SessionID: grant.SessionID}, nil
		},
		Audit: func(ctx context.Context, stage string, _ AuthorizationCode, _ string) error { return audit(ctx, stage) },
	}
	if err := par.CreatePARSchema(ctx); err != nil {
		t.Fatal(err)
	}
	if err := login.CreateSchema(ctx); err != nil {
		t.Fatal(err)
	}
	form := url.Values{"client_id": {grant.ClientID}, "client_assertion_type": {"urn:ietf:params:oauth:client-assertion-type:jwt-bearer"}, "client_assertion": {"signed-test"}, "response_type": {"code"}, "redirect_uri": {grant.RedirectURI}, "scope": {"openid"}, "state": {"rp-state"}, "nonce": {"rp-nonce"}, "code_challenge": {grant.CodeChallenge}, "code_challenge_method": {"S256"}, "dpop_jkt": {jkt}}
	req := httptest.NewRequest(http.MethodPost, par.Endpoint, strings.NewReader(form.Encode()))
	req.Header.Set("DPoP", "proof")
	requestURI, err := par.Push(ctx, req, form)
	if err != nil {
		t.Fatal(err)
	}
	var handle, binding string
	begin := func(ctx context.Context, r PushedAuthorizationRequest) error {
		var err error
		handle, binding, err = login.BeginInTransaction(ctx, r)
		return err
	}
	auditFail = "login_started"
	if err := par.Consume(ctx, grant.ProjectID, grant.ClientID, requestURI, begin); err == nil {
		t.Fatal("failed login audit committed PAR")
	}
	var count int
	if err := store.DB.QueryRow("SELECT COUNT(*) FROM mapi_fapi_logins").Scan(&count); err != nil || count != 0 {
		t.Fatal("failed login persisted")
	}
	auditFail = ""
	if err := par.Consume(ctx, grant.ProjectID, grant.ClientID, requestURI, begin); err != nil {
		t.Fatal(err)
	}
	if err := par.Consume(ctx, grant.ProjectID, grant.ClientID, requestURI, begin); !errors.Is(err, ErrInvalidPAR) {
		t.Fatalf("PAR replay: %v", err)
	}
	if redirect, err := login.RedirectURI(ctx, handle, binding, "verified-session"); err != nil || redirect != grant.RedirectURI {
		t.Fatal("valid preview failed")
	}
	if _, err := login.RedirectURI(ctx, handle, strings.Repeat("a", 43), "verified-session"); !errors.Is(err, ErrInvalidLogin) {
		t.Fatal("preview accepted wrong binding")
	}
	if _, err := login.RedirectURI(ctx, handle, binding, "other-session"); !errors.Is(err, ErrInvalidLogin) {
		t.Fatal("preview accepted wrong session")
	}
	if _, err := login.Complete(ctx, handle, strings.Repeat("a", 43), "verified-session"); !errors.Is(err, ErrInvalidLogin) {
		t.Fatalf("wrong browser binding: %v", err)
	}
	if _, err := login.Complete(ctx, handle, binding, "other-session"); !errors.Is(err, ErrInvalidLogin) {
		t.Fatalf("wrong session: %v", err)
	}
	clientAllowed = false
	if _, err := login.RedirectURI(ctx, handle, binding, "verified-session"); !errors.Is(err, ErrInvalidClient) {
		t.Fatal("preview accepted revoked client")
	}
	if _, err := login.Complete(ctx, handle, binding, "verified-session"); !errors.Is(err, ErrInvalidClient) {
		t.Fatalf("revoked client: %v", err)
	}
	clientAllowed = true
	auditFail = "code_issued"
	if _, err := login.Complete(ctx, handle, binding, "verified-session"); err == nil {
		t.Fatal("failed code audit committed")
	}
	if err := store.DB.QueryRow("SELECT COUNT(*) FROM fapi_test_codes").Scan(&count); err != nil || count != 0 {
		t.Fatal("code survived rollback")
	}
	auditFail = ""
	var successes atomic.Int32
	var wg sync.WaitGroup
	for range 10 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			result, err := login.Complete(ctx, handle, binding, "verified-session")
			if err == nil {
				if result.State != "rp-state" || result.RedirectURI != grant.RedirectURI || result.Code != "code-test" {
					t.Error("incorrect RP response")
				}
				successes.Add(1)
			} else if !errors.Is(err, ErrInvalidLogin) {
				t.Errorf("unexpected completion: %v", err)
			}
		}()
	}
	wg.Wait()
	if successes.Load() != 1 {
		t.Fatalf("expected exactly one completion, got %d", successes.Load())
	}
	var savedJKT, project, user, session string
	if err := store.DB.QueryRow("SELECT project_id,user_id,session_id,jkt FROM fapi_test_codes").Scan(&project, &user, &session, &savedJKT); err != nil || project != grant.ProjectID || user != grant.UserID || session != grant.SessionID || savedJKT != jkt {
		t.Fatal("PAR DPoP or session binding was lost")
	}
	// Optional PAR code binding is retained as empty; a future token endpoint
	// must nevertheless require a fresh DPoP proof and bind the token to it.
	request := PushedAuthorizationRequest{ProjectID: grant.ProjectID, ClientID: grant.ClientID, RedirectURI: grant.RedirectURI, Scope: "openid", CodeChallenge: grant.CodeChallenge, PolicyVersion: 1}
	if err := store.Transaction(func() error { var err error; handle, binding, err = login.BeginInTransaction(ctx, request); return err }); err != nil {
		t.Fatal(err)
	}
	if _, err := login.Complete(ctx, handle, binding, "verified-session"); err != nil {
		t.Fatal(err)
	}
	if err := store.DB.QueryRow("SELECT jkt FROM fapi_test_codes WHERE jkt='' LIMIT 1").Scan(&savedJKT); err != nil || savedJKT != "" {
		t.Fatal("optional code binding not preserved")
	}
	if err := store.Transaction(func() error { var err error; handle, binding, err = login.BeginInTransaction(ctx, request); return err }); err != nil {
		t.Fatal(err)
	}
	now = now.Add(time.Minute)
	if _, err := login.RedirectURI(ctx, handle, binding, "verified-session"); !errors.Is(err, ErrInvalidLogin) {
		t.Fatal("expired preview accepted")
	}
	if _, err := login.Complete(ctx, handle, binding, "verified-session"); !errors.Is(err, ErrInvalidLogin) {
		t.Fatal("expired login completed")
	}
}

func TestFAPILoginAndGrantStoreKeyBinding(t *testing.T) {
	ctx := context.Background()
	store, grant := fixture(t)
	grants := FAPIGrants{Store: store, ProjectID: grant.ProjectID}
	if err := grants.CreateSchema(ctx); err != nil {
		t.Fatal(err)
	}
	f := FAPILogin{Store: store, ProjectID: grant.ProjectID, LoginTTL: time.Minute, CodeTTL: time.Minute, Codes: grants,
		CheckClient: func(context.Context, string, string, string, string) error { return nil }, PolicyVersion: func(context.Context, string, string, string) (int64, error) { return 1, nil },
		Session: func(_ context.Context, project, cookie string) (LoginIdentity, error) {
			if cookie != "verified-session" {
				return LoginIdentity{}, ErrInvalidLogin
			}
			return LoginIdentity{ProjectID: project, UserID: grant.UserID, SessionID: grant.SessionID}, nil
		},
		Audit: func(context.Context, string, AuthorizationCode, string) error { return nil },
	}
	if err := f.CreateSchema(ctx); err != nil {
		t.Fatal(err)
	}
	hash := sha256.Sum256([]byte("bound key"))
	key := base64.RawURLEncoding.EncodeToString(hash[:])
	otherHash := sha256.Sum256([]byte("other key"))
	other := base64.RawURLEncoding.EncodeToString(otherHash[:])
	for _, binding := range []string{key, ""} {
		request := PushedAuthorizationRequest{ProjectID: grant.ProjectID, ClientID: grant.ClientID, RedirectURI: grant.RedirectURI, Scope: "openid", CodeChallenge: grant.CodeChallenge, DPoPJKT: binding, PolicyVersion: 1}
		var handle, cookie string
		if err := store.Transaction(func() error { var err error; handle, cookie, err = f.BeginInTransaction(ctx, request); return err }); err != nil {
			t.Fatal(err)
		}
		complete, err := f.Complete(ctx, handle, cookie, "verified-session")
		if err != nil {
			t.Fatal(err)
		}
		if err := store.Transaction(func() error {
			_, err := grants.ConsumeCodeInTransaction(ctx, complete.Code, grant.ClientID, grant.RedirectURI, verifier, "")
			return err
		}); !errors.Is(err, ErrInvalidCode) {
			t.Fatalf("missing proof thumbprint: %v", err)
		}
		if binding != "" {
			if err := store.Transaction(func() error {
				_, err := grants.ConsumeCodeInTransaction(ctx, complete.Code, grant.ClientID, grant.RedirectURI, verifier, other)
				return err
			}); !errors.Is(err, ErrInvalidCode) {
				t.Fatalf("wrong proof key: %v", err)
			}
		}
		var consumed FAPICode
		if err := store.Transaction(func() error {
			var err error
			consumed, err = grants.ConsumeCodeInTransaction(ctx, complete.Code, grant.ClientID, grant.RedirectURI, verifier, key)
			return err
		}); err != nil {
			t.Fatal(err)
		}
		if consumed.DPoPJKT != key || consumed.UserID != grant.UserID || consumed.SessionID != grant.SessionID {
			t.Fatal("token proof or session binding was lost")
		}
		if err := store.Transaction(func() error {
			_, err := grants.ConsumeCodeInTransaction(ctx, complete.Code, grant.ClientID, grant.RedirectURI, verifier, key)
			return err
		}); !errors.Is(err, ErrInvalidCode) {
			t.Fatalf("code replay: %v", err)
		}
	}
}
