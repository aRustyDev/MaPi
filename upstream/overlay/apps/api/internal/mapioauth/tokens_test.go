package mapioauth

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/go-jose/go-jose/v4"
	"github.com/go-jose/go-jose/v4/jwt"
	"github.com/zitadel/nextgen/internal/domain"
	"github.com/zitadel/oidc/v3/pkg/op"
)

type testProjectKeys struct {
	project string
	crypter op.Crypto
}

func (k testProjectKeys) GetProjectCrypter(_ context.Context, p string, purpose domain.EncryptionKeyPurpose) (op.Crypto, error) {
	if p != k.project || purpose != domain.EncryptionKeyPurposeToken {
		return nil, errors.New("wrong project key")
	}
	return k.crypter, nil
}
func (k testProjectKeys) GetCrypter(_ context.Context, id string, alg jose.ContentEncryption) (op.Crypto, error) {
	if id != "enc_key_test" || alg != jose.A256GCM {
		return nil, errors.New("unknown wrapping key")
	}
	return k.crypter, nil
}

func (k testProjectKeys) GetEncryptionKey(_ context.Context, id string, alg jose.ContentEncryption) (*domain.EncryptionKey, error) {
	if id != "enc_key_test" || alg != jose.A256GCM {
		return nil, errors.New("unknown wrapping key")
	}
	return &domain.EncryptionKey{ProjectID: k.project, Purpose: domain.EncryptionKeyPurposeToken, State: domain.KeyStateActive}, nil
}

type testSessions struct{ session *domain.Session }

func (s *testSessions) GetSessionByID(_ context.Context, p, id string) (*domain.Session, error) {
	if s.session == nil || s.session.ProjectID != p || s.session.ID != id {
		return nil, errors.New("session revoked")
	}
	return s.session, nil
}

func TestValidateBoundSession(t *testing.T) {
	now := time.Date(2026, 11, 28, 0, 0, 0, 0, time.UTC)
	user := "user_1"
	sessions := &testSessions{session: &domain.Session{
		ProjectID: "project_1", ID: "sess_1", UserID: &user,
		ExpiresAt: now.Add(time.Hour),
		Factors:   []domain.AuthFactor{domain.SetAuthFactorPassword(now.Add(-time.Minute))},
	}}
	issuer := TokenIssuer{
		Keys: SigningKeys{ProjectID: "project_1"}, Sessions: sessions,
		Store: Store{Now: func() time.Time { return now }},
	}
	ctx := context.Background()
	if !issuer.ValidateBoundSession(ctx, "project_1", user, "sess_1") {
		t.Fatal("valid session rejected")
	}
	for _, identity := range [][3]string{
		{"project_2", user, "sess_1"},
		{"project_1", "user_2", "sess_1"},
		{"project_1", user, "sess_2"},
		{"project_1", "", "sess_1"},
	} {
		if issuer.ValidateBoundSession(ctx, identity[0], identity[1], identity[2]) {
			t.Fatalf("mismatched identity accepted: %v", identity)
		}
	}
	sessions.session.ExpiresAt = now
	if issuer.ValidateBoundSession(ctx, "project_1", user, "sess_1") {
		t.Fatal("expired session accepted")
	}
	sessions.session.ExpiresAt = now.Add(time.Hour)
	sessions.session.Factors = []domain.AuthFactor{domain.SetAuthFactorUser(now.Add(-time.Minute))}
	if issuer.ValidateBoundSession(ctx, "project_1", user, "sess_1") {
		t.Fatal("session without a verified credential accepted")
	}
	sessions.session = nil
	if issuer.ValidateBoundSession(ctx, "project_1", user, "sess_1") {
		t.Fatal("revoked session accepted")
	}
	issuer.Sessions = nil
	if issuer.ValidateBoundSession(ctx, "project_1", user, "sess_1") {
		t.Fatal("unavailable session reader accepted")
	}
}

func TestSigningKeyRotationAndSignedTokens(t *testing.T) {
	ctx := context.Background()
	store, grant := fixture(t)
	if err := store.CreateRefreshSchema(ctx); err != nil {
		t.Fatal(err)
	}
	var wrapping [32]byte
	for n := range wrapping {
		wrapping[n] = byte(n)
	}
	keys := SigningKeys{Store: store, ProjectID: grant.ProjectID, Keys: testProjectKeys{project: grant.ProjectID, crypter: op.NewAES256GCMCrypto(wrapping, "enc_key_test")}, AuditRotation: func(ctx context.Context, id string) error {
		_, err := store.DB.ExecContext(ctx, "INSERT INTO issued_tokens VALUES (?)", id)
		return err
	}}
	if err := keys.CreateSchema(ctx); err != nil {
		t.Fatal(err)
	}
	first, err := keys.Rotate(ctx, false)
	if err != nil {
		t.Fatal(err)
	}
	var ciphertext string
	if err := store.DB.QueryRow("SELECT private_key_jwe FROM mapi_oauth_signing_keys WHERE key_id=?", first).Scan(&ciphertext); err != nil || !strings.Contains(ciphertext, ".") || strings.Contains(ciphertext, "PRIVATE KEY") {
		t.Fatalf("private key is not encrypted: %v", err)
	}
	user := grant.UserID
	sessions := &testSessions{session: &domain.Session{ProjectID: grant.ProjectID, ID: grant.SessionID, UserID: &user, ExpiresAt: store.Now().Add(time.Hour), Factors: []domain.AuthFactor{domain.SetAuthFactorPassword(store.Now().Add(-time.Minute))}}}
	issuer := TokenIssuer{Issuer: "https://login.example/oauth/proj_A", Keys: keys, Sessions: sessions, Store: store, Lifetime: 5 * time.Minute, RefreshLifetime: time.Hour, AuditMint: func(ctx context.Context, project, user, session, jti string) error {
		_, err := store.DB.ExecContext(ctx, "INSERT INTO issued_tokens VALUES (?)", jti)
		return err
	}}
	if err := issuer.CreateSchema(ctx); err != nil {
		t.Fatal(err)
	}
	if err := store.CreateClientEpochSchema(ctx); err != nil {
		t.Fatal(err)
	}
	grant.Scope = "openid offline_access"
	var result struct{ access, id, refresh string }
	if err := store.Transaction(func() error {
		tokens, err := issuer.MintCodeTokens(ctx, grant)
		if err == nil {
			result.access = tokens.AccessToken
			result.id = tokens.IDToken
			result.refresh = tokens.RefreshToken
		}
		return err
	}); err != nil {
		t.Fatal(err)
	}
	if result.refresh == "" {
		t.Fatal("offline grant missing refresh")
	}
	if err := issuer.ValidateAccess(ctx, result.access, grant.ClientID); err != nil {
		t.Fatalf("valid access token rejected: %v", err)
	}
	savedFactors := sessions.session.Factors
	sessions.session.Factors = []domain.AuthFactor{domain.SetAuthFactorUser(store.Now().Add(-time.Minute))}
	if err := issuer.ValidateAccess(ctx, result.access, grant.ClientID); err == nil {
		t.Fatal("identifier-only session accepted")
	}
	if err := store.Transaction(func() error { _, err := issuer.MintCodeTokens(ctx, grant); return err }); err == nil {
		t.Fatal("identifier-only token issuance accepted")
	}
	sessions.session.Factors = savedFactors
	if err := issuer.ValidateAccess(ctx, result.access, "other-client"); err == nil {
		t.Fatal("wrong audience accepted")
	}
	wrongIssuer := issuer
	wrongIssuer.Issuer = "https://other.example/oauth/proj_A"
	if err := wrongIssuer.ValidateAccess(ctx, result.access, grant.ClientID); err == nil {
		t.Fatal("wrong issuer accepted")
	}
	keysBefore, err := keys.PublicKeys(ctx)
	if err != nil || len(keysBefore.Keys) != 1 {
		t.Fatalf("keys: %v %v", keysBefore, err)
	}
	parsed, err := jwt.ParseSigned(result.id, []jose.SignatureAlgorithm{jose.RS256})
	if err != nil {
		t.Fatal(err)
	}
	var claims tokenClaims
	if err := parsed.Claims(keysBefore.Keys[0].Key, &claims); err != nil {
		t.Fatal(err)
	}
	if claims.Issuer != issuer.Issuer || claims.Subject != grant.UserID || claims.SessionID != grant.SessionID || claims.Nonce != grant.Nonce || len(claims.Audience) != 1 || claims.Audience[0] != grant.ClientID || claims.AccessTokenHash == "" {
		t.Fatalf("incorrect ID token bindings: %+v", claims)
	}
	second, err := keys.Rotate(ctx, true)
	if err != nil {
		t.Fatal(err)
	}
	if second == first {
		t.Fatal("rotation reused key")
	}
	keysAfter, err := keys.PublicKeys(ctx)
	if err != nil || len(keysAfter.Keys) != 2 {
		t.Fatalf("retired key lost: %d %v", len(keysAfter.Keys), err)
	}
	if err := issuer.ValidateAccess(ctx, result.access, grant.ClientID); err != nil {
		t.Fatalf("old token rejected during rollover: %v", err)
	}
	failed := keys
	failed.AuditRotation = func(context.Context, string) error { return errors.New("audit failed") }
	if _, err := failed.Rotate(ctx, true); err == nil {
		t.Fatal("audit failure accepted")
	}
	var active string
	if err := store.DB.QueryRow("SELECT key_id FROM mapi_oauth_signing_keys WHERE project_id=? AND active=1", grant.ProjectID).Scan(&active); err != nil || active != second {
		t.Fatalf("failed rotation persisted: %s %v", active, err)
	}
	allow := func(context.Context) error { return nil }
	auditRevocation := func(ctx context.Context, identity AccessIdentity) error {
		if identity.Subject != grant.UserID || identity.SessionID != grant.SessionID {
			t.Error("incorrect audit identity")
		}
		_, err := store.DB.ExecContext(ctx, "INSERT INTO issued_tokens VALUES ('revocation')")
		return err
	}
	if err := issuer.RevokeAccess(ctx, result.access, "other-client", allow, auditRevocation); err != nil {
		t.Fatal(err)
	}
	if err := issuer.ValidateAccess(ctx, result.access, grant.ClientID); err != nil {
		t.Fatalf("cross-client revocation succeeded: %v", err)
	}
	rollback := errors.New("failed audit")
	if err := issuer.RevokeAccess(ctx, result.access, grant.ClientID, allow, func(context.Context, AccessIdentity) error { return rollback }); !errors.Is(err, rollback) {
		t.Fatalf("audit error lost: %v", err)
	}
	if err := issuer.ValidateAccess(ctx, result.access, grant.ClientID); err != nil {
		t.Fatalf("revocation was not rolled back: %v", err)
	}
	if err := issuer.RevokeAccess(ctx, result.access, grant.ClientID, allow, auditRevocation); err != nil {
		t.Fatal(err)
	}
	if err := issuer.RevokeAccess(ctx, result.access, grant.ClientID, allow, auditRevocation); err != nil {
		t.Fatal(err)
	}
	if err := issuer.ValidateAccess(ctx, result.access, grant.ClientID); !errors.Is(err, ErrInvalidAccess) {
		t.Fatalf("revoked access accepted: %v", err)
	}
	var revocationCount int
	if err := store.DB.QueryRow("SELECT COUNT(*) FROM issued_tokens WHERE value='revocation'").Scan(&revocationCount); err != nil || revocationCount != 1 {
		t.Fatalf("non-idempotent audit: %d %v", revocationCount, err)
	}
	sessions.session = nil
	if err := issuer.ValidateAccess(ctx, result.access, grant.ClientID); err == nil {
		t.Fatal("revoked session accepted")
	}
}
