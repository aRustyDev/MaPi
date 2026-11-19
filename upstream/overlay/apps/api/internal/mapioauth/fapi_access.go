package mapioauth

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/url"
	"slices"
	"strings"
	"time"

	"github.com/go-jose/go-jose/v4"
	"github.com/go-jose/go-jose/v4/jwt"
	"github.com/zitadel/nextgen/internal/mapidpop"
)

// FAPIAccessIssuer implements private sender-constrained access tokens and
// ID tokens; it does not supply discovery, public endpoints or conformance.
// All SQL-backed services must share Private.Store's transaction connection.
type FAPIAccessIssuer struct {
	Private                   *PrivatePAR
	Keys                      FAPISigningKeys
	Sessions                  SessionReader
	Registry                  ClientRegistry
	Lifetime, RefreshLifetime time.Duration
	AuditMint                 func(context.Context, FAPIExchangeGrant, string) error
	AuditIDToken              func(context.Context, FAPIExchangeGrant, string) error
	AuditAccess               func(context.Context, AccessIdentity) error
}

type fapiAccessClaims struct {
	jwt.Claims
	ClientID      string `json:"client_id"`
	SessionID     string `json:"sid"`
	Scope         string `json:"scope"`
	PolicyVersion int64  `json:"mapi_policy_version"`
	Confirmation  struct {
		JKT string `json:"jkt"`
	} `json:"cnf"`
}
type fapiAccessResponse struct {
	AccessToken  string `json:"access_token"`
	IDToken      string `json:"id_token,omitempty"`
	TokenType    string `json:"token_type"`
	Scope        string `json:"scope"`
	ExpiresIn    int64  `json:"expires_in"`
	RefreshToken string `json:"refresh_token,omitempty"`
}

func (i FAPIAccessIssuer) valid() bool {
	if i.Private == nil || i.Keys.Store.DB == nil || i.Keys.Keys == nil || i.Sessions == nil || i.Registry.Statements == nil || i.AuditMint == nil || i.AuditIDToken == nil || i.AuditAccess == nil || i.Private.Store.Now == nil || i.Private.Store.Transaction == nil || i.Keys.Store.DB != i.Private.Store.DB || i.Keys.ProjectID == "" || i.Keys.ProjectID != i.Private.Assertions.ProjectID || i.Private.Grants.ProjectID != i.Keys.ProjectID || i.Lifetime <= 0 || i.Lifetime > time.Hour || i.RefreshLifetime <= 0 || i.RefreshLifetime > 30*24*time.Hour {
		return false
	}
	issuer, e := url.Parse(i.Private.Assertions.Issuer)
	return e == nil && issuer.Scheme == "https" && issuer.Host != "" && issuer.User == nil && issuer.RawQuery == "" && issuer.Fragment == "" && issuer.Path == "/oauth/"+i.Keys.ProjectID
}

func (i FAPIAccessIssuer) session(ctx context.Context, project, user, session string) (time.Time, error) {
	reader := TokenIssuer{Keys: SigningKeys{ProjectID: i.Keys.ProjectID}, Sessions: i.Sessions, Store: i.Private.Store}
	state, _, err := reader.session(ctx, project, user, session)
	if err != nil {
		return time.Time{}, err
	}
	return state.ExpiresAt, nil
}
func (i FAPIAccessIssuer) client(ctx context.Context, id string) error {
	client, err := i.Registry.Lookup(ctx, i.Keys.ProjectID, id)
	if err != nil {
		return err
	}
	if !slices.Contains(client.GrantTypes, "authorization_code") {
		return ErrInvalidClient
	}
	var n int
	if err = i.Private.Store.DB.QueryRowContext(ctx, `SELECT COUNT(*) FROM mapi_oauth_client_assertion_keys WHERE project_id=? AND client_id=? AND active=1`, i.Keys.ProjectID, id).Scan(&n); err != nil {
		return err
	}
	if n == 0 {
		return ErrInvalidClient
	}
	return nil
}

// Mint is called within the exchange's authoritative transaction. On the
// first offline_access exchange it also stores a bound, non-rotating refresh
// grant. Session validation and both audit writes commit with consumption.
func (i FAPIAccessIssuer) Mint(ctx context.Context, g FAPIExchangeGrant) ([]byte, error) {
	if !i.valid() {
		return nil, errors.New("FAPI access issuer not configured")
	}
	if g.ProjectID != i.Keys.ProjectID || g.ClientID == "" || g.UserID == "" || g.SessionID == "" || !validLoginSecret(g.DPoPJKT) || (!g.FromRefresh && !strings.Contains(" "+g.Scope+" ", " openid ")) {
		return nil, ErrInvalidCode
	}
	if err := i.client(ctx, g.ClientID); err != nil {
		return nil, err
	}
	policy, err := i.Private.Policies.require(ctx, g.ClientID, g.Scope)
	if err != nil {
		return nil, err
	}
	if g.PolicyVersion <= 0 || g.PolicyVersion != policy.Version {
		if g.FromRefresh {
			return nil, ErrInvalidRefresh
		}
		return nil, ErrInvalidCode
	}
	reader := TokenIssuer{Keys: SigningKeys{ProjectID: i.Keys.ProjectID}, Sessions: i.Sessions, Store: i.Private.Store}
	session, authTime, err := reader.session(ctx, g.ProjectID, g.UserID, g.SessionID)
	if err != nil {
		return nil, err
	}
	sessionEnd := session.ExpiresAt
	now := i.Private.Store.Now().UTC().Truncate(time.Second)
	if now.IsZero() {
		return nil, ErrInvalidCode
	}
	end := now.Add(i.Lifetime)
	if end.After(sessionEnd) {
		end = sessionEnd.UTC().Truncate(time.Second)
	}
	if !end.After(now) {
		return nil, ErrInvalidCode
	}
	id, err := randomID()
	if err != nil {
		return nil, err
	}
	signer, err := i.Keys.signer(ctx, "at+jwt")
	if err != nil {
		return nil, err
	}
	audience := policy.Audience
	claims := fapiAccessClaims{Claims: jwt.Claims{Issuer: i.Private.Assertions.Issuer, Subject: g.UserID, Audience: jwt.Audience{audience}, IssuedAt: jwt.NewNumericDate(now), Expiry: jwt.NewNumericDate(end), ID: id}, ClientID: g.ClientID, SessionID: g.SessionID, Scope: g.Scope, PolicyVersion: policy.Version}
	claims.Confirmation.JKT = g.DPoPJKT
	token, err := jwt.Signed(signer).Claims(claims).Serialize()
	if err != nil {
		return nil, err
	}
	response := fapiAccessResponse{AccessToken: token, TokenType: "DPoP", Scope: g.Scope, ExpiresIn: int64(end.Sub(now).Seconds())}
	if !g.FromRefresh {
		response.IDToken, err = i.mintID(ctx, g, token, now, end, authTime)
		if err != nil {
			return nil, err
		}
	}
	if !g.FromRefresh && strings.Contains(" "+g.Scope+" ", " offline_access ") {
		client, err := i.Registry.Lookup(ctx, i.Keys.ProjectID, g.ClientID)
		if err != nil {
			return nil, err
		}
		if !slices.Contains(client.GrantTypes, "refresh_token") {
			return nil, ErrInvalidClient
		}
		expiry := now.Add(i.RefreshLifetime)
		if expiry.After(sessionEnd) {
			expiry = sessionEnd
		}
		response.RefreshToken, err = i.Private.Grants.IssueRefreshInTransaction(ctx, FAPIRefresh{RefreshGrant: RefreshGrant{ProjectID: g.ProjectID, ClientID: g.ClientID, UserID: g.UserID, SessionID: g.SessionID, Scope: g.Scope, ExpiresAt: expiry}, DPoPJKT: g.DPoPJKT, PolicyVersion: policy.Version})
		if err != nil {
			return nil, err
		}
	}
	if err = i.AuditMint(ctx, g, id); err != nil {
		return nil, err
	}
	return json.Marshal(response)
}

// ValidateResource verifies a signed access token against authoritative state
// and the proof's ath and JKT in one project transaction. Method, URL and
// audience must be derived by the resource server from trusted routing, never
// arbitrary forwarded headers. Caller must not use this as offline validation.
// ValidateResource checks token authenticity only; resource servers must use
// AuthorizeResource to enforce configured audience, clients and scopes.
func (i FAPIAccessIssuer) ValidateResource(ctx context.Context, token, proof, method, resourceURL, audience string) (AccessIdentity, error) {
	return i.validateResource(ctx, token, proof, method, resourceURL, audience, nil)
}

// FAPIResourcePolicy must be selected by trusted resource routing, never by
// caller-supplied parameters. All required scopes and one listed client must match.
type FAPIResourcePolicy struct {
	Audience       string
	AllowedClients []string
	RequiredScopes []string
}

var ErrInsufficientScope = errors.New("insufficient resource scope")

func (i FAPIAccessIssuer) AuthorizeResource(ctx context.Context, token, proof, method, resourceURL string, policy FAPIResourcePolicy) (AccessIdentity, error) {
	if policy.Audience == "" || len(policy.AllowedClients) == 0 || len(policy.RequiredScopes) == 0 {
		return AccessIdentity{}, errors.New("resource policy incomplete")
	}
	for _, v := range policy.AllowedClients {
		if v == "" {
			return AccessIdentity{}, errors.New("resource policy incomplete")
		}
	}
	for _, v := range policy.RequiredScopes {
		if !validFAPIScopeToken(v) {
			return AccessIdentity{}, errors.New("invalid resource scope policy")
		}
	}
	return i.validateResource(ctx, token, proof, method, resourceURL, policy.Audience, &policy)
}

func (i FAPIAccessIssuer) validateResource(ctx context.Context, token, proof, method, resourceURL, audience string, policy *FAPIResourcePolicy) (AccessIdentity, error) {
	if !i.valid() {
		return AccessIdentity{}, errors.New("FAPI access issuer not configured")
	}
	if audience == "" {
		return AccessIdentity{}, ErrInvalidAccess
	}
	var identity AccessIdentity
	err := i.Private.Store.Transaction(func() error {
		if proof == "" {
			return ErrInvalidAccess
		}
		claims, err := i.signedAccess(ctx, token, audience)
		if err != nil {
			return err
		}
		hash := sha256.Sum256([]byte(token))
		var revoked int
		if err = i.Private.Store.DB.QueryRowContext(ctx, `SELECT COUNT(*) FROM mapi_fapi_revoked_access WHERE project_id=? AND token_hash=?`, i.Keys.ProjectID, hash[:]).Scan(&revoked); err != nil {
			return err
		}
		if revoked != 0 {
			return ErrInvalidAccess
		}
		now := i.Private.Store.Now()
		if err = i.client(ctx, claims.ClientID); err != nil {
			return ErrInvalidAccess
		}
		currentPolicy, err := i.Private.Policies.require(ctx, claims.ClientID, claims.Scope)
		if errors.Is(err, ErrFAPIPolicyDenied) {
			return ErrInvalidAccess
		}
		if err != nil {
			return err
		}
		if claims.PolicyVersion <= 0 || currentPolicy.Version != claims.PolicyVersion || currentPolicy.Audience != claims.Audience[0] {
			return ErrInvalidAccess
		}
		if _, err = i.session(ctx, i.Keys.ProjectID, claims.Subject, claims.SessionID); err != nil {
			return ErrInvalidAccess
		}
		nonce, err := i.Private.Nonces.ResolveProof(ctx, mapidpop.NonceScope{ProjectID: i.Keys.ProjectID, ClientID: claims.ClientID, Purpose: "resource"}, proof)
		if errors.Is(err, mapidpop.ErrInvalidNonce) {
			return newNonceRequired(mapidpop.NonceScope{ProjectID: i.Keys.ProjectID, ClientID: claims.ClientID, Purpose: "resource"})
		}
		if err != nil {
			return err
		}
		_, err = mapidpop.Verify(ctx, []string{proof}, mapidpop.Options{ProjectID: i.Keys.ProjectID, Method: method, URL: resourceURL, Nonce: nonce, AccessToken: token, ExpectedThumbprint: claims.Confirmation.JKT, Now: now, MaxAge: time.Minute, FutureSkew: 10 * time.Second}, mapidpop.SQLReplay{DB: i.Private.Store.DB})
		if errors.Is(err, mapidpop.ErrInvalidProof) {
			return ErrInvalidDPoP
		}
		if err != nil {
			return err
		}
		if policy != nil {
			if !slices.Contains(policy.AllowedClients, claims.ClientID) {
				return ErrInsufficientScope
			}
			scopes := strings.Fields(claims.Scope)
			for _, required := range policy.RequiredScopes {
				if !slices.Contains(scopes, required) {
					return ErrInsufficientScope
				}
			}
		}
		identity = AccessIdentity{Subject: claims.Subject, ClientID: claims.ClientID, SessionID: claims.SessionID, Scope: claims.Scope}
		return i.AuditAccess(ctx, identity)
	})
	if err != nil {
		return AccessIdentity{}, err
	}
	return identity, nil
}

// signedAccess verifies signature and project/client claims without consulting live session or revocation.
func (i FAPIAccessIssuer) signedAccess(ctx context.Context, token, audience string) (fapiAccessClaims, error) {
	if len(token) > 16384 {
		return fapiAccessClaims{}, ErrInvalidAccess
	}
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return fapiAccessClaims{}, ErrInvalidAccess
	}
	raw, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return fapiAccessClaims{}, ErrInvalidAccess
	}
	payload, err := strictObject(raw)
	if err != nil {
		return fapiAccessClaims{}, ErrInvalidAccess
	}
	confirmation, err := strictObject(payload["cnf"])
	if err != nil || len(confirmation) != 1 || confirmation["jkt"] == nil {
		return fapiAccessClaims{}, ErrInvalidAccess
	}
	parsed, err := jwt.ParseSigned(token, []jose.SignatureAlgorithm{jose.ES256})
	if err != nil || len(parsed.Headers) != 1 || parsed.Headers[0].KeyID == "" || parsed.Headers[0].ExtraHeaders["typ"] != "at+jwt" {
		return fapiAccessClaims{}, ErrInvalidAccess
	}
	keys, err := i.Keys.PublicKeys(ctx)
	if err != nil {
		return fapiAccessClaims{}, err
	}
	matching := keys.Key(parsed.Headers[0].KeyID)
	if len(matching) != 1 || matching[0].Algorithm != "ES256" {
		return fapiAccessClaims{}, ErrInvalidAccess
	}
	var claims fapiAccessClaims
	if err = parsed.Claims(matching[0].Key, &claims); err != nil {
		return fapiAccessClaims{}, ErrInvalidAccess
	}
	now := i.Private.Store.Now()
	if now.IsZero() || claims.Expiry == nil || claims.IssuedAt == nil || claims.Subject == "" || claims.ID == "" || claims.SessionID == "" || claims.ClientID == "" || len(claims.Audience) != 1 || claims.Audience[0] == "" || (audience != "" && claims.Audience[0] != audience) || !validLoginSecret(claims.Confirmation.JKT) {
		return fapiAccessClaims{}, ErrInvalidAccess
	}
	expected := jwt.Expected{Issuer: i.Private.Assertions.Issuer, Time: now}
	if audience != "" {
		expected.AnyAudience = jwt.Audience{audience}
	}
	if canonical, scopeErr := canonicalFAPIRefreshScopes(claims.Scope); scopeErr != nil || canonical != claims.Scope {
		return fapiAccessClaims{}, ErrInvalidAccess
	}
	if err = claims.ValidateWithLeeway(expected, 0); err != nil || !claims.Expiry.Time().After(now) || claims.IssuedAt.Time().After(now) {
		return fapiAccessClaims{}, ErrInvalidAccess
	}
	return claims, nil
}
