package mapioauth

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"strings"
	"time"

	"github.com/go-jose/go-jose/v4"
	"github.com/go-jose/go-jose/v4/jwt"
)

var ErrInvalidIDToken = errors.New("invalid ID token")

type fapiIDClaims struct {
	jwt.Claims
	SessionID       string           `json:"sid"`
	Nonce           string           `json:"nonce,omitempty"`
	AuthTime        *jwt.NumericDate `json:"auth_time"`
	AccessTokenHash string           `json:"at_hash"`
}

// mintID is called only inside the code exchange's authoritative transaction;
// refresh responses deliberately omit ID tokens. The nonce, when present,
// comes from the authenticated PAR/login/code chain rather than the browser.
func (i FAPIAccessIssuer) mintID(ctx context.Context, g FAPIExchangeGrant, access string, now, end, authTime time.Time) (string, error) {
	authTime = authTime.UTC().Truncate(time.Second)
	if g.FromRefresh || access == "" || authTime.IsZero() || authTime.After(now) || i.AuditIDToken == nil {
		return "", ErrInvalidCode
	}
	signer, err := i.Keys.signer(ctx, "JWT")
	if err != nil {
		return "", err
	}
	id, err := randomID()
	if err != nil {
		return "", err
	}
	hash := sha256.Sum256([]byte(access))
	claims := fapiIDClaims{Claims: jwt.Claims{Issuer: i.Private.Assertions.Issuer, Subject: g.UserID, Audience: jwt.Audience{g.ClientID}, IssuedAt: jwt.NewNumericDate(now), Expiry: jwt.NewNumericDate(end), ID: id}, SessionID: g.SessionID, Nonce: g.Nonce, AuthTime: jwt.NewNumericDate(authTime), AccessTokenHash: base64.RawURLEncoding.EncodeToString(hash[:len(hash)/2])}
	token, err := jwt.Signed(signer).Claims(claims).Serialize()
	if err != nil {
		return "", err
	}
	if err = i.AuditIDToken(ctx, g, id); err != nil {
		return "", err
	}
	return token, nil
}

// ValidateIDToken provides an optional authoritative check for the private
// profile; an independent relying party can instead verify the public ES256
// keys and standard OIDC claims itself. expectedClient and expectedNonce must
// come from the relying party's own request state. The access token supplied
// must be the one returned alongside this ID token.
func (i FAPIAccessIssuer) ValidateIDToken(ctx context.Context, token, expectedClient, expectedNonce, accessToken string) (AccessIdentity, error) {
	if !i.valid() {
		return AccessIdentity{}, errors.New("FAPI issuer not configured")
	}
	var identity AccessIdentity
	err := i.Private.Store.Transaction(func() error {
		if len(token) > 16384 || expectedClient == "" || accessToken == "" || len(accessToken) > 16384 {
			return ErrInvalidIDToken
		}
		parts := strings.Split(token, ".")
		if len(parts) != 3 {
			return ErrInvalidIDToken
		}
		raw, err := base64.RawURLEncoding.DecodeString(parts[1])
		if err != nil {
			return ErrInvalidIDToken
		}
		if _, err = strictObject(raw); err != nil {
			return ErrInvalidIDToken
		}
		parsed, err := jwt.ParseSigned(token, []jose.SignatureAlgorithm{jose.ES256})
		if err != nil || len(parsed.Headers) != 1 || parsed.Headers[0].KeyID == "" || parsed.Headers[0].ExtraHeaders["typ"] != "JWT" {
			return ErrInvalidIDToken
		}
		keys, err := i.Keys.PublicKeys(ctx)
		if err != nil {
			return err
		}
		matching := keys.Key(parsed.Headers[0].KeyID)
		if len(matching) != 1 || matching[0].Algorithm != "ES256" {
			return ErrInvalidIDToken
		}
		var claims fapiIDClaims
		if err = parsed.Claims(matching[0].Key, &claims); err != nil {
			return ErrInvalidIDToken
		}
		now := i.Private.Store.Now()
		if now.IsZero() || claims.Expiry == nil || claims.IssuedAt == nil || claims.AuthTime == nil || claims.Subject == "" || claims.SessionID == "" || claims.ID == "" || len(claims.Audience) != 1 || claims.Audience[0] != expectedClient || subtle.ConstantTimeCompare([]byte(claims.Nonce), []byte(expectedNonce)) != 1 {
			return ErrInvalidIDToken
		}
		hash := sha256.Sum256([]byte(accessToken))
		expectedHash := base64.RawURLEncoding.EncodeToString(hash[:len(hash)/2])
		if subtle.ConstantTimeCompare([]byte(claims.AccessTokenHash), []byte(expectedHash)) != 1 {
			return ErrInvalidIDToken
		}
		if err = claims.ValidateWithLeeway(jwt.Expected{Issuer: i.Private.Assertions.Issuer, AnyAudience: jwt.Audience{expectedClient}, Time: now}, 0); err != nil || !claims.Expiry.Time().After(now) || claims.IssuedAt.Time().After(now) || claims.AuthTime.Time().After(claims.IssuedAt.Time()) || claims.Expiry.Time().After(claims.IssuedAt.Time().Add(i.Lifetime)) {
			return ErrInvalidIDToken
		}
		if err = i.client(ctx, expectedClient); err != nil {
			return ErrInvalidIDToken
		}
		reader := TokenIssuer{Keys: SigningKeys{ProjectID: i.Keys.ProjectID}, Sessions: i.Sessions, Store: i.Private.Store}
		_, verified, err := reader.session(ctx, i.Keys.ProjectID, claims.Subject, claims.SessionID)
		if err != nil || claims.AuthTime.Time().After(verified) {
			return ErrInvalidIDToken
		}
		identity = AccessIdentity{Subject: claims.Subject, ClientID: expectedClient, SessionID: claims.SessionID}
		return nil
	})
	if err != nil {
		return AccessIdentity{}, err
	}
	return identity, nil
}
