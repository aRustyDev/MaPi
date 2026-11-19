package mapioauth

import (
	"context"
	"crypto/rsa"
	"errors"
	"net/http"
	"net/url"
	"slices"
	"strings"
	"time"

	"github.com/go-jose/go-jose/v4"
	"github.com/zitadel/oidc/v3/pkg/oidc"
	"github.com/zitadel/oidc/v3/pkg/op"
)

// Provider is an experimental project-bound adapter to upstream's OAuth HTTP
// machinery. Do not mount it until callbacks use authoritative project state
// and durable login flows. Discovery is intentionally absent: userinfo,
// revocation and RP logout are not implemented. Callbacks during Consume and
// RotateRefresh must use the same transaction as Store and write audit records.
type Provider struct {
	op.UnimplementedServer
	ProjectID   string
	LoginOrigin string
	Registry    ClientRegistry
	Store       Store
	// BeginLogin must bind the validated request to a durable authenticated
	// browser flow and redirect only to an issuer-owned login URL.
	BeginLogin func(context.Context, *op.ClientRequest[oidc.AuthRequest]) (*op.Redirect, error)
	PublicKeys func(context.Context) (jose.JSONWebKeySet, error)
	// MintCodeTokens checks the live session and creates signed tokens and audit
	// records in the current transaction; refresh issuance is the callback's job.
	MintCodeTokens func(context.Context, AuthorizationCode) (*oidc.AccessTokenResponse, error)
	// MintRefreshTokens checks the live session and audits within the transaction;
	// it must not create a refresh token: the rotation store supplies the new one.
	MintRefreshTokens func(context.Context, RefreshGrant) (*oidc.AccessTokenResponse, error)
	AuditReuse        func(context.Context, RefreshGrant) error
}

// Handler mounts implemented paths only. Callers must route to the object for
// this provider's project and enforce issuer-origin admission.
func (p *Provider) Handler() http.Handler {
	return op.RegisterServer(p, op.Endpoints{Authorization: op.NewEndpoint("/authorize"), Token: op.NewEndpoint("/token"), JwksURI: op.NewEndpoint("/jwks")})
}

func (p *Provider) Keys(ctx context.Context, _ *op.Request[struct{}]) (*op.Response, error) {
	if p.PublicKeys == nil {
		return nil, oidc.ErrServerError()
	}
	keys, err := p.PublicKeys(ctx)
	if err != nil {
		return nil, oidc.ErrServerError().WithParent(err)
	}
	if len(keys.Keys) == 0 {
		return nil, oidc.ErrServerError()
	}
	for _, key := range keys.Keys {
		pub, ok := key.Key.(*rsa.PublicKey)
		if !ok || pub.N == nil || pub.N.BitLen() < 2048 || !key.Valid() || !key.IsPublic() || key.KeyID == "" || key.Use != "sig" || key.Algorithm != "RS256" {
			return nil, oidc.ErrServerError()
		}
	}
	return op.NewResponse(keys), nil
}

func (p *Provider) VerifyAuthRequest(ctx context.Context, r *op.Request[oidc.AuthRequest]) (*op.ClientRequest[oidc.AuthRequest], error) {
	c, err := p.Registry.Lookup(ctx, p.ProjectID, r.Data.ClientID)
	if errors.Is(err, ErrInvalidClient) {
		return nil, oidc.ErrInvalidClient()
	}
	if err != nil {
		return nil, oidc.ErrServerError().WithParent(err)
	}
	return &op.ClientRequest[oidc.AuthRequest]{Request: r, Client: providerClient{Client: c}}, nil
}

func (p *Provider) Authorize(ctx context.Context, r *op.ClientRequest[oidc.AuthRequest]) (*op.Redirect, error) {
	a := r.Data
	allowed := map[string]bool{"client_id": true, "redirect_uri": true, "response_type": true, "scope": true, "state": true, "nonce": true, "response_mode": true, "code_challenge": true, "code_challenge_method": true, "request": true}
	for key, values := range r.Form {
		if !allowed[key] || len(values) != 1 {
			return nil, oidc.ErrInvalidRequest()
		}
	}
	if a.ResponseMode != "" && a.ResponseMode != oidc.ResponseModeQuery {
		return nil, oidc.ErrInvalidRequest()
	}
	if a.RequestParam != "" {
		return nil, oidc.ErrRequestNotSupported()
	}
	if a.ResponseType != oidc.ResponseTypeCode || a.CodeChallengeMethod != oidc.CodeChallengeMethodS256 || !validChallenge(a.CodeChallenge) || !slices.Contains(a.Scopes, "openid") || len(a.Scopes) > 2 || (len(a.Scopes) == 2 && !slices.Contains(a.Scopes, "offline_access")) {
		return nil, oidc.ErrInvalidRequest()
	}
	client, err := p.Registry.Authorize(ctx, p.ProjectID, a.ClientID, a.RedirectURI)
	if err != nil {
		if errors.Is(err, ErrInvalidClient) {
			return nil, oidc.ErrInvalidRequestRedirectURI()
		}
		return nil, oidc.ErrServerError().WithParent(err)
	}
	if slices.Contains(a.Scopes, "offline_access") && !slices.Contains(client.GrantTypes, "refresh_token") {
		return nil, oidc.ErrInvalidRequest()
	}
	if p.BeginLogin == nil {
		return nil, oidc.ErrServerError()
	}
	redirect, err := p.BeginLogin(ctx, r)
	if err != nil {
		return nil, oidc.ErrServerError().WithParent(err)
	}
	if redirect == nil {
		return nil, oidc.ErrServerError()
	}
	origin, originErr := url.Parse(p.LoginOrigin)
	login, loginErr := url.Parse(redirect.URL)
	if originErr != nil || loginErr != nil || origin.Scheme != "https" || origin.Host == "" || origin.User != nil || origin.Path != "" || origin.RawQuery != "" || origin.Fragment != "" || login.Scheme != origin.Scheme || login.Host != origin.Host || login.User != nil {
		return nil, oidc.ErrServerError()
	}
	return redirect, nil
}

func (p *Provider) VerifyClient(ctx context.Context, r *op.Request[op.ClientCredentials]) (op.Client, error) {
	grant := r.Form.Get("grant_type")
	if r.Data.ClientAssertion != "" || r.Data.ClientAssertionType != "" {
		return nil, oidc.ErrInvalidClient()
	}
	c, err := p.Registry.Authenticate(ctx, p.ProjectID, r.Data.ClientID, r.Data.ClientSecret, grant)
	if errors.Is(err, ErrInvalidClient) {
		return nil, oidc.ErrInvalidClient()
	}
	if err != nil {
		return nil, oidc.ErrServerError().WithParent(err)
	}
	return providerClient{Client: c, secret: r.Data.ClientSecret}, nil
}

func (p *Provider) CodeExchange(ctx context.Context, r *op.ClientRequest[oidc.AccessTokenRequest]) (*op.Response, error) {
	c, ok := r.Client.(providerClient)
	if !ok || p.MintCodeTokens == nil {
		return nil, oidc.ErrServerError()
	}
	var tokens *oidc.AccessTokenResponse
	err := p.Store.Consume(ctx, r.Data.Code, p.ProjectID, c.ClientID, r.Data.RedirectURI, r.Data.CodeVerifier, func(ctx context.Context, g AuthorizationCode) error {
		if _, err := p.Registry.Authenticate(ctx, p.ProjectID, c.ClientID, c.secret, "authorization_code"); err != nil {
			return err
		}
		client, err := p.Registry.Authorize(ctx, p.ProjectID, c.ClientID, g.RedirectURI)
		if err != nil {
			return err
		}
		if slices.Contains(strings.Fields(g.Scope), "offline_access") && !slices.Contains(client.GrantTypes, "refresh_token") {
			return ErrInvalidClient
		}
		tokens, err = p.MintCodeTokens(ctx, g)
		if err != nil {
			return err
		}
		if tokens == nil || tokens.AccessToken == "" || tokens.IDToken == "" || tokens.TokenType != "Bearer" || (slices.Contains(strings.Fields(g.Scope), "offline_access") != (tokens.RefreshToken != "")) {
			return errors.New("incomplete token response")
		}
		return nil
	})
	if errors.Is(err, ErrInvalidCode) || errors.Is(err, ErrInvalidClient) {
		return nil, oidc.ErrInvalidGrant()
	}
	if err != nil {
		return nil, oidc.ErrServerError().WithParent(err)
	}
	return op.NewResponse(tokens), nil
}

func (p *Provider) RefreshToken(ctx context.Context, r *op.ClientRequest[oidc.RefreshTokenRequest]) (*op.Response, error) {
	c, ok := r.Client.(providerClient)
	if !ok || p.MintRefreshTokens == nil || p.AuditReuse == nil {
		return nil, oidc.ErrServerError()
	}
	if len(r.Data.Scopes) > 0 {
		return nil, oidc.ErrInvalidRequest()
	}
	var tokens *oidc.AccessTokenResponse
	next, err := p.Store.RotateRefresh(ctx, r.Data.RefreshToken, p.ProjectID, c.ClientID, func(ctx context.Context, g RefreshGrant) error {
		if _, err := p.Registry.Authenticate(ctx, p.ProjectID, c.ClientID, c.secret, "refresh_token"); err != nil {
			return err
		}
		var err error
		tokens, err = p.MintRefreshTokens(ctx, g)
		if err != nil {
			return err
		}
		if tokens == nil || tokens.AccessToken == "" || tokens.TokenType != "Bearer" || tokens.RefreshToken != "" {
			return errors.New("incomplete token response")
		}
		return nil
	}, func(ctx context.Context, g RefreshGrant) error {
		if _, err := p.Registry.Authenticate(ctx, p.ProjectID, c.ClientID, c.secret, "refresh_token"); err != nil {
			return err
		}
		return p.AuditReuse(ctx, g)
	})
	if errors.Is(err, ErrInvalidRefresh) || errors.Is(err, ErrRefreshReuse) || errors.Is(err, ErrInvalidClient) || errors.Is(err, ErrInvalidCode) {
		return nil, oidc.ErrInvalidGrant()
	}
	if err != nil {
		return nil, oidc.ErrServerError().WithParent(err)
	}
	tokens.RefreshToken = next
	return op.NewResponse(tokens), nil
}

type providerClient struct {
	Client
	secret string
}

func (c providerClient) GetID() string                     { return c.ClientID }
func (c providerClient) RedirectURIs() []string            { return slices.Clone(c.Client.RedirectURIs) }
func (providerClient) PostLogoutRedirectURIs() []string    { return nil }
func (providerClient) ApplicationType() op.ApplicationType { return op.ApplicationTypeWeb }
func (providerClient) AuthMethod() oidc.AuthMethod         { return oidc.AuthMethodBasic }
func (providerClient) ResponseTypes() []oidc.ResponseType {
	return []oidc.ResponseType{oidc.ResponseTypeCode}
}
func (c providerClient) GrantTypes() []oidc.GrantType {
	var out []oidc.GrantType
	for _, g := range c.Client.GrantTypes {
		out = append(out, oidc.GrantType(g))
	}
	return out
}
func (providerClient) LoginURL(string) string                                       { return "" }
func (providerClient) AccessTokenType() op.AccessTokenType                          { return op.AccessTokenTypeJWT }
func (providerClient) IDTokenLifetime() time.Duration                               { return 5 * time.Minute }
func (providerClient) DevMode() bool                                                { return false }
func (providerClient) RestrictAdditionalIdTokenScopes() func([]string) []string     { return nil }
func (providerClient) RestrictAdditionalAccessTokenScopes() func([]string) []string { return nil }
func (providerClient) IsScopeAllowed(s string) bool                                 { return s == "openid" || s == "offline_access" }
func (providerClient) IDTokenUserinfoClaimsAssertion() bool                         { return false }
func (providerClient) ClockSkew() time.Duration                                     { return 0 }
