package mapioauth

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"database/sql"
	"encoding/base64"
	"errors"
	"fmt"

	"github.com/go-jose/go-jose/v4"
	"github.com/zitadel/nextgen/internal/domain"
	"github.com/zitadel/oidc/v3/pkg/op"
)

// ProjectKeyService is the portion of Nextgen's KeyService used to wrap the
// private RSA key using the project's existing encryption key chain.
type ProjectKeyService interface {
	GetProjectCrypter(context.Context, string, domain.EncryptionKeyPurpose) (op.Crypto, error)
	GetCrypter(context.Context, string, jose.ContentEncryption) (op.Crypto, error)
	GetEncryptionKey(context.Context, string, jose.ContentEncryption) (*domain.EncryptionKey, error)
}

// SigningKeys stores encrypted private keys and public keys in the owning
// project's SQLite database. Retired public keys remain available for token
// verification; key removal requires a separate expiry-aware policy.
type SigningKeys struct {
	Store     Store
	Keys      ProjectKeyService
	ProjectID string
	// AuditRotation runs in the same transaction as the key switch.
	AuditRotation func(context.Context, string) error
}

func (s SigningKeys) CreateSchema(ctx context.Context) error {
	if s.Store.DB == nil {
		return errors.New("key store not configured")
	}
	_, err := s.Store.DB.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS mapi_oauth_signing_keys (
 project_id TEXT NOT NULL, key_id TEXT NOT NULL, public_key BLOB NOT NULL,
 private_key_jwe TEXT NOT NULL, active INTEGER NOT NULL CHECK(active IN (0,1)),
 created_at INTEGER NOT NULL, PRIMARY KEY(project_id,key_id))`)
	if err != nil {
		return err
	}
	_, err = s.Store.DB.ExecContext(ctx, `CREATE UNIQUE INDEX IF NOT EXISTS mapi_oauth_one_active_signing_key ON mapi_oauth_signing_keys(project_id) WHERE active = 1`)
	return err
}

// Rotate generates outside the transaction, then atomically installs the key
// and audits the switch. A bootstrap can require existing=false to avoid
// silently rotating a key after retry; explicit rotations require true.
func (s SigningKeys) Rotate(ctx context.Context, existing bool) (string, error) {
	if s.Store.DB == nil || s.Store.Transaction == nil || s.Store.Now == nil || s.Keys == nil || s.ProjectID == "" || s.AuditRotation == nil {
		return "", errors.New("key store not configured")
	}
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		return "", err
	}
	der, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		return "", err
	}
	crypter, err := s.Keys.GetProjectCrypter(ctx, s.ProjectID, domain.EncryptionKeyPurposeToken)
	if err != nil {
		return "", err
	}
	// PKCS#8 bytes are base64 encoded before encryption because Crypter's input
	// is a string and the Go/WASI SQL bridge transports strings as UTF-8.
	wrapped, err := crypter.Encrypt(base64.RawStdEncoding.EncodeToString(der))
	if err != nil {
		return "", err
	}
	if _, err = domain.DecodeStoredKeyJWEHeader(wrapped); err != nil {
		return "", fmt.Errorf("invalid key wrapping header: %w", err)
	}
	pub, err := x509.MarshalPKIXPublicKey(&key.PublicKey)
	if err != nil {
		return "", err
	}
	var random [32]byte
	if _, err = rand.Read(random[:]); err != nil {
		return "", err
	}
	kid := base64.RawURLEncoding.EncodeToString(random[:])
	err = s.Store.Transaction(func() error {
		var n int
		if err := s.Store.DB.QueryRowContext(ctx, `SELECT count(*) FROM mapi_oauth_signing_keys WHERE project_id = ? AND active = 1`, s.ProjectID).Scan(&n); err != nil {
			return err
		}
		if (n == 1) != existing {
			return errors.New("unexpected signing key state")
		}
		if existing {
			if _, err := s.Store.DB.ExecContext(ctx, `UPDATE mapi_oauth_signing_keys SET active=0 WHERE project_id = ? AND active=1`, s.ProjectID); err != nil {
				return err
			}
		}
		if _, err := s.Store.DB.ExecContext(ctx, `INSERT INTO mapi_oauth_signing_keys(project_id,key_id,public_key,private_key_jwe,active,created_at) VALUES(?,?,?,?,1,?)`, s.ProjectID, kid, pub, wrapped, s.Store.Now().Unix()); err != nil {
			return err
		}
		return s.AuditRotation(ctx, kid)
	})
	if err != nil {
		return "", err
	}
	return kid, nil
}

func (s SigningKeys) PublicKeys(ctx context.Context) (jose.JSONWebKeySet, error) {
	if s.Store.DB == nil || s.ProjectID == "" {
		return jose.JSONWebKeySet{}, errors.New("key store not configured")
	}
	rows, err := s.Store.DB.QueryContext(ctx, `SELECT key_id,public_key FROM mapi_oauth_signing_keys WHERE project_id=? ORDER BY created_at,key_id`, s.ProjectID)
	if err != nil {
		return jose.JSONWebKeySet{}, err
	}
	defer rows.Close()
	set := jose.JSONWebKeySet{}
	for rows.Next() {
		var kid string
		var der []byte
		if err := rows.Scan(&kid, &der); err != nil {
			return set, err
		}
		parsed, err := x509.ParsePKIXPublicKey(der)
		if err != nil {
			return set, err
		}
		pub, ok := parsed.(*rsa.PublicKey)
		if !ok || pub.N.BitLen() < 2048 {
			return set, errors.New("invalid public signing key")
		}
		set.Keys = append(set.Keys, jose.JSONWebKey{Key: pub, KeyID: kid, Algorithm: "RS256", Use: "sig"})
	}
	return set, rows.Err()
}

func (s SigningKeys) signer(ctx context.Context, typ string) (jose.Signer, error) {
	if s.Store.DB == nil || s.Keys == nil || s.ProjectID == "" {
		return nil, errors.New("key store not configured")
	}
	var kid, wrapped string
	var pubDER []byte
	err := s.Store.DB.QueryRowContext(ctx, `SELECT key_id,private_key_jwe,public_key FROM mapi_oauth_signing_keys WHERE project_id=? AND active=1`, s.ProjectID).Scan(&kid, &wrapped, &pubDER)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, errors.New("no active signing key")
	}
	if err != nil {
		return nil, err
	}
	header, err := domain.DecodeStoredKeyJWEHeader(wrapped)
	if err != nil {
		return nil, err
	}
	wrappingKey, err := s.Keys.GetEncryptionKey(ctx, header.KeyID, header.EncryptionAlgorithm)
	if err != nil {
		return nil, err
	}
	if wrappingKey == nil || wrappingKey.ProjectID != s.ProjectID || wrappingKey.Purpose != domain.EncryptionKeyPurposeToken || wrappingKey.State == domain.KeyStateRemoved {
		return nil, errors.New("invalid project wrapping key")
	}
	crypter, err := s.Keys.GetCrypter(ctx, header.KeyID, header.EncryptionAlgorithm)
	if err != nil {
		return nil, err
	}
	encoded, err := crypter.Decrypt(wrapped)
	if err != nil {
		return nil, err
	}
	privateDER, err := base64.RawStdEncoding.DecodeString(encoded)
	if err != nil {
		return nil, err
	}
	parsed, err := x509.ParsePKCS8PrivateKey(privateDER)
	if err != nil {
		return nil, err
	}
	key, ok := parsed.(*rsa.PrivateKey)
	if !ok || key.N.BitLen() < 2048 {
		return nil, errors.New("invalid private signing key")
	}
	if err = key.Validate(); err != nil {
		return nil, err
	}
	expected, err := x509.MarshalPKIXPublicKey(&key.PublicKey)
	if err != nil {
		return nil, err
	}
	left := sha256.Sum256(expected)
	right := sha256.Sum256(pubDER)
	if left != right {
		return nil, errors.New("signing key pair mismatch")
	}
	opts := (&jose.SignerOptions{}).WithType(jose.ContentType(typ))
	return jose.NewSigner(jose.SigningKey{Algorithm: jose.RS256, Key: &jose.JSONWebKey{Key: key, KeyID: kid}}, opts)
}
