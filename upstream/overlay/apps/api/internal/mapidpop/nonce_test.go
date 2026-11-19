package mapidpop

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"errors"
	"fmt"
	"sync"
	"testing"
	"time"
)

func nonceStore(t *testing.T, db *sql.DB, now *time.Time, audit func(context.Context, NonceScope) error) NonceStore {
	t.Helper()
	var mu sync.Mutex
	if err := InitNonceSchema(context.Background(), db); err != nil {
		t.Fatal(err)
	}
	return NonceStore{DB: db, Now: func() time.Time { return *now }, TTL: time.Minute, Audit: audit, Transaction: func(fn func() error) error {
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
}
func TestNonceIssueResolveAndScope(t *testing.T) {
	ctx := context.Background()
	db := dbForTest(t)
	now := time.Unix(1700000000, 0)
	scope := NonceScope{"proj_a", "client_a", "par"}
	if _, err := db.Exec(`CREATE TABLE nonce_audit (event TEXT)`); err != nil {
		t.Fatal(err)
	}
	store := nonceStore(t, db, &now, func(context.Context, NonceScope) error {
		_, err := db.Exec(`INSERT INTO nonce_audit VALUES ('issued')`)
		return err
	})
	value, err := store.Issue(ctx, scope)
	if err != nil {
		t.Fatal(err)
	}
	if len(value) != 43 {
		t.Fatal("wrong nonce length")
	}
	hash := sha256.Sum256([]byte(value))
	var saved []byte
	if err = db.QueryRow(`SELECT nonce_hash FROM mapi_dpop_nonces`).Scan(&saved); err != nil || string(saved) != string(hash[:]) || string(saved) == value {
		t.Fatalf("nonce not hashed: %v", err)
	}
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	c := claims()
	c["nonce"] = value
	proof := sign(t, key, c, "dpop+jwt", true)
	resolved, err := store.ResolveProof(ctx, scope, proof)
	if err != nil || resolved != value {
		t.Fatalf("valid nonce: %v", err)
	}
	for _, other := range []NonceScope{{"proj_b", "client_a", "par"}, {"proj_a", "client_b", "par"}, {"proj_a", "client_a", "token"}} {
		if _, err := store.ResolveProof(ctx, other, proof); !errors.Is(err, ErrInvalidNonce) {
			t.Fatalf("scope accepted: %+v %v", other, err)
		}
	}
	// Nonces are reusable during their lifetime; individual DPoP jtis still are not.
	if _, err := store.ResolveProof(ctx, scope, proof); err != nil {
		t.Fatal(err)
	}
	now = now.Add(time.Minute)
	if _, err := store.ResolveProof(ctx, scope, proof); !errors.Is(err, ErrInvalidNonce) {
		t.Fatalf("expired nonce accepted: %v", err)
	}
	if err := store.Cleanup(ctx, "proj_a"); err != nil {
		t.Fatal(err)
	}
	var n int
	if err := db.QueryRow(`SELECT COUNT(*) FROM mapi_dpop_nonces`).Scan(&n); err != nil || n != 0 {
		t.Fatalf("cleanup: %d %v", n, err)
	}
}
func TestNonceIssueAuditRollback(t *testing.T) {
	ctx := context.Background()
	db := dbForTest(t)
	now := time.Unix(1700000000, 0)
	if _, err := db.Exec(`CREATE TABLE nonce_audit (event TEXT)`); err != nil {
		t.Fatal(err)
	}
	fail := errors.New("audit failed")
	store := nonceStore(t, db, &now, func(context.Context, NonceScope) error {
		if _, err := db.Exec(`INSERT INTO nonce_audit VALUES ('issued')`); err != nil {
			return err
		}
		return fail
	})
	value, err := store.Issue(ctx, NonceScope{"p", "c", "token"})
	if !errors.Is(err, fail) || value != "" {
		t.Fatalf("audit failure: %q %v", value, err)
	}
	for _, table := range []string{"mapi_dpop_nonces", "nonce_audit"} {
		var n int
		if err = db.QueryRow(`SELECT COUNT(*) FROM ` + table).Scan(&n); err != nil || n != 0 {
			t.Fatalf("%s survived rollback: %d %v", table, n, err)
		}
	}
}
func TestNonceRejectsUntrustedMalformedProof(t *testing.T) {
	db := dbForTest(t)
	now := time.Unix(1700000000, 0)
	store := nonceStore(t, db, &now, func(context.Context, NonceScope) error { return nil })
	scope := NonceScope{"p", "c", "par"}
	for _, proof := range []string{"", "a.b.c", "a,b.c.d", fmt.Sprintf("a.%s.c", "eyJub25jZSI6ImEiLCJub25jZSI6ImIifQ")} {
		if _, err := store.ResolveProof(context.Background(), scope, proof); !errors.Is(err, ErrInvalidNonce) {
			t.Fatalf("invalid proof accepted: %v", err)
		}
	}
}
func TestNonceCleanupBounded(t *testing.T) {
	db := dbForTest(t)
	now := time.Unix(1700000000, 0)
	store := nonceStore(t, db, &now, func(context.Context, NonceScope) error { return nil })
	for i := 0; i < 250; i++ {
		hash := sha256.Sum256([]byte(fmt.Sprint(i)))
		if _, err := db.Exec(`INSERT INTO mapi_dpop_nonces VALUES (?,?,?,?,?)`, hash[:], "p", "c", "par", 1); err != nil {
			t.Fatal(err)
		}
	}
	other := sha256.Sum256([]byte("other"))
	if _, err := db.Exec(`INSERT INTO mapi_dpop_nonces VALUES (?,?,?,?,?)`, other[:], "other", "c", "par", 1); err != nil {
		t.Fatal(err)
	}
	if err := store.Cleanup(context.Background(), "p"); err != nil {
		t.Fatal(err)
	}
	var n int
	if err := db.QueryRow(`SELECT COUNT(*) FROM mapi_dpop_nonces WHERE project_id='p'`).Scan(&n); err != nil || n != 150 {
		t.Fatalf("unbounded cleanup: %d %v", n, err)
	}
	if err := db.QueryRow(`SELECT COUNT(*) FROM mapi_dpop_nonces WHERE project_id='other'`).Scan(&n); err != nil || n != 1 {
		t.Fatalf("wrong project cleanup: %d %v", n, err)
	}
}

func TestNonceClockFailsClosed(t *testing.T) {
	ctx := context.Background()
	db := dbForTest(t)
	now := time.Unix(1700000000, 0)
	store := nonceStore(t, db, &now, func(context.Context, NonceScope) error { return nil })
	scope := NonceScope{"p", "c", "par"}
	value, err := store.Issue(ctx, scope)
	if err != nil {
		t.Fatal(err)
	}
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	c := claims()
	c["nonce"] = value
	proof := sign(t, key, c, "dpop+jwt", true)
	now = time.Time{}
	if value, err := store.Issue(ctx, scope); err == nil || value != "" {
		t.Fatal("unavailable clock issued nonce")
	}
	if _, err := store.ResolveProof(ctx, scope, proof); err == nil {
		t.Fatal("unavailable clock accepted nonce")
	}
	if err := store.Cleanup(ctx, scope.ProjectID); err == nil {
		t.Fatal("unavailable clock cleaned nonces")
	}
}
