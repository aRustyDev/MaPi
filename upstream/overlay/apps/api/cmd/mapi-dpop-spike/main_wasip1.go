//go:build wasip1

package main

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"time"
	"unsafe"

	jose "github.com/go-jose/go-jose/v4"
	"github.com/zitadel/nextgen/internal/cloudflarewasm"
	"github.com/zitadel/nextgen/internal/mapidpop"
)

var output, input []byte

//go:wasmexport mapi_alloc
func alloc(size uint32) uint32 {
	input = make([]byte, size)
	return uint32(uintptr(unsafe.Pointer(unsafe.SliceData(input))))
}

//go:wasmexport mapi_release
func release() { clear(input); clear(output); input = nil; output = nil }

//go:wasmexport verify_dpop
func verifyProof() uint64 {
	var req struct {
		Proof     string `json:"proof"`
		ProjectID string `json:"projectId"`
	}
	out := map[string]any{"status": "invalid"}
	if json.Unmarshal(input, &req) == nil {
		ctx := context.Background()
		db := cloudflarewasm.Open()
		defer db.Close()
		opt := mapidpop.Options{ProjectID: req.ProjectID, Method: "POST", URL: "https://issuer.test/token?ignored=1", Nonce: "server-nonce", Now: time.Unix(1700000000, 0), MaxAge: time.Minute, FutureSkew: 5 * time.Second}
		err := cloudflarewasm.Transaction(func() error {
			result, err := mapidpop.Verify(ctx, []string{req.Proof}, opt, mapidpop.SQLReplay{DB: db})
			if err != nil {
				return err
			}
			if _, err = db.ExecContext(ctx, `INSERT INTO mapi_dpop_sessions VALUES (?)`, req.ProjectID); err != nil {
				return err
			}
			out = map[string]any{"status": "ok", "jkt": result.Thumbprint}
			return nil
		})
		if err != nil && !errors.Is(err, mapidpop.ErrInvalidProof) {
			out = map[string]any{"status": "error"}
		}
	}
	output, _ = json.Marshal(out)
	return uint64(uint32(uintptr(unsafe.Pointer(unsafe.SliceData(output)))))<<32 | uint64(len(output))
}

//go:wasmexport run_dpop_tests
func run() uint64 {
	value := map[string]any{"ok": true}
	if err := check(); err != nil {
		value = map[string]any{"ok": false, "error": err.Error()}
	}
	output, _ = json.Marshal(value)
	return uint64(uint32(uintptr(unsafe.Pointer(unsafe.SliceData(output)))))<<32 | uint64(len(output))
}
func check() error {
	ctx := context.Background()
	db := cloudflarewasm.Open()
	defer db.Close()
	if err := mapidpop.InitReplaySchema(ctx, db); err != nil {
		return err
	}
	if _, err := db.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS mapi_dpop_sessions (id TEXT PRIMARY KEY)`); err != nil {
		return err
	}
	if _, err := db.ExecContext(ctx, `DELETE FROM mapi_dpop_replay`); err != nil {
		return err
	}
	if _, err := db.ExecContext(ctx, `DELETE FROM mapi_dpop_sessions`); err != nil {
		return err
	}
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return err
	}
	signer, err := jose.NewSigner(jose.SigningKey{Algorithm: jose.ES256, Key: key}, (&jose.SignerOptions{}).WithHeader("typ", "dpop+jwt").WithHeader("jwk", jose.JSONWebKey{Key: &key.PublicKey}))
	if err != nil {
		return err
	}
	data, _ := json.Marshal(map[string]any{"jti": "durable-proof", "htm": "POST", "htu": "https://issuer.test/token", "iat": 1700000000, "nonce": "server-nonce"})
	sig, err := signer.Sign(data)
	if err != nil {
		return err
	}
	proof, err := sig.CompactSerialize()
	if err != nil {
		return err
	}
	opts := mapidpop.Options{ProjectID: "proj_a", Method: "POST", URL: "https://issuer.test/token?ignored=1", Nonce: "server-nonce", Now: time.Unix(1700000000, 0), MaxAge: time.Minute, FutureSkew: 5 * time.Second}
	abort := errors.New("injected transaction failure")
	err = cloudflarewasm.Transaction(func() error {
		if _, err := mapidpop.Verify(ctx, []string{proof}, opts, mapidpop.SQLReplay{DB: db}); err != nil {
			return err
		}
		if _, err := db.ExecContext(ctx, `INSERT INTO mapi_dpop_sessions VALUES (?)`, "rollback"); err != nil {
			return err
		}
		return abort
	})
	if !errors.Is(err, abort) {
		return fmt.Errorf("rollback not observed: %v", err)
	}
	var n int
	if err = db.QueryRowContext(ctx, `SELECT COUNT(*) FROM mapi_dpop_replay`).Scan(&n); err != nil || n != 0 {
		return fmt.Errorf("replay persisted after rollback: %d %v", n, err)
	}
	if err = db.QueryRowContext(ctx, `SELECT COUNT(*) FROM mapi_dpop_sessions`).Scan(&n); err != nil || n != 0 {
		return fmt.Errorf("session persisted after rollback: %d %v", n, err)
	}
	wins := 0
	for i := 0; i < 10; i++ {
		err = cloudflarewasm.Transaction(func() error {
			if _, err := mapidpop.Verify(ctx, []string{proof}, opts, mapidpop.SQLReplay{DB: db}); err != nil {
				return err
			}
			_, err := db.ExecContext(ctx, `INSERT INTO mapi_dpop_sessions VALUES (?)`, "success")
			return err
		})
		if err == nil {
			wins++
		} else if !errors.Is(err, mapidpop.ErrInvalidProof) {
			return err
		}
	}
	if wins != 1 {
		return fmt.Errorf("expected one winner, got %d", wins)
	}
	if err = db.QueryRowContext(ctx, `SELECT COUNT(*) FROM mapi_dpop_replay`).Scan(&n); err != nil || n != 1 {
		return fmt.Errorf("wrong replay count: %d %v", n, err)
	}
	if err = db.QueryRowContext(ctx, `SELECT COUNT(*) FROM mapi_dpop_sessions`).Scan(&n); err != nil || n != 1 {
		return fmt.Errorf("wrong session count: %d %v", n, err)
	}
	if err = mapidpop.InitNonceSchema(ctx, db); err != nil {
		return err
	}
	if _, err = db.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS mapi_dpop_nonce_audit (event TEXT)`); err != nil {
		return err
	}
	if _, err = db.ExecContext(ctx, `DELETE FROM mapi_dpop_nonces`); err != nil {
		return err
	}
	if _, err = db.ExecContext(ctx, `DELETE FROM mapi_dpop_nonce_audit`); err != nil {
		return err
	}
	now := time.Unix(1700000000, 0)
	scope := mapidpop.NonceScope{ProjectID: "proj_nonce", ClientID: "client", Purpose: "par"}
	nonces := mapidpop.NonceStore{DB: db, Transaction: cloudflarewasm.Transaction, Now: func() time.Time { return now }, TTL: time.Minute,
		Audit: func(ctx context.Context, _ mapidpop.NonceScope) error {
			if _, err := db.ExecContext(ctx, `INSERT INTO mapi_dpop_nonce_audit VALUES ('issue')`); err != nil {
				return err
			}
			return abort
		}}
	if value, err := nonces.Issue(ctx, scope); !errors.Is(err, abort) || value != "" {
		return fmt.Errorf("nonce audit rollback: %v", err)
	}
	if err = db.QueryRowContext(ctx, `SELECT COUNT(*) FROM mapi_dpop_nonces`).Scan(&n); err != nil || n != 0 {
		return fmt.Errorf("nonce survived audit failure: %d %v", n, err)
	}
	if err = db.QueryRowContext(ctx, `SELECT COUNT(*) FROM mapi_dpop_nonce_audit`).Scan(&n); err != nil || n != 0 {
		return fmt.Errorf("audit survived failure: %d %v", n, err)
	}
	nonces.Audit = func(ctx context.Context, _ mapidpop.NonceScope) error {
		_, err := db.ExecContext(ctx, `INSERT INTO mapi_dpop_nonce_audit VALUES ('issue')`)
		return err
	}
	nonce, err := nonces.Issue(ctx, scope)
	if err != nil {
		return err
	}
	newData, _ := json.Marshal(map[string]any{"jti": "nonce-proof", "htm": "POST", "htu": "https://issuer.test/token", "iat": 1700000000, "nonce": nonce})
	signed, err := signer.Sign(newData)
	if err != nil {
		return err
	}
	nonceProof, err := signed.CompactSerialize()
	if err != nil {
		return err
	}
	err = cloudflarewasm.Transaction(func() error {
		actual, err := nonces.ResolveProof(ctx, scope, nonceProof)
		if err != nil {
			return err
		}
		nonceOpts := opts
		nonceOpts.ProjectID = scope.ProjectID
		nonceOpts.Nonce = actual
		_, err = mapidpop.Verify(ctx, []string{nonceProof}, nonceOpts, mapidpop.SQLReplay{DB: db})
		return err
	})
	if err != nil {
		return fmt.Errorf("nonce verification: %v", err)
	}
	wrong := scope
	wrong.ClientID = "other"
	if _, err = nonces.ResolveProof(ctx, wrong, nonceProof); !errors.Is(err, mapidpop.ErrInvalidNonce) {
		return errors.New("foreign nonce scope accepted")
	}
	now = now.Add(time.Minute)
	if _, err = nonces.ResolveProof(ctx, scope, nonceProof); !errors.Is(err, mapidpop.ErrInvalidNonce) {
		return errors.New("expired nonce accepted")
	}
	opts.ProjectID = "proj_b"
	if err = cloudflarewasm.Transaction(func() error {
		_, err := mapidpop.Verify(ctx, []string{proof}, opts, mapidpop.SQLReplay{DB: db})
		return err
	}); err != nil {
		return fmt.Errorf("project isolation: %v", err)
	}
	return nil
}
func main() {}
