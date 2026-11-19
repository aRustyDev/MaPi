package mapioauth

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"testing"
)

func TestRefreshRotationAndReplay(t *testing.T) {
	ctx := context.Background()
	store, codeGrant := fixture(t)
	if err := store.CreateRefreshSchema(ctx); err != nil {
		t.Fatal(err)
	}
	code, err := store.Issue(ctx, codeGrant)
	if err != nil {
		t.Fatal(err)
	}
	grant := RefreshGrant{ProjectID: codeGrant.ProjectID, ClientID: codeGrant.ClientID, UserID: codeGrant.UserID, SessionID: codeGrant.SessionID, Scope: codeGrant.Scope, ExpiresAt: codeGrant.ExpiresAt}
	var refresh string
	err = store.Consume(ctx, code, grant.ProjectID, grant.ClientID, codeGrant.RedirectURI, verifier, func(ctx context.Context, _ AuthorizationCode) error {
		var err error
		refresh, err = store.IssueRefresh(ctx, grant)
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	commit := func(context.Context, RefreshGrant) error { return nil }
	if _, err := store.RotateRefresh(ctx, refresh, "proj_other", grant.ClientID, commit, commit); !errors.Is(err, ErrInvalidRefresh) {
		t.Fatalf("cross-project refresh accepted: %v", err)
	}
	failed := errors.New("session unavailable")
	if token, err := store.RotateRefresh(ctx, refresh, grant.ProjectID, grant.ClientID, func(context.Context, RefreshGrant) error { return failed }, commit); !errors.Is(err, failed) || token != "" {
		t.Fatalf("failed rotation returned a token: %v", err)
	}
	next, err := store.RotateRefresh(ctx, refresh, grant.ProjectID, grant.ClientID, commit, commit)
	if err != nil || next == "" || next == refresh {
		t.Fatalf("rotation failed: %v", err)
	}
	if _, err := store.RotateRefresh(ctx, refresh, grant.ProjectID, grant.ClientID, commit, func(context.Context, RefreshGrant) error { return failed }); !errors.Is(err, failed) {
		t.Fatalf("failed reuse audit must roll back: %v", err)
	}
	if _, err := store.RotateRefresh(ctx, refresh, grant.ProjectID, grant.ClientID, commit, commit); !errors.Is(err, ErrRefreshReuse) {
		t.Fatalf("reuse did not revoke family: %v", err)
	}
	if _, err := store.RotateRefresh(ctx, next, grant.ProjectID, grant.ClientID, commit, commit); !errors.Is(err, ErrInvalidRefresh) {
		t.Fatalf("family member survived replay: %v", err)
	}
}

func TestConcurrentRefreshReuseRevokesFamily(t *testing.T) {
	ctx := context.Background()
	store, codeGrant := fixture(t)
	if err := store.CreateRefreshSchema(ctx); err != nil {
		t.Fatal(err)
	}
	grant := RefreshGrant{ProjectID: codeGrant.ProjectID, ClientID: codeGrant.ClientID, UserID: codeGrant.UserID, SessionID: codeGrant.SessionID, Scope: codeGrant.Scope, ExpiresAt: codeGrant.ExpiresAt}
	var original string
	if err := store.Transaction(func() error {
		var err error
		original, err = store.IssueRefresh(ctx, grant)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	callback := func(context.Context, RefreshGrant) error { return nil }
	var successes, reuses atomic.Int32
	var replacement string
	var mu sync.Mutex
	var wg sync.WaitGroup
	for range 10 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			token, err := store.RotateRefresh(ctx, original, grant.ProjectID, grant.ClientID, callback, callback)
			switch {
			case err == nil:
				successes.Add(1)
				mu.Lock()
				replacement = token
				mu.Unlock()
			case errors.Is(err, ErrRefreshReuse):
				reuses.Add(1)
			case errors.Is(err, ErrInvalidRefresh):
			default:
				t.Errorf("unexpected refresh error: %v", err)
			}
		}()
	}
	wg.Wait()
	if successes.Load() != 1 || reuses.Load() != 1 {
		t.Fatalf("expected one rotation and one replay detection, got %d and %d", successes.Load(), reuses.Load())
	}
	if _, err := store.RotateRefresh(ctx, replacement, grant.ProjectID, grant.ClientID, callback, callback); !errors.Is(err, ErrInvalidRefresh) {
		t.Fatalf("replacement survived replay: %v", err)
	}
}
