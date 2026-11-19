package mapioauth

import (
	"context"

	"github.com/go-jose/go-jose/v4"
	"github.com/go-jose/go-jose/v4/jwt"
)

// IDHint validates the issuer's signed ID token for logout binding. The caller
// must separately validate the current browser's session cookie and compare
// both the subject and session ID before allowing any logout mutation.
func (i TokenIssuer) IDHint(ctx context.Context, token string) (AccessIdentity, error) {
	if err := i.validateConfig(); err != nil {
		return AccessIdentity{}, err
	}
	if len(token) == 0 || len(token) > 16384 {
		return AccessIdentity{}, ErrInvalidAccess
	}
	parsed, err := jwt.ParseSigned(token, []jose.SignatureAlgorithm{jose.RS256})
	if err != nil || len(parsed.Headers) != 1 || parsed.Headers[0].KeyID == "" || parsed.Headers[0].ExtraHeaders["typ"] != "JWT" {
		return AccessIdentity{}, ErrInvalidAccess
	}
	keys, err := i.Keys.PublicKeys(ctx)
	if err != nil {
		return AccessIdentity{}, err
	}
	key := keys.Key(parsed.Headers[0].KeyID)
	if len(key) != 1 {
		return AccessIdentity{}, ErrInvalidAccess
	}
	var claims tokenClaims
	if err := parsed.Claims(key[0].Key, &claims); err != nil {
		return AccessIdentity{}, ErrInvalidAccess
	}
	now := i.Store.Now()
	if claims.Subject == "" || claims.SessionID == "" || len(claims.Audience) != 1 || claims.Audience[0] == "" || claims.Expiry == nil || claims.IssuedAt == nil {
		return AccessIdentity{}, ErrInvalidAccess
	}
	client := claims.Audience[0]
	if err := claims.ValidateWithLeeway(jwt.Expected{Issuer: i.Issuer, AnyAudience: jwt.Audience{client}, Time: now}, 0); err != nil || !claims.Expiry.Time().After(now) || claims.IssuedAt.Time().After(now) {
		return AccessIdentity{}, ErrInvalidAccess
	}
	return AccessIdentity{Subject: claims.Subject, ClientID: client, SessionID: claims.SessionID}, nil
}
