package mapioauth

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"net/url"
	"strings"
	"time"

	"github.com/go-jose/go-jose/v4"
	"github.com/go-jose/go-jose/v4/jwt"
	"github.com/zitadel/nextgen/internal/domain"
	"github.com/zitadel/oidc/v3/pkg/oidc"
)

// SessionReader must read authoritative transaction-scoped Nextgen state.
type SessionReader interface {
	GetSessionByID(context.Context, string, string) (*domain.Session, error)
}

// TokenIssuer signs short-lived project-scoped JWTs. Mint methods must be
// called inside the Store transaction with transaction-scoped session and
// audit statements; an offline verifier cannot see immediate session revocation.
type TokenIssuer struct {
	Issuer          string
	Keys            SigningKeys
	Sessions        SessionReader
	Store           Store
	Lifetime        time.Duration
	RefreshLifetime time.Duration
	AuditMint       func(context.Context, string, string, string, string) error
}

type tokenClaims struct {
	jwt.Claims
	SessionID       string           `json:"sid"`
	Scope           string           `json:"scope,omitempty"`
	Nonce           string           `json:"nonce,omitempty"`
	AuthTime        *jwt.NumericDate `json:"auth_time,omitempty"`
	AccessTokenHash string           `json:"at_hash,omitempty"`
	ClientID        string           `json:"client_id,omitempty"`
	ClientEpoch     int64            `json:"mapi_client_epoch,omitempty"`
}

func (i TokenIssuer) validateConfig() error {
	issuer, err := url.Parse(i.Issuer)
	if err != nil || issuer.Scheme != "https" || issuer.Host == "" || issuer.User != nil || issuer.RawQuery != "" || issuer.Fragment != "" || i.Keys.ProjectID == "" || i.Store.Now == nil || i.Sessions == nil || i.AuditMint == nil || i.Lifetime <= 0 || i.Lifetime > time.Hour || i.RefreshLifetime <= 0 {
		return errors.New("token issuer not configured")
	}
	return nil
}
func (i TokenIssuer) session(ctx context.Context, project, user, id string) (*domain.Session, time.Time, error) {
	if project != i.Keys.ProjectID || user == "" || id == "" {
		return nil, time.Time{}, ErrInvalidCode
	}
	s, err := i.Sessions.GetSessionByID(ctx, project, id)
	if err != nil {
		return nil, time.Time{}, ErrInvalidCode
	}
	now := i.Store.Now()
	if s == nil || s.ProjectID != project || s.ID != id || s.UserID == nil || *s.UserID != user || !s.ExpiresAt.After(now) {
		return nil, time.Time{}, ErrInvalidCode
	}
	var last time.Time
	for _, factor := range s.Factors {
		if factor == nil || !factor.Type().IsCredential() {
			continue
		}
		v := factor.GetLastVerifiedAt()
		if !v.IsZero() && !v.After(now) && v.After(last) {
			last = v
		}
	}
	if last.IsZero() {
		return nil, time.Time{}, ErrInvalidCode
	}
	return s, last, nil
}
func randomID() (string, error) {
	var id [32]byte
	if _, err := rand.Read(id[:]); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(id[:]), nil
}
func (i TokenIssuer) mint(ctx context.Context, project, client, user, sessionID, scope, nonce string, issueID bool) (*oidc.AccessTokenResponse, error) {
	if err := i.validateConfig(); err != nil {
		return nil, err
	}
	if client == "" || !strings.Contains(" "+scope+" ", " openid ") {
		return nil, ErrInvalidCode
	}
	session, authTime, err := i.session(ctx, project, user, sessionID)
	if err != nil {
		return nil, err
	}
	now := i.Store.Now().UTC().Truncate(time.Second)
	expiry := now.Add(i.Lifetime)
	if expiry.After(session.ExpiresAt) {
		expiry = session.ExpiresAt.UTC().Truncate(time.Second)
	}
	if !expiry.After(now) {
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
	epoch, err := i.Store.clientEpoch(ctx, project, client)
	if err != nil {
		return nil, err
	}
	accessClaims := tokenClaims{Claims: jwt.Claims{Issuer: i.Issuer, Subject: user, Audience: jwt.Audience{client}, IssuedAt: jwt.NewNumericDate(now), Expiry: jwt.NewNumericDate(expiry), ID: id}, SessionID: sessionID, Scope: scope, ClientID: client, ClientEpoch: epoch}
	access, err := jwt.Signed(signer).Claims(accessClaims).Serialize()
	if err != nil {
		return nil, err
	}
	result := &oidc.AccessTokenResponse{AccessToken: access, TokenType: "Bearer", ExpiresIn: uint64(expiry.Sub(now).Seconds()), Scope: strings.Fields(scope)}
	if issueID {
		signer, err = i.Keys.signer(ctx, "JWT")
		if err != nil {
			return nil, err
		}
		hash := sha256.Sum256([]byte(access))
		idClaims := tokenClaims{Claims: jwt.Claims{Issuer: i.Issuer, Subject: user, Audience: jwt.Audience{client}, IssuedAt: jwt.NewNumericDate(now), Expiry: jwt.NewNumericDate(expiry)}, SessionID: sessionID, Nonce: nonce, AuthTime: jwt.NewNumericDate(authTime), AccessTokenHash: base64.RawURLEncoding.EncodeToString(hash[:len(hash)/2])}
		result.IDToken, err = jwt.Signed(signer).Claims(idClaims).Serialize()
		if err != nil {
			return nil, err
		}
	}
	if err = i.AuditMint(ctx, project, user, sessionID, id); err != nil {
		return nil, err
	}
	return result, nil
}

// MintCodeTokens is usable as Provider.MintCodeTokens after assigning the
// authoritative session/audit dependencies. It must execute inside Consume.
func (i TokenIssuer) MintCodeTokens(ctx context.Context, g AuthorizationCode) (*oidc.AccessTokenResponse, error) {
	result, err := i.mint(ctx, g.ProjectID, g.ClientID, g.UserID, g.SessionID, g.Scope, g.Nonce, true)
	if err != nil {
		return nil, err
	}
	if strings.Contains(" "+g.Scope+" ", " offline_access ") {
		session, _, err := i.session(ctx, g.ProjectID, g.UserID, g.SessionID)
		if err != nil {
			return nil, err
		}
		expiry := i.Store.Now().Add(i.RefreshLifetime)
		if expiry.After(session.ExpiresAt) {
			expiry = session.ExpiresAt
		}
		result.RefreshToken, err = i.Store.IssueRefresh(ctx, RefreshGrant{ProjectID: g.ProjectID, ClientID: g.ClientID, UserID: g.UserID, SessionID: g.SessionID, Scope: g.Scope, ExpiresAt: expiry})
		if err != nil {
			return nil, err
		}
	}
	return result, nil
}
func (i TokenIssuer) MintRefreshTokens(ctx context.Context, g RefreshGrant) (*oidc.AccessTokenResponse, error) {
	return i.mint(ctx, g.ProjectID, g.ClientID, g.UserID, g.SessionID, g.Scope, "", false)
}

// AccessIdentity is returned only after signature, scope, revocation and live
// session checks. It contains no bearer credentials.
type AccessIdentity struct{ Subject, ClientID, SessionID, Scope string }

var ErrInvalidAccess = errors.New("invalid access token")

// CreateSchema belongs in the project object's versioned migration.
func (i TokenIssuer) CreateSchema(ctx context.Context) error {
	if i.Store.DB == nil {
		return errors.New("token store not configured")
	}
	_, err := i.Store.DB.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS mapi_oauth_revoked_access (
  project_id TEXT NOT NULL, token_hash BLOB NOT NULL, expires_at INTEGER NOT NULL,
  PRIMARY KEY(project_id, token_hash))`)
	if err != nil {
		return err
	}
	_, err = i.Store.DB.ExecContext(ctx, `CREATE INDEX IF NOT EXISTS mapi_oauth_revoked_access_expiry ON mapi_oauth_revoked_access(project_id, expires_at)`)
	return err
}

// signedAccess validates the signature and static claims. It does not check
// the live session or revocation, allowing revocation even after session expiry.
func (i TokenIssuer) signedAccess(ctx context.Context, token, audience string) (tokenClaims, error) {
	var claims tokenClaims
	if err := i.validateConfig(); err != nil {
		return claims, err
	}
	if len(token) > 16384 {
		return claims, ErrInvalidAccess
	}
	parsed, err := jwt.ParseSigned(token, []jose.SignatureAlgorithm{jose.RS256})
	if err != nil || len(parsed.Headers) != 1 || parsed.Headers[0].KeyID == "" || parsed.Headers[0].ExtraHeaders["typ"] != "at+jwt" {
		return claims, ErrInvalidAccess
	}
	keys, err := i.Keys.PublicKeys(ctx)
	if err != nil {
		return claims, err
	}
	matching := keys.Key(parsed.Headers[0].KeyID)
	if len(matching) != 1 {
		return claims, ErrInvalidAccess
	}
	if err = parsed.Claims(matching[0].Key, &claims); err != nil {
		return claims, ErrInvalidAccess
	}
	if audience == "" {
		audience = claims.ClientID
	}
	now := i.Store.Now()
	if audience == "" || claims.Expiry == nil || claims.IssuedAt == nil || claims.Subject == "" || claims.ID == "" || claims.SessionID == "" || claims.ClientID != audience || len(claims.Audience) != 1 || claims.Audience[0] != audience || !strings.Contains(" "+claims.Scope+" ", " openid ") {
		return claims, ErrInvalidAccess
	}
	if err = claims.ValidateWithLeeway(jwt.Expected{Issuer: i.Issuer, AnyAudience: jwt.Audience{audience}, Time: now}, 0); err != nil || !claims.Expiry.Time().After(now) || claims.IssuedAt.Time().After(now) {
		return claims, ErrInvalidAccess
	}
	return claims, nil
}

// Access validates signature, exact audience, revocation, expiry and the live
// upstream session. Empty audience derives it from the authenticated JWT.
func (i TokenIssuer) Access(ctx context.Context, token, audience string) (AccessIdentity, error) {
	claims, err := i.signedAccess(ctx, token, audience)
	if err != nil {
		return AccessIdentity{}, err
	}
	hash := sha256.Sum256([]byte(token))
	var count int
	if err := i.Store.DB.QueryRowContext(ctx, `SELECT count(*) FROM mapi_oauth_revoked_access WHERE project_id=? AND token_hash=?`, i.Keys.ProjectID, hash[:]).Scan(&count); err != nil {
		return AccessIdentity{}, err
	}
	if count != 0 {
		return AccessIdentity{}, ErrInvalidAccess
	}
	epoch, err := i.Store.clientEpoch(ctx, i.Keys.ProjectID, claims.ClientID)
	if err != nil {
		return AccessIdentity{}, err
	}
	if epoch != claims.ClientEpoch {
		return AccessIdentity{}, ErrInvalidAccess
	}
	if _, _, err = i.session(ctx, i.Keys.ProjectID, claims.Subject, claims.SessionID); err != nil {
		return AccessIdentity{}, ErrInvalidAccess
	}
	return AccessIdentity{Subject: claims.Subject, ClientID: claims.ClientID, SessionID: claims.SessionID, Scope: claims.Scope}, nil
}

func (i TokenIssuer) ValidateAccess(ctx context.Context, token, audience string) error {
	_, err := i.Access(ctx, token, audience)
	return err
}

// RevokeAccess verifies project and client bindings and records only a token
// hash, in the same transaction as client authentication and the audit event.
// Unknown, expired and already revoked tokens are intentionally idempotent.
func (i TokenIssuer) RevokeAccess(ctx context.Context, token, clientID string, authenticate func(context.Context) error, audit func(context.Context, AccessIdentity) error) error {
	if i.Store.Transaction == nil || authenticate == nil || audit == nil || clientID == "" {
		return errors.New("access revocation not configured")
	}
	return i.Store.Transaction(func() error {
		if err := authenticate(ctx); err != nil {
			return err
		}
		claims, err := i.signedAccess(ctx, token, clientID)
		if errors.Is(err, ErrInvalidAccess) {
			return nil
		}
		if err != nil {
			return err
		}
		hash := sha256.Sum256([]byte(token))
		result, err := i.Store.DB.ExecContext(ctx, `INSERT OR IGNORE INTO mapi_oauth_revoked_access(project_id,token_hash,expires_at) VALUES(?,?,?)`, i.Keys.ProjectID, hash[:], claims.Expiry.Time().Unix())
		if err != nil {
			return err
		}
		count, err := result.RowsAffected()
		if err != nil || count == 0 {
			return err
		}
		return audit(ctx, AccessIdentity{Subject: claims.Subject, ClientID: claims.ClientID, SessionID: claims.SessionID, Scope: claims.Scope})
	})
}
