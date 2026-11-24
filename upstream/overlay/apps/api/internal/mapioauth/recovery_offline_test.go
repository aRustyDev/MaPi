package mapioauth

import (
	"context"
	"testing"
	"time"

	"github.com/go-jose/go-jose/v4"
	"github.com/go-jose/go-jose/v4/jwt"
	"github.com/zitadel/nextgen/internal/domain"
	"github.com/zitadel/oidc/v3/pkg/op"
)

func TestRecoveryRevokesOnlineButNotOfflineJWT(t *testing.T) {
	ctx := context.Background()
	store, grant := fixture(t)
	if err := store.CreateRefreshSchema(ctx); err != nil {
		t.Fatal(err)
	}
	if err := store.CreateClientEpochSchema(ctx); err != nil {
		t.Fatal(err)
	}
	var wrapping [32]byte
	for i := range wrapping {
		wrapping[i] = byte(i)
	}
	keys := SigningKeys{Store: store, ProjectID: grant.ProjectID, Keys: testProjectKeys{project: grant.ProjectID, crypter: op.NewAES256GCMCrypto(wrapping, "enc_key_test")}, AuditRotation: func(ctx context.Context, id string) error {
		_, err := store.DB.ExecContext(ctx, "INSERT INTO issued_tokens VALUES (?)", id)
		return err
	}}
	if err := keys.CreateSchema(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := keys.Rotate(ctx, false); err != nil {
		t.Fatal(err)
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
	grant.Scope = "openid offline_access"
	var access, id string
	if err := store.Transaction(func() error {
		tokens, err := issuer.MintCodeTokens(ctx, grant)
		if err == nil {
			access = tokens.AccessToken
			id = tokens.IDToken
		}
		return err
	}); err != nil {
		t.Fatal(err)
	}
	if err := issuer.ValidateAccess(ctx, access, grant.ClientID); err != nil {
		t.Fatal(err)
	}
	public, err := keys.PublicKeys(ctx)
	if err != nil || len(public.Keys) != 1 {
		t.Fatalf("public keys: %v", err)
	}
	cached := public.Keys[0].Key
	verifyOffline := func(token string) {
		t.Helper()
		signed, err := jwt.ParseSigned(token, []jose.SignatureAlgorithm{jose.RS256})
		if err != nil {
			t.Fatal(err)
		}
		var claims jwt.Claims
		if err = signed.Claims(cached, &claims); err != nil {
			t.Fatal(err)
		}
		if err = claims.ValidateWithLeeway(jwt.Expected{Issuer: issuer.Issuer, AnyAudience: jwt.Audience{grant.ClientID}, Time: store.Now()}, 0); err != nil {
			t.Fatal(err)
		}
	}
	verifyOffline(access)
	verifyOffline(id)
	sessions.session = nil
	if err := issuer.ValidateAccess(ctx, access, grant.ClientID); err == nil {
		t.Fatal("online access accepted deleted session")
	}
	verifyOffline(access)
	verifyOffline(id)
	if _, err := keys.Rotate(ctx, true); err != nil {
		t.Fatal(err)
	}
	retained, err := keys.PublicKeys(ctx)
	if err != nil || len(retained.Keys) != 2 {
		t.Fatalf("normal rotation did not retain old key: %v", err)
	}
	verifyOffline(access)
	verifyOffline(id)
}
