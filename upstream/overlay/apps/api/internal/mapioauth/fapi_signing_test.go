package mapioauth

import (
	"context"
	"crypto/ecdsa"
	"errors"
	"strings"
	"testing"

	"github.com/zitadel/oidc/v3/pkg/op"
)

func TestFAPISigningKeysRotationAndRollback(t *testing.T) {
	ctx := context.Background()
	store, grant := fixture(t)
	var wrapping [32]byte
	for i := range wrapping {
		wrapping[i] = byte(i)
	}
	keys := FAPISigningKeys{Store: store, ProjectID: grant.ProjectID,
		Keys: testProjectKeys{project: grant.ProjectID, crypter: op.NewAES256GCMCrypto(wrapping, "enc_key_test")},
		AuditRotation: func(ctx context.Context, id string) error {
			_, err := store.DB.ExecContext(ctx, "INSERT INTO issued_tokens VALUES (?)", id)
			return err
		},
	}
	if err := keys.CreateSchema(ctx); err != nil {
		t.Fatal(err)
	}
	first, err := keys.Rotate(ctx, false)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := keys.Rotate(ctx, false); err == nil {
		t.Fatal("repeated initialization rotated key")
	}
	var encrypted string
	if err := store.DB.QueryRow("SELECT private_key_jwe FROM mapi_fapi_signing_keys WHERE key_id=?", first).Scan(&encrypted); err != nil || !strings.Contains(encrypted, ".") || strings.Contains(encrypted, "PRIVATE KEY") {
		t.Fatalf("private key not encrypted: %v", err)
	}
	signer, err := keys.signer(ctx, "at+jwt")
	if err != nil {
		t.Fatal(err)
	}
	signed, err := signer.Sign([]byte("fapi-test"))
	if err != nil {
		t.Fatal(err)
	}
	ring, err := keys.PublicKeys(ctx)
	if err != nil || len(ring.Keys) != 1 {
		t.Fatalf("public keys: %v", err)
	}
	if ring.Keys[0].KeyID != first || ring.Keys[0].Algorithm != "ES256" || ring.Keys[0].Use != "sig" {
		t.Fatal("wrong public key metadata")
	}
	if _, ok := ring.Keys[0].Key.(*ecdsa.PublicKey); !ok {
		t.Fatal("non-EC public key")
	}
	if _, err := signed.Verify(ring.Keys[0].Key); err != nil {
		t.Fatal(err)
	}
	second, err := keys.Rotate(ctx, true)
	if err != nil || second == first {
		t.Fatalf("rotation failed: %v", err)
	}
	ring, err = keys.PublicKeys(ctx)
	if err != nil || len(ring.Keys) != 2 {
		t.Fatalf("historical public key lost: %v", err)
	}
	old := ring.Key(first)
	if len(old) != 1 {
		t.Fatal("historical key missing")
	}
	if _, err := signed.Verify(old[0].Key); err != nil {
		t.Fatal(err)
	}
	failed := keys
	failed.AuditRotation = func(context.Context, string) error { return errors.New("injected audit failure") }
	if _, err := failed.Rotate(ctx, true); err == nil {
		t.Fatal("failed audit allowed rotation")
	}
	var active string
	if err := store.DB.QueryRow("SELECT key_id FROM mapi_fapi_signing_keys WHERE project_id=? AND active=1", grant.ProjectID).Scan(&active); err != nil || active != second {
		t.Fatalf("rotation failed to roll back: %v", err)
	}
	var count int
	if err := store.DB.QueryRow("SELECT count(*) FROM mapi_fapi_signing_keys WHERE project_id=?", grant.ProjectID).Scan(&count); err != nil || count != 2 {
		t.Fatalf("failed key persisted: %v", err)
	}
	other := keys
	other.ProjectID = "other-project"
	other.Keys = testProjectKeys{project: "other-project", crypter: op.NewAES256GCMCrypto(wrapping, "enc_key_test")}
	otherKeys, err := other.PublicKeys(ctx)
	if err != nil || len(otherKeys.Keys) != 0 {
		t.Fatalf("foreign keys exposed: %v", err)
	}
	if _, err := other.signer(ctx, "JWT"); err == nil {
		t.Fatal("foreign project obtained signer")
	}
	if _, err := store.DB.ExecContext(ctx, "UPDATE mapi_fapi_signing_keys SET public_key=? WHERE key_id=?", []byte("bad"), second); err != nil {
		t.Fatal(err)
	}
	if _, err := keys.signer(ctx, "JWT"); err == nil {
		t.Fatal("tampered public key accepted")
	}
}
