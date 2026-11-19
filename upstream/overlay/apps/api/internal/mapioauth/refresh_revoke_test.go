package mapioauth

import (
	"context"
	"errors"
	"testing"
)

func TestRevokeRefreshFamilyIsScopedAndAtomic(t *testing.T) {
	ctx := context.Background()
	store, code := fixture(t)
	if err := store.CreateRefreshSchema(ctx); err != nil {
		t.Fatal(err)
	}
	grant := RefreshGrant{ProjectID: code.ProjectID, ClientID: code.ClientID, UserID: code.UserID, SessionID: code.SessionID, Scope: code.Scope, ExpiresAt: code.ExpiresAt}
	var token string
	if err := store.Transaction(func() error { var err error; token, err = store.IssueRefresh(ctx, grant); return err }); err != nil {
		t.Fatal(err)
	}
	auth := func(context.Context) error { return nil }
	write := func(ctx context.Context, _ RefreshGrant) error {
		_, err := store.DB.ExecContext(ctx, "INSERT INTO issued_tokens VALUES ('revoked')")
		return err
	}
	next, err := store.RotateRefresh(ctx, token, grant.ProjectID, grant.ClientID, func(context.Context, RefreshGrant) error { return nil }, func(context.Context, RefreshGrant) error { return nil })
	if err != nil {
		t.Fatal(err)
	}
	if err = store.RevokeRefresh(ctx, token, "other-project", grant.ClientID, auth, write); err != nil {
		t.Fatal(err)
	}
	failed := errors.New("audit failure")
	if err = store.RevokeRefresh(ctx, token, grant.ProjectID, grant.ClientID, auth, func(context.Context, RefreshGrant) error { return failed }); !errors.Is(err, failed) {
		t.Fatalf("missing audit error: %v", err)
	}
	var count int
	if err = store.DB.QueryRow("SELECT COUNT(*) FROM mapi_oauth_refresh_tokens WHERE revoked_at IS NOT NULL").Scan(&count); err != nil || count != 0 {
		t.Fatalf("revocation failed to roll back: %d %v", count, err)
	}
	if err = store.RevokeRefresh(ctx, token, grant.ProjectID, grant.ClientID, auth, write); err != nil {
		t.Fatal(err)
	}
	if err = store.RevokeRefresh(ctx, token, grant.ProjectID, grant.ClientID, auth, write); err != nil {
		t.Fatal(err)
	}
	if err = store.RevokeRefresh(ctx, "unknown", grant.ProjectID, grant.ClientID, auth, write); err != nil {
		t.Fatal(err)
	}
	if err = store.DB.QueryRow("SELECT COUNT(*) FROM issued_tokens").Scan(&count); err != nil || count != 1 {
		t.Fatalf("repeated audit: %d %v", count, err)
	}
	if _, err = store.RotateRefresh(ctx, next, grant.ProjectID, grant.ClientID, func(context.Context, RefreshGrant) error { return nil }, func(context.Context, RefreshGrant) error { return nil }); !errors.Is(err, ErrInvalidRefresh) {
		t.Fatalf("revoked family remained active: %v", err)
	}
	denied := errors.New("unauthenticated")
	if err = store.RevokeRefresh(ctx, "unknown", grant.ProjectID, grant.ClientID, func(context.Context) error { return denied }, write); !errors.Is(err, denied) {
		t.Fatalf("authentication skipped: %v", err)
	}
}
