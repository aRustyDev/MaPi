package mapioauth

import (
	"context"
	"crypto/ecdsa"
	"crypto/ed25519"
	"crypto/elliptic"
	"crypto/rsa"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"slices"
	"strings"
	"time"

	"github.com/go-jose/go-jose/v4"
	"github.com/go-jose/go-jose/v4/jwt"
)

const privateKeyAssertionType = "urn:ietf:params:oauth:client-assertion-type:jwt-bearer"

// ClientAssertions is an unmounted, FAPI-oriented authentication primitive.
// Store, Registry and both audit callbacks must use the same authoritative
// project transaction. The ordinary confidential-client profile is unchanged.
type ClientAssertions struct {
	ProjectID, Issuer   string
	Store               Store
	Registry            ClientRegistry
	AuditKeys           func(context.Context, string, []string) error
	AuditAuthentication func(context.Context, string, string) error
}

func (a ClientAssertions) valid() bool {
	issuer, err := url.Parse(a.Issuer)
	return err == nil && issuer.Scheme == "https" && issuer.Host != "" && issuer.User == nil && issuer.RawQuery == "" && issuer.Fragment == "" && issuer.Path == "/oauth/"+a.ProjectID && a.ProjectID != "" && url.PathEscape(a.ProjectID) == a.ProjectID && a.Store.DB != nil && a.Store.Now != nil && a.Registry.Statements != nil
}

// CreateSchema must run as part of a versioned database migration before any
// operation. This private foundation does not modify the current app schema.
func (a ClientAssertions) CreateSchema(ctx context.Context) error {
	if a.Store.DB == nil {
		return errors.New("client assertion store not configured")
	}
	if _, err := a.Store.DB.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS mapi_oauth_client_assertion_keys (
 project_id TEXT NOT NULL, client_id TEXT NOT NULL, key_id TEXT NOT NULL,
 algorithm TEXT NOT NULL, public_jwk TEXT NOT NULL, active INTEGER NOT NULL CHECK(active IN (0,1)),
 PRIMARY KEY(project_id,client_id,key_id))`); err != nil {
		return err
	}
	if _, err := a.Store.DB.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS mapi_oauth_client_assertion_jtis (
 project_id TEXT NOT NULL, client_id TEXT NOT NULL, jti_hash BLOB NOT NULL, expires_at INTEGER NOT NULL,
 PRIMARY KEY(project_id,client_id,jti_hash))`); err != nil {
		return err
	}
	_, err := a.Store.DB.ExecContext(ctx, `CREATE INDEX IF NOT EXISTS mapi_oauth_assertion_jti_expiry ON mapi_oauth_client_assertion_jtis(project_id,expires_at)`)
	return err
}

func validAssertionKey(k jose.JSONWebKey) bool {
	if len(k.KeyID) == 0 || len(k.KeyID) > 128 || (k.Use != "" && k.Use != "sig") || !k.Valid() || !k.IsPublic() || len(k.Certificates) > 0 || k.CertificatesURL != nil || len(k.CertificateThumbprintSHA1) > 0 || len(k.CertificateThumbprintSHA256) > 0 {
		return false
	}
	for _, r := range k.KeyID {
		if !strings.ContainsRune("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~", r) {
			return false
		}
	}
	switch k.Algorithm {
	case "PS256":
		key, ok := k.Key.(*rsa.PublicKey)
		return ok && key.N != nil && key.N.BitLen() >= 2048 && key.N.BitLen() <= 8192 && key.E >= 65537
	case "ES256":
		key, ok := k.Key.(*ecdsa.PublicKey)
		return ok && key.Curve == elliptic.P256() && key.X != nil && key.Y != nil && key.Curve.IsOnCurve(key.X, key.Y)
	case "EdDSA":
		key, ok := k.Key.(ed25519.PublicKey)
		return ok && len(key) == ed25519.PublicKeySize
	default:
		return false
	}
}

// SetKeys atomically replaces a client's active public-key set. A retired kid
// cannot be reused or reactivated, even with different key bytes; overlapping
// old and new keys in one set allows a planned rollover. Existing assertion
// replay records are retained across rollover.
func (a ClientAssertions) SetKeys(ctx context.Context, clientID string, keys []jose.JSONWebKey) error {
	if !a.valid() || a.Store.Transaction == nil || a.AuditKeys == nil || clientID == "" || len(keys) == 0 || len(keys) > 16 {
		return errors.New("client key configuration invalid")
	}
	ids := make([]string, 0, len(keys))
	encoded := make(map[string]string, len(keys))
	for _, key := range keys {
		if !validAssertionKey(key) || slices.Contains(ids, key.KeyID) {
			return errors.New("invalid or duplicate client signing key")
		}
		value, err := json.Marshal(key)
		if err != nil {
			return err
		}
		ids = append(ids, key.KeyID)
		encoded[key.KeyID] = string(value)
	}
	slices.Sort(ids)
	return a.Store.Transaction(func() error {
		if _, err := a.Registry.Lookup(ctx, a.ProjectID, clientID); err != nil {
			return err
		}
		rows, err := a.Store.DB.QueryContext(ctx, `SELECT key_id,public_jwk,active FROM mapi_oauth_client_assertion_keys WHERE project_id=? AND client_id=?`, a.ProjectID, clientID)
		if err != nil {
			return err
		}
		type existingKey struct {
			jwk    string
			active int
		}
		existing := map[string]existingKey{}
		var active []string
		for rows.Next() {
			var id, value string
			var enabled int
			if err := rows.Scan(&id, &value, &enabled); err != nil {
				rows.Close()
				return err
			}
			existing[id] = existingKey{value, enabled}
			if enabled == 1 {
				active = append(active, id)
			}
		}
		if err := rows.Err(); err != nil {
			rows.Close()
			return err
		}
		if err := rows.Close(); err != nil {
			return err
		}
		slices.Sort(active)
		for _, id := range ids {
			if old, ok := existing[id]; ok && (old.active != 1 || old.jwk != encoded[id]) {
				return errors.New("retired or modified key ID cannot be reused")
			}
		}
		if slices.Equal(ids, active) {
			return nil
		}
		if _, err := a.Store.DB.ExecContext(ctx, `UPDATE mapi_oauth_client_assertion_keys SET active=0 WHERE project_id=? AND client_id=? AND active=1`, a.ProjectID, clientID); err != nil {
			return err
		}
		for _, id := range ids {
			if _, ok := existing[id]; ok {
				if _, err := a.Store.DB.ExecContext(ctx, `UPDATE mapi_oauth_client_assertion_keys SET active=1 WHERE project_id=? AND client_id=? AND key_id=?`, a.ProjectID, clientID, id); err != nil {
					return err
				}
				continue
			}
			var key jose.JSONWebKey
			if err := json.Unmarshal([]byte(encoded[id]), &key); err != nil {
				return err
			}
			if _, err := a.Store.DB.ExecContext(ctx, `INSERT INTO mapi_oauth_client_assertion_keys(project_id,client_id,key_id,algorithm,public_jwk,active) VALUES(?,?,?,?,?,1)`, a.ProjectID, clientID, id, key.Algorithm, encoded[id]); err != nil {
				return err
			}
		}
		return a.AuditKeys(ctx, clientID, ids)
	})
}

// RevokeKeys disables all keys, leaving tombstones so a retired kid cannot
// be reintroduced. This does not disable bearer-secret credentials.
func (a ClientAssertions) RevokeKeys(ctx context.Context, clientID string) error {
	if !a.valid() || a.Store.Transaction == nil || a.AuditKeys == nil || clientID == "" {
		return errors.New("client key configuration invalid")
	}
	return a.Store.Transaction(func() error {
		if _, err := a.Registry.Lookup(ctx, a.ProjectID, clientID); err != nil {
			return err
		}
		result, err := a.Store.DB.ExecContext(ctx, `UPDATE mapi_oauth_client_assertion_keys SET active=0 WHERE project_id=? AND client_id=? AND active=1`, a.ProjectID, clientID)
		if err != nil {
			return err
		}
		count, err := result.RowsAffected()
		if err != nil || count == 0 {
			return err
		}
		return a.AuditKeys(ctx, clientID, nil)
	})
}

type assertionClaims struct {
	Issuer    string           `json:"iss"`
	Subject   string           `json:"sub"`
	Audience  string           `json:"aud"` // FAPI final requires a string, not an array.
	ID        string           `json:"jti"`
	Expiry    *jwt.NumericDate `json:"exp"`
	IssuedAt  *jwt.NumericDate `json:"iat"`
	NotBefore *jwt.NumericDate `json:"nbf"`
}

// strictObject rejects duplicate top-level members and trailing JSON. A JWT
// parser must not interpret duplicated security claims differently from the
// signature-validation or routing code.
func strictObject(data []byte) (map[string]json.RawMessage, error) {
	decoder := json.NewDecoder(strings.NewReader(string(data)))
	token, err := decoder.Token()
	if err != nil || token != json.Delim('{') {
		return nil, errors.New("invalid JSON object")
	}
	out := map[string]json.RawMessage{}
	for decoder.More() {
		name, err := decoder.Token()
		if err != nil {
			return nil, err
		}
		key, ok := name.(string)
		if !ok {
			return nil, errors.New("invalid JSON member")
		}
		if _, exists := out[key]; exists {
			return nil, errors.New("duplicate JSON member")
		}
		var value json.RawMessage
		if err := decoder.Decode(&value); err != nil {
			return nil, err
		}
		out[key] = value
	}
	if token, err = decoder.Token(); err != nil || token != json.Delim('}') {
		return nil, errors.New("invalid JSON object")
	}
	if _, err = decoder.Token(); !errors.Is(err, io.EOF) {
		return nil, errors.New("trailing JSON")
	}
	return out, nil
}

// AuthenticateInTransaction validates and consumes one assertion within the
// caller's transaction. Its jti and audit write must roll back with the PAR or
// token operation. Do not call it outside an existing authoritative transaction.
func (a ClientAssertions) AuthenticateInTransaction(ctx context.Context, clientID, assertionType, raw string) (Client, error) {
	if !a.valid() || a.AuditAuthentication == nil {
		return Client{}, errors.New("client assertion store not configured")
	}
	if clientID == "" || len(clientID) > 512 || assertionType != privateKeyAssertionType || len(raw) == 0 || len(raw) > 16384 {
		return Client{}, ErrInvalidClient
	}
	parts := strings.Split(raw, ".")
	if len(parts) != 3 {
		return Client{}, ErrInvalidClient
	}
	headerRaw, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil || len(headerRaw) > 4096 {
		return Client{}, ErrInvalidClient
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil || len(payload) > 8192 {
		return Client{}, ErrInvalidClient
	}
	header, err := strictObject(headerRaw)
	if err != nil {
		return Client{}, ErrInvalidClient
	}
	if _, err = strictObject(payload); err != nil {
		return Client{}, ErrInvalidClient
	}
	for _, key := range []string{"jwk", "jku", "x5u", "x5c", "crit", "b64"} {
		if _, ok := header[key]; ok {
			return Client{}, ErrInvalidClient
		}
	}
	var alg, kid string
	if err = json.Unmarshal(header["alg"], &alg); err != nil {
		return Client{}, ErrInvalidClient
	}
	if err = json.Unmarshal(header["kid"], &kid); err != nil || kid == "" || len(kid) > 128 {
		return Client{}, ErrInvalidClient
	}
	if alg != "PS256" && alg != "ES256" && alg != "EdDSA" {
		return Client{}, ErrInvalidClient
	}
	client, err := a.Registry.Lookup(ctx, a.ProjectID, clientID)
	if err != nil {
		return Client{}, err
	}
	var jwkText, registeredAlg string
	err = a.Store.DB.QueryRowContext(ctx, `SELECT public_jwk,algorithm FROM mapi_oauth_client_assertion_keys WHERE project_id=? AND client_id=? AND key_id=? AND active=1`, a.ProjectID, clientID, kid).Scan(&jwkText, &registeredAlg)
	if errors.Is(err, sql.ErrNoRows) {
		return Client{}, ErrInvalidClient
	}
	if err != nil {
		return Client{}, err
	}
	if registeredAlg != alg {
		return Client{}, ErrInvalidClient
	}
	var key jose.JSONWebKey
	if err = json.Unmarshal([]byte(jwkText), &key); err != nil || !validAssertionKey(key) || key.KeyID != kid || key.Algorithm != alg {
		return Client{}, ErrInvalidClient
	}
	parsed, err := jwt.ParseSigned(raw, []jose.SignatureAlgorithm{jose.PS256, jose.ES256, jose.EdDSA})
	if err != nil || len(parsed.Headers) != 1 || parsed.Headers[0].Algorithm != alg || parsed.Headers[0].KeyID != kid {
		return Client{}, ErrInvalidClient
	}
	var claims assertionClaims
	if err = parsed.Claims(key.Key, &claims); err != nil {
		return Client{}, ErrInvalidClient
	}
	now := a.Store.Now().UTC()
	if claims.Issuer != clientID || claims.Subject != clientID || claims.Audience != a.Issuer || len(claims.ID) == 0 || len(claims.ID) > 256 || claims.Expiry == nil || !claims.Expiry.Time().After(now) || claims.Expiry.Time().After(now.Add(5*time.Minute)) {
		return Client{}, ErrInvalidClient
	}
	// FAPI final requires accepting iat/nbf up to ten seconds in the future;
	// this profile deliberately uses that conservative ten-second skew bound.
	future := now.Add(10 * time.Second)
	if claims.IssuedAt != nil && (claims.IssuedAt.Time().After(future) || claims.IssuedAt.Time().Before(now.Add(-5*time.Minute))) {
		return Client{}, ErrInvalidClient
	}
	if claims.NotBefore != nil && claims.NotBefore.Time().After(future) {
		return Client{}, ErrInvalidClient
	}
	digest := sha256.Sum256([]byte(claims.ID))
	if _, err = a.Store.DB.ExecContext(ctx, `DELETE FROM mapi_oauth_client_assertion_jtis WHERE rowid IN (SELECT rowid FROM mapi_oauth_client_assertion_jtis WHERE project_id=? AND expires_at<=? LIMIT 100)`, a.ProjectID, now.Unix()); err != nil {
		return Client{}, err
	}
	// DO SQLite rowsWritten counts index writes, not logical affected rows.
	// RETURNING distinguishes the inserted row from a duplicate reliably.
	var marker []byte
	err = a.Store.DB.QueryRowContext(ctx, `INSERT INTO mapi_oauth_client_assertion_jtis(project_id,client_id,jti_hash,expires_at) VALUES(?,?,?,?) ON CONFLICT DO NOTHING RETURNING jti_hash`, a.ProjectID, clientID, digest[:], claims.Expiry.Time().Unix()).Scan(&marker)
	if errors.Is(err, sql.ErrNoRows) {
		return Client{}, ErrInvalidClient
	}
	if err != nil {
		return Client{}, err
	}
	if err = a.AuditAuthentication(ctx, clientID, kid); err != nil {
		return Client{}, err
	}
	return client, nil
}

// PARAuthenticator adapts the primitive to the PAR hook; the PAR caller must
// already have opened the same authoritative transaction.
func (a ClientAssertions) PARAuthenticator() func(context.Context, *http.Request, url.Values) (string, error) {
	return func(ctx context.Context, r *http.Request, form url.Values) (string, error) {
		if r == nil || r.Header.Get("Authorization") != "" || len(form["client_id"]) != 1 || len(form["client_assertion_type"]) != 1 || len(form["client_assertion"]) != 1 {
			return "", ErrInvalidClient
		}
		client, err := a.AuthenticateInTransaction(ctx, form.Get("client_id"), form.Get("client_assertion_type"), form.Get("client_assertion"))
		if err != nil {
			return "", err
		}
		return client.ClientID, nil
	}
}
