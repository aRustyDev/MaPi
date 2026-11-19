package mapioauth

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"
)

func TestFAPIConsentPreviewDenialAtomicity(t *testing.T) {
	ctx := context.Background()
	store, grant := fixture(t)
	if _, err := store.DB.Exec(`CREATE TABLE fapi_consent_audit(stage TEXT)`); err != nil {
		t.Fatal(err)
	}
	fail := false
	login := FAPILogin{Store: store, ProjectID: grant.ProjectID, LoginTTL: time.Minute, CodeTTL: time.Minute, Codes: fapiLoginTestCodes{store},
		CheckClient: func(_ context.Context, p, c, r, s string) error {
			if p != grant.ProjectID || c != grant.ClientID || r != grant.RedirectURI || s != "openid" {
				return ErrInvalidClient
			}
			return nil
		},
		PolicyVersion: func(context.Context, string, string, string) (int64, error) { return 1, nil },
		Session: func(_ context.Context, p, s string) (LoginIdentity, error) {
			if p != grant.ProjectID || s != "session" {
				return LoginIdentity{}, ErrInvalidLogin
			}
			return LoginIdentity{ProjectID: p, UserID: grant.UserID, SessionID: grant.SessionID}, nil
		},
		Audit: func(ctx context.Context, stage string, _ AuthorizationCode, _ string) error {
			if _, err := store.DB.ExecContext(ctx, `INSERT INTO fapi_consent_audit VALUES (?)`, stage); err != nil {
				return err
			}
			if fail && stage == "login_denied" {
				return errors.New("audit failed")
			}
			return nil
		},
	}
	if err := login.CreateSchema(ctx); err != nil {
		t.Fatal(err)
	}
	var handle, binding string
	request := PushedAuthorizationRequest{ProjectID: grant.ProjectID, ClientID: grant.ClientID, RedirectURI: grant.RedirectURI, Scope: "openid", State: "state", Prompt: "consent", CodeChallenge: grant.CodeChallenge, PolicyVersion: 1}
	if err := store.Transaction(func() error { var err error; handle, binding, err = login.BeginInTransaction(ctx, request); return err }); err != nil {
		t.Fatal(err)
	}
	details, err := login.ConsentPreview(ctx, handle, binding, "session")
	if err != nil || details.ClientID != grant.ClientID || details.Scope != "openid" || details.RedirectURI != grant.RedirectURI {
		t.Fatalf("preview: %v", err)
	}
	if _, err = login.Complete(ctx, handle, binding, "session"); !errors.Is(err, ErrInvalidLogin) {
		t.Fatal("consent prompt bypassed")
	}
	if _, err = login.Deny(ctx, handle, strings.Repeat("a", 43), "session"); !errors.Is(err, ErrInvalidLogin) {
		t.Fatal("incorrect browser accepted")
	}
	if _, err = login.Deny(ctx, handle, binding, "bad"); !errors.Is(err, ErrInvalidLogin) {
		t.Fatal("incorrect session accepted")
	}
	fail = true
	if _, err = login.Deny(ctx, handle, binding, "session"); err == nil {
		t.Fatal("audit failure accepted")
	}
	fail = false
	var n int
	if err = store.DB.QueryRow(`SELECT count(*) FROM fapi_consent_audit WHERE stage='login_denied'`).Scan(&n); err != nil || n != 0 {
		t.Fatal("denial audit persisted after rollback")
	}
	if _, err = login.ConsentPreview(ctx, handle, binding, "session"); err != nil {
		t.Fatal("failed denial consumed login")
	}
	result, err := login.Deny(ctx, handle, binding, "session")
	if err != nil || result.RedirectURI != grant.RedirectURI || result.State != "state" {
		t.Fatalf("denial: %v", err)
	}
	if _, err = login.Deny(ctx, handle, binding, "session"); !errors.Is(err, ErrInvalidLogin) {
		t.Fatal("denial replay accepted")
	}
	if err = store.DB.QueryRow(`SELECT count(*) FROM fapi_consent_audit WHERE stage='login_denied'`).Scan(&n); err != nil || n != 1 {
		t.Fatal("denial audit missing")
	}
}
