package mapioauth

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestLoginBridgeBindingAndAtomicity(t *testing.T) {
	ctx := context.Background()
	store, code := fixture(t)
	now := store.Now()
	store.Now = func() time.Time { return now }
	if _, err := store.DB.Exec(`CREATE TABLE login_audit (project_id TEXT NOT NULL)`); err != nil {
		t.Fatal(err)
	}
	failAudit := false
	clientAllowed := true
	bridge := LoginBridge{Store: store, ProjectID: code.ProjectID, LoginTTL: time.Minute, CodeTTL: time.Minute,
		CheckClient: func(_ context.Context, project, client, redirect, scope string) error {
			if !clientAllowed || project != code.ProjectID || client != code.ClientID || redirect != code.RedirectURI || scope != "openid" {
				return ErrInvalidClient
			}
			return nil
		},
		Session: func(_ context.Context, project, credential string) (LoginIdentity, error) {
			if project != code.ProjectID || credential != "verified-session-cookie" {
				return LoginIdentity{}, ErrInvalidLogin
			}
			return LoginIdentity{ProjectID: project, UserID: code.UserID, SessionID: code.SessionID}, nil
		},
		Audit: func(ctx context.Context, grant AuthorizationCode) error {
			if _, err := store.DB.ExecContext(ctx, "INSERT INTO login_audit VALUES (?)", grant.ProjectID); err != nil {
				return err
			}
			if failAudit {
				return errors.New("audit failure")
			}
			return nil
		},
	}
	if err := bridge.CreateSchema(ctx); err != nil {
		t.Fatal(err)
	}
	req := LoginRequest{ClientID: code.ClientID, RedirectURI: code.RedirectURI, Scope: "openid", State: "state-value", Nonce: code.Nonce, CodeChallenge: code.CodeChallenge}
	handle, binding, err := bridge.Begin(ctx, req)
	if err != nil {
		t.Fatal(err)
	}
	var storedHandle, storedBinding []byte
	if err := store.DB.QueryRow("SELECT handle_hash,browser_hash FROM mapi_oauth_logins").Scan(&storedHandle, &storedBinding); err != nil {
		t.Fatal(err)
	}
	if string(storedHandle) == handle || string(storedBinding) == binding {
		t.Fatal("stored plaintext browser credentials")
	}
	_, otherBinding, err := bridge.Begin(ctx, req)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := bridge.Complete(ctx, handle, otherBinding, "verified-session-cookie"); !errors.Is(err, ErrInvalidLogin) {
		t.Fatalf("wrong browser binding: %v", err)
	}
	if _, err := bridge.Complete(ctx, handle, binding, "fake-session"); !errors.Is(err, ErrInvalidLogin) {
		t.Fatalf("invalid session: %v", err)
	}
	otherProject := bridge
	otherProject.ProjectID = "proj_other"
	if _, err := otherProject.Complete(ctx, handle, binding, "verified-session-cookie"); !errors.Is(err, ErrInvalidLogin) {
		t.Fatalf("cross-project completion: %v", err)
	}
	clientAllowed = false
	if _, err := bridge.Complete(ctx, handle, binding, "verified-session-cookie"); !errors.Is(err, ErrInvalidClient) {
		t.Fatalf("removed client accepted: %v", err)
	}
	clientAllowed = true
	failAudit = true
	if _, err := bridge.Complete(ctx, handle, binding, "verified-session-cookie"); err == nil {
		t.Fatal("audit failure committed")
	}
	for _, table := range []string{"mapi_oauth_codes", "login_audit"} {
		var count int
		if err := store.DB.QueryRow("SELECT COUNT(*) FROM " + table).Scan(&count); err != nil || count != 0 {
			t.Fatalf("rollback of %s: %d %v", table, count, err)
		}
	}
	failAudit = false
	var successes atomic.Int32
	var wg sync.WaitGroup
	for range 10 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			result, err := bridge.Complete(ctx, handle, binding, "verified-session-cookie")
			if err == nil {
				if result.State != req.State || result.RedirectURI != req.RedirectURI || result.Code == "" {
					t.Errorf("incorrect completion: %+v", result)
				}
				successes.Add(1)
			} else if !errors.Is(err, ErrInvalidLogin) {
				t.Errorf("unexpected completion: %v", err)
			}
		}()
	}
	wg.Wait()
	if successes.Load() != 1 {
		t.Fatalf("expected one completion, got %d", successes.Load())
	}
	for _, table := range []string{"mapi_oauth_codes", "login_audit"} {
		var count int
		if err := store.DB.QueryRow("SELECT COUNT(*) FROM " + table).Scan(&count); err != nil || count != 1 {
			t.Fatalf("expected one %s: %d %v", table, count, err)
		}
	}
	expired, expiredBinding, err := bridge.Begin(ctx, req)
	if err != nil {
		t.Fatal(err)
	}
	now = now.Add(time.Minute)
	if _, err := bridge.Complete(ctx, expired, expiredBinding, "verified-session-cookie"); !errors.Is(err, ErrInvalidLogin) {
		t.Fatalf("expired login accepted: %v", err)
	}
}

func TestCanonicalLoginScope(t *testing.T) {
	if CanonicalLoginScope([]string{"offline_access", "openid"}) != "openid offline_access" {
		t.Fatal("scope not canonicalized")
	}
	if CanonicalLoginScope([]string{"openid", "profile"}) == "openid" {
		t.Fatal("unsupported scope discarded")
	}
}
