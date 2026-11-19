//go:build mapi_native_e2e && !wasip1

package mapioauth

import (
	"context"
	"crypto"
	"crypto/ecdsa"
	"crypto/ed25519"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/go-jose/go-jose/v4"
	"github.com/go-jose/go-jose/v4/jwt"
	"github.com/zitadel/nextgen/internal/audit"
	"github.com/zitadel/nextgen/internal/domain"
	"github.com/zitadel/nextgen/internal/mapidpop"
	"github.com/zitadel/nextgen/internal/secrets"
	"github.com/zitadel/nextgen/internal/service"
	configdefaults "github.com/zitadel/nextgen/packages/config/defaults"
	"github.com/zitadel/oidc/v3/pkg/op"
)

// Uses real migrated Nextgen SQL statements and transaction/audit storage;
// seeded session has a synthetic verified factor, not a browser sign-in.
func exerciseFAPIAccess(t *testing.T, p *PrivatePAR, pool *service.DB, db *sql.DB, now time.Time, client, jkt string, assertion func(string) string, signer jose.Signer, challenge string) {
	t.Helper()
	ctx := context.Background()
	project := p.Grants.ProjectID
	user, session := "fapi-user", "fapi-session"
	stamp := now.Add(-time.Second).UnixNano()
	for _, query := range []struct {
		sql  string
		args []any
	}{
		{`INSERT INTO users(project_id,id,schema_url,status,created_at,updated_at) VALUES(?,?,?,'active',?,?)`, []any{project, user, "synthetic", stamp, stamp}},
		{`INSERT INTO sessions(project_id,id,created_at,updated_at,time_to_live,user_id) VALUES(?,?,?,?,?,?)`, []any{project, session, stamp, stamp, int64(time.Hour), user}},
		{`INSERT INTO checks(project_id,id,session_id,type,last_verified_at) VALUES(?,?,?,?,?)`, []any{project, "fapi-check", session, int(domain.AuthCheckTypePassword), stamp}},
	} {
		if _, err := db.ExecContext(ctx, query.sql, query.args...); err != nil {
			t.Fatal(err)
		}
	}
	wrapping := [32]byte{1, 2, 3}
	keys := FAPISigningKeys{Store: p.Store, Keys: testProjectKeys{project: project, crypter: op.NewAES256GCMCrypto(wrapping, "enc_key_test")}, ProjectID: project, AuditRotation: func(ctx context.Context, id string) error {
		return audit.Emit(ctx, pool.Statements(), audit.EmitSpec{Type: domain.EventType("mapi.fapi.signing_key.rotated"), Category: domain.EventCategoryAdmin, ProjectID: project, EntityType: "oauth_signing_key", EntityID: id})
	}}
	first, err := keys.Rotate(ctx, false)
	if err != nil {
		t.Fatal(err)
	}
	failAudit := true
	failAccess := false
	issuer := FAPIAccessIssuer{Private: p, Keys: keys, Sessions: pool.Statements(), Registry: ClientRegistry{Statements: pool.Statements()}, Lifetime: 5 * time.Minute, RefreshLifetime: time.Hour,
		AuditMint: func(ctx context.Context, g FAPIExchangeGrant, id string) error {
			if err := audit.Emit(ctx, pool.Statements(), audit.EmitSpec{Type: domain.EventTypeAuthTokenIssued, Category: domain.EventCategoryAuth, ProjectID: project, EntityType: "fapi_access_token", EntityID: id, UserID: g.UserID, SessionID: &g.SessionID, Payload: domain.AuthTokenIssuedPayload{}}); err != nil {
				return err
			}
			if failAudit {
				return errors.New("audit failure")
			}
			return nil
		},
		AuditIDToken: func(ctx context.Context, g FAPIExchangeGrant, id string) error {
			return audit.Emit(ctx, pool.Statements(), audit.EmitSpec{Type: domain.EventTypeAuthTokenIssued, Category: domain.EventCategoryAuth, ProjectID: project, EntityType: "fapi_id_token", EntityID: id, UserID: g.UserID, SessionID: &g.SessionID, Payload: domain.AuthTokenIssuedPayload{}})
		},
		AuditAccess: func(ctx context.Context, id AccessIdentity) error {
			if err := audit.Emit(ctx, pool.Statements(), audit.EmitSpec{Type: domain.EventType("mapi.fapi.access.validated"), Category: domain.EventCategoryAuth, ProjectID: project, EntityType: "fapi_access_token", UserID: id.Subject, SessionID: &id.SessionID}); err != nil {
				return err
			}
			if failAccess {
				return errors.New("access audit failure")
			}
			return nil
		},
	}
	exchange := FAPIExchange{Private: p, CheckSession: func(ctx context.Context, project, user, session string) error {
		_, err := issuer.session(ctx, project, user, session)
		return err
	}, Mint: issuer.Mint, Audit: func(ctx context.Context, g FAPIExchangeGrant) error {
		return audit.Emit(ctx, pool.Statements(), audit.EmitSpec{Type: domain.EventType("mapi.fapi.token.exchanged"), Category: domain.EventCategoryAuth, ProjectID: project, EntityType: "oauth_client", EntityID: g.ClientID, UserID: g.UserID, SessionID: &g.SessionID})
	}}
	exchange.AuditReuse = exchange.Audit
	tokenNonce, err := p.Nonces.Issue(ctx, mapidpop.NonceScope{ProjectID: project, ClientID: client, Purpose: "token"})
	if err != nil {
		t.Fatal(err)
	}
	tp, err := jwt.Signed(signer).Claims(map[string]any{"jti": "fapi-access-token-proof", "htm": "POST", "htu": p.Assertions.Issuer + "/token", "iat": now.Add(10 * time.Second).Unix(), "nonce": tokenNonce}).Serialize()
	if err != nil {
		t.Fatal(err)
	}
	grant := AuthorizationCode{ProjectID: project, ClientID: client, RedirectURI: "https://rp.example/callback", UserID: user, SessionID: session, Scope: "openid offline_access", Nonce: "nonce", CodeChallenge: challenge, ExpiresAt: now.Add(30 * time.Second), PolicyVersion: 1}
	var code string
	if err = p.Store.Transaction(func() error { var e error; code, e = p.Grants.IssueCodeInTransaction(ctx, grant, jkt); return e }); err != nil {
		t.Fatal(err)
	}
	req := FAPIExchangeRequest{ClientID: client, AssertionType: privateKeyAssertionType, Assertion: assertion("fapi-access-assertion"), Proof: tp, Code: code, RedirectURI: grant.RedirectURI, Verifier: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~"}
	badFuture, err := jwt.Signed(signer).Claims(map[string]any{"jti": "fapi-access-token-proof", "htm": "POST", "htu": p.Assertions.Issuer + "/token", "iat": now.Add(11 * time.Second).Unix(), "nonce": tokenNonce}).Serialize()
	if err != nil {
		t.Fatal(err)
	}
	badRequest := req
	badRequest.Proof = badFuture
	if _, err = exchange.ExchangeCode(ctx, badRequest); !errors.Is(err, ErrInvalidDPoP) {
		t.Fatalf("future DPoP accepted: %v", err)
	}
	if raw, err := exchange.ExchangeCode(ctx, req); err == nil || raw != nil {
		t.Fatal("audit failure must roll back token")
	}
	var count int
	if err = db.QueryRow(`SELECT COUNT(*) FROM mapi_fapi_refresh_tokens WHERE user_id=?`, user).Scan(&count); err != nil || count != 0 {
		t.Fatal("failed issuance left refresh grant")
	}
	if err = db.QueryRow(`SELECT COUNT(*) FROM events WHERE project_id=? AND entity_type=?`, project, "fapi_id_token").Scan(&count); err != nil || count != 0 {
		t.Fatal("failed exchange persisted ID-token audit")
	}
	failAudit = false
	raw, err := exchange.ExchangeCode(ctx, req)
	if err != nil {
		t.Fatal(err)
	}
	var response fapiAccessResponse
	if err = json.Unmarshal(raw, &response); err != nil || response.TokenType != "DPoP" || response.AccessToken == "" || response.IDToken == "" || response.RefreshToken == "" {
		t.Fatalf("invalid response: %v", err)
	}
	// An independent RP verifies the actual ES256 signature and claims using
	// the public key; server-side validation also checks live state.
	parsed, err := jwt.ParseSigned(response.IDToken, []jose.SignatureAlgorithm{jose.ES256})
	if err != nil {
		t.Fatal(err)
	}
	public, err := keys.PublicKeys(ctx)
	if err != nil {
		t.Fatal(err)
	}
	matching := public.Key(parsed.Headers[0].KeyID)
	if len(matching) != 1 {
		t.Fatal("ID token public key missing")
	}
	var idClaims fapiIDClaims
	if err = parsed.Claims(matching[0].Key, &idClaims); err != nil {
		t.Fatal(err)
	}
	h := sha256.Sum256([]byte(response.AccessToken))
	if idClaims.Issuer != p.Assertions.Issuer || idClaims.Subject != user || len(idClaims.Audience) != 1 || idClaims.Audience[0] != client || idClaims.Nonce != grant.Nonce || idClaims.SessionID != session || idClaims.AuthTime == nil || !idClaims.AuthTime.Time().Equal(now.Add(-time.Second)) || idClaims.AccessTokenHash != base64.RawURLEncoding.EncodeToString(h[:16]) {
		t.Fatal("ID token claims not bound to session and access token")
	}
	if id, err := issuer.ValidateIDToken(ctx, response.IDToken, client, grant.Nonce, response.AccessToken); err != nil || id.Subject != user {
		t.Fatalf("ID token validation: %v", err)
	}
	for _, bad := range []struct{ client, nonce, access string }{{"wrong-client", grant.Nonce, response.AccessToken}, {client, "wrong-nonce", response.AccessToken}, {client, grant.Nonce, "wrong-access-token"}} {
		if _, err := issuer.ValidateIDToken(ctx, response.IDToken, bad.client, bad.nonce, bad.access); err == nil {
			t.Fatal("wrong ID token binding accepted")
		}
	}
	parts := strings.Split(response.IDToken, ".")
	replacement := "A"
	if strings.HasPrefix(parts[2], replacement) {
		replacement = "B"
	}
	parts[2] = replacement + parts[2][1:]
	if _, err = issuer.ValidateIDToken(ctx, strings.Join(parts, "."), client, grant.Nonce, response.AccessToken); err == nil {
		t.Fatal("invalid ID signature accepted")
	}
	freshProof := func(jti string) string {
		raw, err := jwt.Signed(signer).Claims(map[string]any{"jti": jti, "htm": "POST", "htu": p.Assertions.Issuer + "/token", "iat": now.Unix(), "nonce": tokenNonce}).Serialize()
		if err != nil {
			t.Fatal(err)
		}
		return raw
	}
	refreshReq := req
	refreshReq.Assertion = assertion("fapi-id-refresh-assertion")
	refreshReq.Proof = freshProof("fapi-id-refresh-proof")
	refreshReq.RefreshToken = response.RefreshToken
	refreshReq.ScopeProvided = true
	refreshReq.Scope = "openid payments.write"
	if _, err = exchange.ExchangeRefresh(ctx, refreshReq); !errors.Is(err, ErrInvalidRefreshScope) {
		t.Fatalf("expanded refresh scope accepted: %v", err)
	}
	// The rejected expansion rolls back assertion and proof replay records.
	refreshReq.Scope = "offline_access openid"
	refreshRaw, err := exchange.ExchangeRefresh(ctx, refreshReq)
	if err != nil {
		t.Fatal(err)
	}
	var refreshed fapiAccessResponse
	if err = json.Unmarshal(refreshRaw, &refreshed); err != nil || refreshed.IDToken != "" || refreshed.RefreshToken != "" || refreshed.Scope != "openid offline_access" {
		t.Fatalf("refresh returned an unexpected ID or replacement refresh token: %v", err)
	}
	refreshReq.Assertion = assertion("fapi-id-refresh-subset-assertion")
	refreshReq.Proof = freshProof("fapi-id-refresh-subset-proof")
	refreshReq.Scope = "openid"
	subsetRaw, err := exchange.ExchangeRefresh(ctx, refreshReq)
	if err != nil {
		t.Fatal(err)
	}
	var subset fapiAccessResponse
	if err = json.Unmarshal(subsetRaw, &subset); err != nil || subset.Scope != "openid" || subset.RefreshToken != "" {
		t.Fatal("refresh scope was not narrowed")
	}
	refreshReq.Assertion = assertion("fapi-refresh-without-openid-assertion")
	refreshReq.Proof = freshProof("fapi-refresh-without-openid-proof")
	refreshReq.Scope = "offline_access"
	withoutOpenID, err := exchange.ExchangeRefresh(ctx, refreshReq)
	if err != nil {
		t.Fatalf("refresh subset without openid: %v", err)
	}
	var noOIDC fapiAccessResponse
	if err = json.Unmarshal(withoutOpenID, &noOIDC); err != nil || noOIDC.Scope != "offline_access" || noOIDC.IDToken != "" {
		t.Fatal("non-OIDC refresh subset incorrect")
	}
	// Narrowing one response does not narrow or rotate the original grant.
	refreshReq.Assertion = assertion("fapi-id-refresh-full-assertion")
	refreshReq.Proof = freshProof("fapi-id-refresh-full-proof")
	refreshReq.Scope = "openid offline_access"
	if _, err = exchange.ExchangeRefresh(ctx, refreshReq); err != nil {
		t.Fatalf("original refresh grant changed: %v", err)
	}
	// A confidential client can use a new DPoP key at refresh. Its private
	// client assertion authenticates the grant, and the new access token must
	// bind to the new proof key, not the original authorization-code key.
	rotatedKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	rotatedJWK := jose.JSONWebKey{Key: &rotatedKey.PublicKey}
	rotatedThumb, err := rotatedJWK.Thumbprint(crypto.SHA256)
	if err != nil {
		t.Fatal(err)
	}
	rotatedJKT := base64.RawURLEncoding.EncodeToString(rotatedThumb)
	rotatedSigner, err := jose.NewSigner(jose.SigningKey{Algorithm: jose.ES256, Key: rotatedKey}, (&jose.SignerOptions{}).WithHeader("typ", "dpop+jwt").WithHeader("jwk", rotatedJWK))
	if err != nil {
		t.Fatal(err)
	}
	rotatedProof, err := jwt.Signed(rotatedSigner).Claims(map[string]any{"jti": "fapi-rotated-refresh-proof", "htm": "POST", "htu": p.Assertions.Issuer + "/token", "iat": now.Unix(), "nonce": tokenNonce}).Serialize()
	if err != nil {
		t.Fatal(err)
	}
	refreshReq.Assertion = assertion("fapi-rotated-refresh-assertion")
	refreshReq.Proof = rotatedProof
	refreshReq.ScopeProvided = false
	refreshReq.Scope = ""
	unauthenticated := refreshReq
	unauthenticated.Assertion = "invalid"
	if _, err = exchange.ExchangeRefresh(ctx, unauthenticated); !errors.Is(err, ErrInvalidClient) {
		t.Fatalf("unauthenticated refresh accepted: %v", err)
	}
	missingProof := refreshReq
	missingProof.Proof = ""
	if _, err = exchange.ExchangeRefresh(ctx, missingProof); !errors.Is(err, ErrInvalidDPoP) {
		t.Fatalf("refresh without proof accepted: %v", err)
	}
	rotatedRaw, err := exchange.ExchangeRefresh(ctx, refreshReq)
	if err != nil {
		t.Fatalf("confidential DPoP key rotation: %v", err)
	}
	var rotatedResponse fapiAccessResponse
	if err = json.Unmarshal(rotatedRaw, &rotatedResponse); err != nil {
		t.Fatal(err)
	}
	rotatedJWT, err := jwt.ParseSigned(rotatedResponse.AccessToken, []jose.SignatureAlgorithm{jose.ES256})
	if err != nil {
		t.Fatal(err)
	}
	rotatedKeys, err := keys.PublicKeys(ctx)
	if err != nil {
		t.Fatal(err)
	}
	rotatedMatches := rotatedKeys.Key(rotatedJWT.Headers[0].KeyID)
	if len(rotatedMatches) != 1 {
		t.Fatal("rotated access signer missing")
	}
	var rotatedClaims fapiAccessClaims
	if err = rotatedJWT.Claims(rotatedMatches[0].Key, &rotatedClaims); err != nil || rotatedClaims.Confirmation.JKT != rotatedJKT || rotatedJKT == jkt {
		t.Fatal("new access token not bound to refreshed DPoP key")
	}
	emptyNonceGrant := grant
	emptyNonceGrant.Nonce = ""
	var emptyNonceCode string
	if err = p.Store.Transaction(func() error {
		var e error
		emptyNonceCode, e = p.Grants.IssueCodeInTransaction(ctx, emptyNonceGrant, jkt)
		return e
	}); err != nil {
		t.Fatal(err)
	}
	emptyReq := req
	emptyReq.Code = emptyNonceCode
	emptyReq.Assertion = assertion("fapi-empty-nonce-assertion")
	emptyReq.Proof = freshProof("fapi-empty-nonce-proof")
	emptyRaw, err := exchange.ExchangeCode(ctx, emptyReq)
	if err != nil {
		t.Fatal(err)
	}
	var emptyResponse fapiAccessResponse
	if err = json.Unmarshal(emptyRaw, &emptyResponse); err != nil {
		t.Fatal(err)
	}
	if _, err = issuer.ValidateIDToken(ctx, emptyResponse.IDToken, client, "", emptyResponse.AccessToken); err != nil {
		t.Fatalf("optional nonce omitted: %v", err)
	}
	if _, err = issuer.ValidateIDToken(ctx, emptyResponse.IDToken, client, "unexpected", emptyResponse.AccessToken); err == nil {
		t.Fatal("unsolicited nonce accepted")
	}
	resNonce, err := p.Nonces.Issue(ctx, mapidpop.NonceScope{ProjectID: project, ClientID: client, Purpose: "resource"})
	if err != nil {
		t.Fatal(err)
	}
	rotatedResourceHash := sha256.Sum256([]byte(rotatedResponse.AccessToken))
	rotatedATH := base64.RawURLEncoding.EncodeToString(rotatedResourceHash[:])
	rotatedResourceURL := "https://api.example/resource"
	rotatedResourceProof, err := jwt.Signed(rotatedSigner).Claims(map[string]any{"jti": "fapi-rotated-resource", "htm": "GET", "htu": rotatedResourceURL, "iat": now.Unix(), "nonce": resNonce, "ath": rotatedATH}).Serialize()
	if err != nil {
		t.Fatal(err)
	}
	if _, err = issuer.ValidateResource(ctx, rotatedResponse.AccessToken, rotatedResourceProof, "GET", rotatedResourceURL, client); err != nil {
		t.Fatalf("new DPoP key could not use refreshed access token: %v", err)
	}
	tokenHash := sha256.Sum256([]byte(response.AccessToken))
	ath := base64.RawURLEncoding.EncodeToString(tokenHash[:])
	resourceURL := "https://api.example/resource"
	mkProof := func(signer jose.Signer, id, hash string) string {
		raw, err := jwt.Signed(signer).Claims(map[string]any{"jti": id, "htm": "GET", "htu": resourceURL, "iat": now.Unix(), "nonce": resNonce, "ath": hash}).Serialize()
		if err != nil {
			t.Fatal(err)
		}
		return raw
	}
	clockProof := func(jti string, offset time.Duration) string {
		raw, err := jwt.Signed(signer).Claims(map[string]any{"jti": jti, "htm": "GET", "htu": resourceURL, "iat": now.Add(offset).Unix(), "nonce": resNonce, "ath": ath}).Serialize()
		if err != nil {
			t.Fatal(err)
		}
		return raw
	}
	if _, err = issuer.ValidateResource(ctx, response.AccessToken, clockProof("resource-future-11", 11*time.Second), "GET", resourceURL, client); !errors.Is(err, ErrInvalidDPoP) {
		t.Fatalf("future resource proof accepted: %v", err)
	}
	if _, err = issuer.ValidateResource(ctx, response.AccessToken, clockProof("resource-future-10", 10*time.Second), "GET", resourceURL, client); err != nil {
		t.Fatalf("ten-second resource skew rejected: %v", err)
	}
	valid := mkProof(signer, "resource-1", ath)
	if _, err = issuer.ValidateResource(ctx, response.AccessToken, valid, "GET", resourceURL, "wrong-audience"); err == nil {
		t.Fatal("wrong audience accepted")
	}
	badAth := mkProof(signer, "resource-bad-ath", base64.RawURLEncoding.EncodeToString(make([]byte, 32)))
	if _, err = issuer.ValidateResource(ctx, response.AccessToken, badAth, "GET", resourceURL, client); err == nil {
		t.Fatal("wrong ath accepted")
	}
	wrongKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	wrongSigner, err := jose.NewSigner(jose.SigningKey{Algorithm: jose.ES256, Key: wrongKey}, (&jose.SignerOptions{}).WithHeader("typ", "dpop+jwt").WithHeader("jwk", jose.JSONWebKey{Key: &wrongKey.PublicKey}))
	if err != nil {
		t.Fatal(err)
	}
	if _, err = issuer.ValidateResource(ctx, response.AccessToken, mkProof(wrongSigner, "wrong-jkt", ath), "GET", resourceURL, client); err == nil {
		t.Fatal("wrong JKT accepted")
	}
	failAccess = true
	if _, err = issuer.ValidateResource(ctx, response.AccessToken, valid, "GET", resourceURL, client); err == nil {
		t.Fatal("failed access audit committed")
	}
	failAccess = false
	id, err := issuer.ValidateResource(ctx, response.AccessToken, valid, "GET", resourceURL, client)
	if err != nil || id.Subject != user {
		t.Fatalf("valid token: %v", err)
	}
	if _, err = issuer.ValidateResource(ctx, response.AccessToken, valid, "GET", resourceURL, client); err == nil {
		t.Fatal("proof replay accepted")
	}
	failingKeys := keys
	failingKeys.AuditRotation = func(context.Context, string) error { return errors.New("injected key audit failure") }
	if _, err := failingKeys.Rotate(ctx, true); err == nil {
		t.Fatal("failed key audit committed")
	}
	if set, err := keys.PublicKeys(ctx); err != nil || len(set.Keys) != 1 {
		t.Fatal("failed rotation persisted")
	}
	if second, err := keys.Rotate(ctx, true); err != nil || second == first {
		t.Fatal("key rotation failed")
	}
	if _, err = issuer.ValidateResource(ctx, response.AccessToken, mkProof(signer, "after-key-rotation", ath), "GET", resourceURL, client); err != nil {
		t.Fatalf("retired key validation: %v", err)
	}
	if _, err = issuer.ValidateIDToken(ctx, response.IDToken, client, grant.Nonce, response.AccessToken); err != nil {
		t.Fatalf("ID token failed after key rollover: %v", err)
	}
	oldNow := p.Store.Now
	p.Store.Now = func() time.Time { return now.Add(6 * time.Minute) }
	if _, err = issuer.ValidateResource(ctx, response.AccessToken, mkProof(signer, "expired", ath), "GET", resourceURL, client); err == nil {
		t.Fatal("expired token accepted")
	}
	if _, err = issuer.ValidateIDToken(ctx, response.IDToken, client, grant.Nonce, response.AccessToken); err == nil {
		t.Fatal("expired ID token accepted")
	}
	p.Store.Now = oldNow
	wrongProject := issuer
	wrongProject.Keys.ProjectID = "another-project"
	if _, err = wrongProject.ValidateResource(ctx, response.AccessToken, mkProof(signer, "wrong-project", ath), "GET", resourceURL, client); err == nil {
		t.Fatal("cross-project token accepted")
	}
	// A second real project has its own signing ring; it must not validate
	// a token signed for this project even when both share the same SQL pool.
	projectB := "proj_B"
	if err := pool.Statements().CreateProject(ctx, &domain.Project{ID: projectB, Name: "Other project"}); err != nil {
		t.Fatal(err)
	}
	otherPrivate, err := NewPrivatePAR(PrivatePARConfig{ProjectID: projectB, Issuer: "https://issuer.example/oauth/" + projectB, Store: p.Store, Pool: pool})
	if err != nil {
		t.Fatal(err)
	}
	otherKeys := FAPISigningKeys{Store: p.Store, Keys: testProjectKeys{project: projectB, crypter: op.NewAES256GCMCrypto(wrapping, "enc_key_test")}, ProjectID: projectB, AuditRotation: func(context.Context, string) error { return nil }}
	if _, err = otherKeys.Rotate(ctx, false); err != nil {
		t.Fatal(err)
	}
	otherIssuer := issuer
	otherIssuer.Private = otherPrivate
	otherIssuer.Keys = otherKeys
	if _, err = otherIssuer.ValidateResource(ctx, response.AccessToken, mkProof(signer, "other-project", ath), "GET", resourceURL, client); err == nil {
		t.Fatal("token crossed real project key ring")
	}
	other := *p
	other.Assertions.Issuer = "https://other.example/oauth/" + project
	different := issuer
	different.Private = &other
	if _, err = different.ValidateIDToken(ctx, response.IDToken, client, grant.Nonce, response.AccessToken); err == nil {
		t.Fatal("wrong ID token issuer accepted")
	}
	if _, err = different.ValidateResource(ctx, response.AccessToken, mkProof(signer, "wrong-issuer", ath), "GET", resourceURL, client); err == nil {
		t.Fatal("wrong issuer accepted")
	}
	// Authenticated code reuse revokes the original and refresh-derived
	// access tokens and refresh authority only if the audit commits.
	reuse := req
	reuse.Assertion = assertion("family-replay-assertion")
	reuse.Proof = freshProof("family-replay-proof")
	wrongVerifier := reuse
	wrongVerifier.Verifier = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._x"
	if _, err = exchange.ExchangeCode(ctx, wrongVerifier); !errors.Is(err, ErrInvalidCode) {
		t.Fatalf("wrong PKCE verifier accepted on replay: %v", err)
	}
	wrongRedirect := reuse
	wrongRedirect.RedirectURI = "https://other.example/callback"
	if _, err = exchange.ExchangeCode(ctx, wrongRedirect); !errors.Is(err, ErrInvalidCode) {
		t.Fatalf("wrong redirect accepted on replay: %v", err)
	}
	wrongProof := reuse
	wrongProof.Proof, err = jwt.Signed(wrongSigner).Claims(map[string]any{"jti": "family-wrong-key", "htm": "POST", "htu": p.Assertions.Issuer + "/token", "iat": now.Unix(), "nonce": tokenNonce}).Serialize()
	if err != nil {
		t.Fatal(err)
	}
	if _, err = exchange.ExchangeCode(ctx, wrongProof); !errors.Is(err, ErrInvalidCode) {
		t.Fatalf("wrong proof key accepted on replay: %v", err)
	}
	failReuse := exchange
	failReuse.AuditReuse = func(ctx context.Context, g FAPIExchangeGrant) error {
		if err := exchange.AuditReuse(ctx, g); err != nil {
			return err
		}
		return errors.New("injected family audit failure")
	}
	if _, err = failReuse.ExchangeCode(ctx, reuse); err == nil || errors.Is(err, ErrInvalidCode) {
		t.Fatalf("reuse audit failure hidden: %v", err)
	}
	if _, err = issuer.ValidateResource(ctx, response.AccessToken, mkProof(signer, "family-audit-rollback", ath), "GET", resourceURL, client); err != nil {
		t.Fatalf("failed audit revoked token: %v", err)
	}
	if _, err = exchange.ExchangeCode(ctx, reuse); !errors.Is(err, ErrInvalidCode) {
		t.Fatalf("reuse was not invalid grant: %v", err)
	}
	if _, err = issuer.ValidateResource(ctx, response.AccessToken, mkProof(signer, "family-first-token-revoked", ath), "GET", resourceURL, client); !errors.Is(err, ErrInvalidAccess) {
		t.Fatalf("first access survived reuse: %v", err)
	}
	refreshedHash := sha256.Sum256([]byte(refreshed.AccessToken))
	if _, err = issuer.ValidateResource(ctx, refreshed.AccessToken, mkProof(signer, "family-refreshed-token-revoked", base64.RawURLEncoding.EncodeToString(refreshedHash[:])), "GET", resourceURL, client); !errors.Is(err, ErrInvalidAccess) {
		t.Fatalf("refreshed access survived reuse: %v", err)
	}
	err = p.Store.Transaction(func() error { _, e := p.Grants.RefreshInTransaction(ctx, response.RefreshToken, client, jkt); return e })
	if !errors.Is(err, ErrInvalidRefresh) {
		t.Fatalf("refresh survived code reuse: %v", err)
	}
	// A configured resource audience and client-scoped application grant
	// survive issuance. Authorization requires exact audience, client and
	// all configured scopes; missing/revoked policy fails closed.
	originalID, originalAccess := response.IDToken, response.AccessToken
	customIssuer := issuer
	policyVersion, err := p.Policies.Put(ctx, client, "https://api.example/payments", []string{"payments.read"}, true, 1)
	if err != nil {
		t.Fatal(err)
	}
	var customRaw []byte
	if err = p.Store.Transaction(func() error {
		var e error
		customRaw, e = customIssuer.Mint(ctx, FAPIExchangeGrant{ProjectID: project, ClientID: client, UserID: user, SessionID: session, Scope: "openid payments.read", Nonce: "resource-nonce", DPoPJKT: jkt, PolicyVersion: policyVersion.Version})
		return e
	}); err != nil {
		t.Fatal(err)
	}
	var customToken fapiAccessResponse
	if err = json.Unmarshal(customRaw, &customToken); err != nil {
		t.Fatal(err)
	}
	customHash := sha256.Sum256([]byte(customToken.AccessToken))
	customATH := base64.RawURLEncoding.EncodeToString(customHash[:])
	customProof := mkProof(signer, "resource-custom", customATH)
	policy := FAPIResourcePolicy{Audience: "https://api.example/payments", AllowedClients: []string{client}, RequiredScopes: []string{"payments.read"}}
	if _, err = customIssuer.ValidateResource(ctx, customToken.AccessToken, customProof, "GET", resourceURL, ""); err == nil {
		t.Fatal("empty resource audience accepted")
	}
	invalidPolicy := policy
	invalidPolicy.Audience = "https://other.example"
	if _, err = customIssuer.AuthorizeResource(ctx, customToken.AccessToken, customProof, "GET", resourceURL, invalidPolicy); err == nil {
		t.Fatal("wrong resource audience allowed")
	}
	invalidPolicy = policy
	invalidPolicy.AllowedClients = []string{"other-client"}
	if _, err = customIssuer.AuthorizeResource(ctx, customToken.AccessToken, customProof, "GET", resourceURL, invalidPolicy); !errors.Is(err, ErrInsufficientScope) {
		t.Fatalf("wrong authorized client: %v", err)
	}
	invalidPolicy = policy
	invalidPolicy.RequiredScopes = []string{"payments.write"}
	if _, err = customIssuer.AuthorizeResource(ctx, customToken.AccessToken, customProof, "GET", resourceURL, invalidPolicy); !errors.Is(err, ErrInsufficientScope) {
		t.Fatalf("missing resource scope: %v", err)
	}
	policyVersion, err = p.Policies.Put(ctx, client, policyVersion.Audience, policyVersion.Scopes, false, policyVersion.Version)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = customIssuer.AuthorizeResource(ctx, customToken.AccessToken, customProof, "GET", resourceURL, policy); err == nil {
		t.Fatal("disabled project policy accepted")
	}
	policyVersion, err = p.Policies.Put(ctx, client, policyVersion.Audience, policyVersion.Scopes, true, policyVersion.Version)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = customIssuer.AuthorizeResource(ctx, customToken.AccessToken, customProof, "GET", resourceURL, policy); !errors.Is(err, ErrInvalidAccess) {
		t.Fatalf("old policy token revived: %v", err)
	}
	if err = p.Store.Transaction(func() error {
		var e error
		customRaw, e = customIssuer.Mint(ctx, FAPIExchangeGrant{ProjectID: project, ClientID: client, UserID: user, SessionID: session, Scope: "openid payments.read", Nonce: "resource-nonce", DPoPJKT: jkt, PolicyVersion: policyVersion.Version})
		return e
	}); err != nil {
		t.Fatal(err)
	}
	if err = json.Unmarshal(customRaw, &customToken); err != nil {
		t.Fatal(err)
	}
	customHash = sha256.Sum256([]byte(customToken.AccessToken))
	customATH = base64.RawURLEncoding.EncodeToString(customHash[:])
	customProof = mkProof(signer, "resource-custom-new-generation", customATH)
	if _, err = customIssuer.AuthorizeResource(ctx, customToken.AccessToken, customProof, "GET", resourceURL, policy); err != nil {
		t.Fatalf("new generation scoped resource: %v", err)
	}
	revokeNonce, err := p.Nonces.Issue(ctx, mapidpop.NonceScope{ProjectID: project, ClientID: client, Purpose: "revocation"})
	if err != nil {
		t.Fatal(err)
	}
	revokeProof := func(signer jose.Signer, id, token string) string {
		raw, err := jwt.Signed(signer).Claims(map[string]any{"jti": id, "htm": "POST", "htu": p.Assertions.Issuer + "/revoke", "iat": now.Unix(), "nonce": revokeNonce}).Serialize()
		if err != nil {
			t.Fatal(err)
		}
		return raw
	}
	failRevoke := true
	revoker := FAPIRevoker{Issuer: issuer, Audit: func(ctx context.Context, id AccessIdentity) error {
		if err := audit.Emit(ctx, pool.Statements(), audit.EmitSpec{Type: domain.EventTypeAuthTokenRevoked, Category: domain.EventCategoryAuth, ProjectID: project, EntityType: "fapi_access_token", UserID: id.Subject, SessionID: &id.SessionID, Payload: domain.AuthTokenRevokedPayload{}}); err != nil {
			return err
		}
		if failRevoke {
			return errors.New("revocation audit failure")
		}
		return nil
	}, AuditRefresh: func(ctx context.Context, id AccessIdentity) error {
		return audit.Emit(ctx, pool.Statements(), audit.EmitSpec{Type: domain.EventTypeAuthTokenRevoked, Category: domain.EventCategoryAuth, ProjectID: project, EntityType: "fapi_refresh_token", UserID: id.Subject, SessionID: &id.SessionID, Payload: domain.AuthTokenRevokedPayload{}})
	}}
	failRevoke = false
	// RFC 7009 client-authenticated requests need no DPoP header or ath.
	// Verify access and refresh revocation, unknown-token nondisclosure and
	// the actual HTTP status/body contract against this real project store.
	httpRevoke := func(token, assertionID, hint string) *httptest.ResponseRecorder {
		form := url.Values{"client_id": {client}, "client_assertion_type": {privateKeyAssertionType}, "client_assertion": {assertion(assertionID)}, "token": {token}, "token_type_hint": {hint}}
		r := httptest.NewRequest(http.MethodPost, p.Assertions.Issuer+"/revoke", strings.NewReader(form.Encode()))
		r.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		w := httptest.NewRecorder()
		(FAPIRevocationHTTP{Revoker: revoker}).ServeHTTP(w, r)
		return w
	}
	emptyDPoPForm := url.Values{"client_assertion_type": {privateKeyAssertionType}, "client_assertion": {assertion("revoke-http-empty-dpop")}, "token": {"unknown-token"}}
	emptyDPoPRequest := httptest.NewRequest(http.MethodPost, p.Assertions.Issuer+"/revoke", strings.NewReader(emptyDPoPForm.Encode()))
	emptyDPoPRequest.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	emptyDPoPRequest.Header.Set("DPoP", "")
	emptyDPoPResponse := httptest.NewRecorder()
	(FAPIRevocationHTTP{Revoker: revoker}).ServeHTTP(emptyDPoPResponse, emptyDPoPRequest)
	if emptyDPoPResponse.Code != 400 || !strings.Contains(emptyDPoPResponse.Body.String(), "invalid_dpop_proof") {
		t.Fatal("empty DPoP header treated as absent")
	}
	unauthorizedForm := url.Values{"client_id": {client}, "client_assertion_type": {privateKeyAssertionType}, "client_assertion": {"invalid"}, "token": {"unknown-token"}}
	unauthorizedRequest := httptest.NewRequest(http.MethodPost, p.Assertions.Issuer+"/revoke", strings.NewReader(unauthorizedForm.Encode()))
	unauthorizedRequest.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	unauthorized := httptest.NewRecorder()
	(FAPIRevocationHTTP{Revoker: revoker}).ServeHTTP(unauthorized, unauthorizedRequest)
	if unauthorized.Code != 400 || !strings.Contains(unauthorized.Body.String(), "invalid_client") {
		t.Fatal("invalid client accepted by revocation HTTP")
	}
	duplicateForm := url.Values{"client_id": {client}, "client_assertion_type": {privateKeyAssertionType}, "client_assertion": {assertion("revoke-http-duplicate")}, "token": {"first", "second"}}
	duplicateRequest := httptest.NewRequest(http.MethodPost, p.Assertions.Issuer+"/revoke", strings.NewReader(duplicateForm.Encode()))
	duplicateRequest.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	duplicate := httptest.NewRecorder()
	(FAPIRevocationHTTP{Revoker: revoker}).ServeHTTP(duplicate, duplicateRequest)
	if duplicate.Code != 400 || !strings.Contains(duplicate.Body.String(), "invalid_request") {
		t.Fatal("duplicate token accepted")
	}
	// A different, fully authenticated upstream client cannot revoke the
	// first client's token and receives the same successful response.
	schemas, err := domain.NewSchemaValidator(configdefaults.DefaultBuiltinSchemaBase)
	if err != nil {
		t.Fatal(err)
	}
	applications := service.NewApplicationService(pool, schemas, secrets.NewRandomSecretGenerator())
	foreignApp, err := applications.CreateOrRevise(ctx, project, []byte(`{"slug":"foreign-resource-client","name":"Foreign client","clients":[{"slug":"web","type":"confidential","grant_types":["authorization_code"],"redirect_uris":["https://other.example/callback"]}]}`))
	if err != nil {
		t.Fatal(err)
	}
	foreignClient := foreignApp.Secrets[0].ClientID
	foreignPublic, foreignKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	if err = p.Assertions.SetKeys(ctx, foreignClient, []jose.JSONWebKey{{Key: foreignPublic, KeyID: "foreign-key", Algorithm: "EdDSA", Use: "sig"}}); err != nil {
		t.Fatal(err)
	}
	foreignSigner, err := jose.NewSigner(jose.SigningKey{Algorithm: jose.EdDSA, Key: &jose.JSONWebKey{Key: foreignKey, KeyID: "foreign-key"}}, nil)
	if err != nil {
		t.Fatal(err)
	}
	foreignAssertion, err := jwt.Signed(foreignSigner).Claims(map[string]any{"iss": foreignClient, "sub": foreignClient, "aud": p.Assertions.Issuer, "jti": "foreign-revoke", "exp": now.Add(time.Minute).Unix()}).Serialize()
	if err != nil {
		t.Fatal(err)
	}
	foreignForm := url.Values{"client_id": {foreignClient}, "client_assertion_type": {privateKeyAssertionType}, "client_assertion": {foreignAssertion}, "token": {customToken.AccessToken}}
	foreignRequest := httptest.NewRequest(http.MethodPost, p.Assertions.Issuer+"/revoke", strings.NewReader(foreignForm.Encode()))
	foreignRequest.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	foreignResponse := httptest.NewRecorder()
	(FAPIRevocationHTTP{Revoker: revoker}).ServeHTTP(foreignResponse, foreignRequest)
	if foreignResponse.Code != 200 || foreignResponse.Body.Len() != 0 {
		t.Fatal("foreign token revocation disclosed token")
	}
	if _, err = customIssuer.AuthorizeResource(ctx, customToken.AccessToken, mkProof(signer, "after-foreign-revoke", customATH), "GET", resourceURL, policy); err != nil {
		t.Fatalf("foreign client revoked token: %v", err)
	}
	noClientForm := url.Values{"client_assertion_type": {privateKeyAssertionType}, "client_assertion": {assertion("revoke-http-no-client")}, "token": {"unknown-token"}}
	noClientRequest := httptest.NewRequest(http.MethodPost, p.Assertions.Issuer+"/revoke", strings.NewReader(noClientForm.Encode()))
	noClientRequest.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	noClientResponse := httptest.NewRecorder()
	(FAPIRevocationHTTP{Revoker: revoker}).ServeHTTP(noClientResponse, noClientRequest)
	if noClientResponse.Code != 200 {
		t.Fatal("verified JWT client authentication without client_id rejected")
	}
	mismatchForm := url.Values{"client_id": {"wrong-client"}, "client_assertion_type": {privateKeyAssertionType}, "client_assertion": {assertion("revoke-http-mismatch")}, "token": {"unknown-token"}}
	mismatchRequest := httptest.NewRequest(http.MethodPost, p.Assertions.Issuer+"/revoke", strings.NewReader(mismatchForm.Encode()))
	mismatchRequest.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	mismatchResponse := httptest.NewRecorder()
	(FAPIRevocationHTTP{Revoker: revoker}).ServeHTTP(mismatchResponse, mismatchRequest)
	if mismatchResponse.Code != 400 || !strings.Contains(mismatchResponse.Body.String(), "invalid_client") {
		t.Fatal("conflicting revocation client_id accepted")
	}
	if w := httpRevoke("unknown-token", "revoke-http-unknown", "future-hint"); w.Code != 200 || w.Body.Len() != 0 || w.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("unknown token HTTP status=%d", w.Code)
	}
	if w := httpRevoke(customToken.AccessToken, "revoke-http-access", "access_token"); w.Code != 200 || w.Body.Len() != 0 {
		t.Fatalf("access HTTP status=%d", w.Code)
	}
	if _, err = customIssuer.AuthorizeResource(ctx, customToken.AccessToken, mkProof(signer, "resource-after-http-revoke", customATH), "GET", resourceURL, policy); !errors.Is(err, ErrInvalidAccess) {
		t.Fatalf("HTTP-revoked access accepted: %v", err)
	}
	if w := httpRevoke(emptyResponse.RefreshToken, "revoke-http-refresh", "refresh_token"); w.Code != 200 || w.Body.Len() != 0 {
		t.Fatalf("refresh HTTP status=%d", w.Code)
	}
	if err = p.Store.Transaction(func() error {
		_, e := p.Grants.RefreshInTransaction(ctx, emptyResponse.RefreshToken, client, jkt)
		return e
	}); !errors.Is(err, ErrInvalidRefresh) {
		t.Fatalf("HTTP-revoked refresh accepted: %v", err)
	}
	restoredPolicy, err := p.Policies.Put(ctx, client, client, []string{"payments.read"}, true, policyVersion.Version)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = issuer.ValidateResource(ctx, originalAccess, mkProof(signer, "old-access-after-regrant", ath), "GET", resourceURL, client); !errors.Is(err, ErrInvalidAccess) {
		t.Fatal("old access revived after policy reset")
	}
	var renewed []byte
	if err = p.Store.Transaction(func() error {
		var e error
		renewed, e = issuer.Mint(ctx, FAPIExchangeGrant{ProjectID: project, ClientID: client, UserID: user, SessionID: session, Scope: "openid", Nonce: "renewed", DPoPJKT: jkt, PolicyVersion: restoredPolicy.Version})
		return e
	}); err != nil {
		t.Fatal(err)
	}
	var renewedToken fapiAccessResponse
	if err = json.Unmarshal(renewed, &renewedToken); err != nil {
		t.Fatal(err)
	}
	response.AccessToken = renewedToken.AccessToken
	tokenHash = sha256.Sum256([]byte(response.AccessToken))
	ath = base64.RawURLEncoding.EncodeToString(tokenHash[:])

	failRevoke = true
	rq := FAPIRevokeRequest{ClientID: client, AssertionType: privateKeyAssertionType, Assertion: assertion("fapi-revoke-assertion"), Proof: revokeProof(signer, "fapi-revoke-proof", response.AccessToken), Token: response.AccessToken}
	wrongRq := rq
	wrongRq.Assertion = assertion("fapi-revoke-wrong-key-assertion")
	wrongRq.Proof = revokeProof(wrongSigner, "fapi-revoke-wrong-key-proof", response.AccessToken)
	if err = revoker.RevokeAccess(ctx, wrongRq); err != nil {
		t.Fatalf("wrong-key nondisclosure: %v", err)
	}
	if err = db.QueryRow(`SELECT COUNT(*) FROM mapi_fapi_revoked_access WHERE project_id=? AND token_hash=?`, project, tokenHash[:]).Scan(&count); err != nil || count != 0 {
		t.Fatal("wrong key revoked token")
	}

	if err = revoker.RevokeAccess(ctx, rq); err == nil {
		t.Fatal("failed revocation audit committed")
	}
	if err = db.QueryRow(`SELECT COUNT(*) FROM mapi_fapi_revoked_access WHERE project_id=? AND token_hash=?`, project, tokenHash[:]).Scan(&count); err != nil || count != 0 {
		t.Fatal("revocation rollback persisted")
	}
	if _, err = issuer.ValidateResource(ctx, response.AccessToken, mkProof(signer, "revocation-rollback", ath), "GET", resourceURL, client); err != nil {
		t.Fatalf("failed revocation denied resource: %v", err)
	}
	failRevoke = false
	if err = revoker.RevokeAccess(ctx, rq); err != nil {
		t.Fatalf("valid revocation retry: %v", err)
	}
	if _, err = issuer.ValidateResource(ctx, response.AccessToken, mkProof(signer, "revoked-token", ath), "GET", resourceURL, client); !errors.Is(err, ErrInvalidAccess) {
		t.Fatalf("revoked token accepted: %v", err)
	}
	if err = revoker.RevokeAccess(ctx, rq); !errors.Is(err, ErrInvalidClient) {
		t.Fatalf("assertion replay accepted: %v", err)
	}
	replay := rq
	replay.Assertion = assertion("fapi-revoke-assertion-2")
	if err = revoker.RevokeAccess(ctx, replay); !errors.Is(err, ErrInvalidDPoP) {
		t.Fatalf("revocation proof replay accepted: %v", err)
	}
	replay.Proof = revokeProof(signer, "fapi-revoke-proof-2", response.AccessToken)
	if err = revoker.RevokeAccess(ctx, replay); err != nil {
		t.Fatalf("idempotent revocation: %v", err)
	}
	if err = db.QueryRow(`SELECT COUNT(*) FROM events WHERE project_id=? AND event_type=? AND entity_type=?`, project, string(domain.EventTypeAuthTokenRevoked), "fapi_access_token").Scan(&count); err != nil || count != 2 {
		t.Fatalf("revocation audit count=%d err=%v", count, err)
	}
	unknown := FAPIRevokeRequest{ClientID: client, AssertionType: privateKeyAssertionType, Assertion: assertion("fapi-revoke-unknown"), Proof: revokeProof(signer, "fapi-revoke-unknown", "unknown-token"), Token: "unknown-token"}
	if err = revoker.RevokeAccess(ctx, unknown); err != nil {
		t.Fatalf("unknown token revocation: %v", err)
	}
	if _, err = db.Exec(`DELETE FROM sessions WHERE project_id=? AND id=?`, project, session); err != nil {
		t.Fatal(err)
	}
	if _, err = issuer.ValidateIDToken(ctx, originalID, client, grant.Nonce, originalAccess); err == nil {
		t.Fatal("revoked ID token session accepted")
	}
	if _, err = issuer.ValidateResource(ctx, response.AccessToken, mkProof(signer, "revoked-session", ath), "GET", resourceURL, client); err == nil {
		t.Fatal("revoked session accepted")
	}
}
