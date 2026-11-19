package mapioauth

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	_ "modernc.org/sqlite"
)

const verifier = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~"

func fixture(t *testing.T) (Store, AuthorizationCode) {
	t.Helper()
	db, err := sql.Open("sqlite", ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	db.SetMaxOpenConns(1)
	var mu sync.Mutex
	now := time.Unix(1800000000, 123000000)
	store := Store{DB: db, Now: func() time.Time { return now }, Transaction: func(fn func() error) error {
		mu.Lock()
		defer mu.Unlock()
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
	if err := store.CreateSchema(context.Background()); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec("CREATE TABLE issued_tokens (value TEXT NOT NULL)"); err != nil {
		t.Fatal(err)
	}
	hash := sha256.Sum256([]byte(verifier))
	return store, AuthorizationCode{ProjectID: "proj_A", ClientID: "client_A", RedirectURI: "https://app.example/callback", UserID: "user_A", SessionID: "sess_A", Scope: "openid", Nonce: "nonce", CodeChallenge: base64.RawURLEncoding.EncodeToString(hash[:]), ExpiresAt: now.Add(time.Minute)}
}

func TestCodeBindingAndAtomicity(t *testing.T) {
	ctx := context.Background()
	store, grant := fixture(t)
	code, err := store.Issue(ctx, grant)
	if err != nil {
		t.Fatal(err)
	}
	noCommit := func(context.Context, AuthorizationCode) error { t.Error("invalid code reached callback"); return nil }
	for _, test := range []struct{ project, client, redirect, proof string }{
		{"proj_B", grant.ClientID, grant.RedirectURI, verifier},
		{grant.ProjectID, "client_B", grant.RedirectURI, verifier},
		{grant.ProjectID, grant.ClientID, "https://evil.example/", verifier},
		{grant.ProjectID, grant.ClientID, grant.RedirectURI, verifier + "x"},
	} {
		if err := store.Consume(ctx, code, test.project, test.client, test.redirect, test.proof, noCommit); !errors.Is(err, ErrInvalidCode) {
			t.Fatalf("expected invalid code, got %v", err)
		}
	}
	failure := errors.New("failed token write")
	err = store.Consume(ctx, code, grant.ProjectID, grant.ClientID, grant.RedirectURI, verifier, func(ctx context.Context, got AuthorizationCode) error {
		if got != grant {
			t.Errorf("unexpected grant: %+v", got)
		}
		if _, err := store.DB.ExecContext(ctx, "INSERT INTO issued_tokens VALUES ('token')"); err != nil {
			return err
		}
		return failure
	})
	if !errors.Is(err, failure) {
		t.Fatalf("expected callback failure, got %v", err)
	}
	var count int
	if err := store.DB.QueryRow("SELECT COUNT(*) FROM issued_tokens").Scan(&count); err != nil || count != 0 {
		t.Fatalf("failed transaction retained token: count=%d err=%v", count, err)
	}
	var successes atomic.Int32
	var wg sync.WaitGroup
	for range 10 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			err := store.Consume(ctx, code, grant.ProjectID, grant.ClientID, grant.RedirectURI, verifier, func(ctx context.Context, _ AuthorizationCode) error {
				_, err := store.DB.ExecContext(ctx, "INSERT INTO issued_tokens VALUES ('token')")
				return err
			})
			if err == nil {
				successes.Add(1)
			} else if !errors.Is(err, ErrInvalidCode) {
				t.Errorf("unexpected exchange error: %v", err)
			}
		}()
	}
	wg.Wait()
	if successes.Load() != 1 {
		t.Fatalf("expected one successful exchange, got %d", successes.Load())
	}
	if err := store.DB.QueryRow("SELECT COUNT(*) FROM issued_tokens").Scan(&count); err != nil || count != 1 {
		t.Fatalf("expected one committed token: count=%d err=%v", count, err)
	}
}

func TestExpiredCodeAndVerifierValidation(t *testing.T) {
	ctx := context.Background()
	store, grant := fixture(t)
	code, err := store.Issue(ctx, grant)
	if err != nil {
		t.Fatal(err)
	}
	store.Now = func() time.Time { return grant.ExpiresAt }
	if err := store.Consume(ctx, code, grant.ProjectID, grant.ClientID, grant.RedirectURI, verifier, func(context.Context, AuthorizationCode) error { return nil }); !errors.Is(err, ErrInvalidCode) {
		t.Fatalf("expired code accepted: %v", err)
	}
	for _, value := range []string{"short", verifier + "!", string(make([]byte, 129))} {
		if validVerifier(value) {
			t.Fatalf("invalid PKCE verifier accepted")
		}
	}
}
