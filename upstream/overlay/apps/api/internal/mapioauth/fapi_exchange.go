package mapioauth

import (
	"context"
	"errors"
	"net/http"
	"slices"
	"time"

	"github.com/zitadel/nextgen/internal/mapidpop"
)

// FAPIExchange is an unmounted transaction primitive, not an HTTP token
// endpoint. Both callbacks and Mint must use the same database transaction as
// Private.Store and must not perform external calls. Mint must eventually
// produce an independently verified signed access token with cnf.jkt and a
// DPoP token type. No such signer is supplied here, so this is not a provider.
// The eventual HTTP adapter must strictly validate single form/header values.
type FAPIExchange struct {
	Private      *PrivatePAR
	CheckSession func(context.Context, string, string, string) error
	Mint         func(context.Context, FAPIExchangeGrant) ([]byte, error)
	Audit        func(context.Context, FAPIExchangeGrant) error
}

type FAPIExchangeGrant struct {
	ProjectID, ClientID, UserID, SessionID, Scope, Nonce, DPoPJKT string
	FromRefresh                                                   bool
	PolicyVersion                                                 int64
}

type FAPIExchangeRequest struct {
	ClientID, AssertionType, Assertion, Proof string
	Code, RedirectURI, Verifier, RefreshToken string
}

func (x FAPIExchange) exchange(ctx context.Context, req FAPIExchangeRequest, refresh bool) ([]byte, error) {
	if x.Private == nil || x.Private.Store.DB == nil || x.Private.Store.Transaction == nil || x.Private.Store.Now == nil || x.CheckSession == nil || x.Mint == nil || x.Audit == nil {
		return nil, errors.New("private FAPI exchange not configured")
	}
	p := x.Private
	if p.Assertions.ProjectID == "" || p.Grants.ProjectID != p.Assertions.ProjectID || p.PAR.Endpoint != p.Assertions.Issuer+"/par" || p.Grants.Store.DB != p.Store.DB || p.Assertions.Store.DB != p.Store.DB || p.Nonces.DB != p.Store.DB || req.ClientID == "" || req.Proof == "" {
		return nil, ErrInvalidDPoP
	}
	endpoint := p.Assertions.Issuer + "/token"
	var committed []byte
	err := p.Store.Transaction(func() error {
		client, err := p.Assertions.AuthenticateInTransaction(ctx, req.ClientID, req.AssertionType, req.Assertion)
		if err != nil {
			return err
		}
		grantType := "authorization_code"
		if refresh {
			grantType = "refresh_token"
		}
		if !slices.Contains(client.GrantTypes, grantType) {
			return ErrInvalidClient
		}
		nonce, err := p.Nonces.ResolveProof(ctx, mapidpop.NonceScope{ProjectID: p.Grants.ProjectID, ClientID: req.ClientID, Purpose: "token"}, req.Proof)
		if errors.Is(err, mapidpop.ErrInvalidNonce) {
			return newNonceRequired(mapidpop.NonceScope{ProjectID: p.Grants.ProjectID, ClientID: req.ClientID, Purpose: "token"})
		}
		if err != nil {
			return err
		}
		proof, err := mapidpop.Verify(ctx, []string{req.Proof}, mapidpop.Options{ProjectID: p.Grants.ProjectID, Method: http.MethodPost, URL: endpoint, Nonce: nonce, Now: p.Store.Now(), MaxAge: time.Minute, FutureSkew: 10 * time.Second}, mapidpop.SQLReplay{DB: p.Store.DB})
		if errors.Is(err, mapidpop.ErrInvalidProof) {
			return ErrInvalidDPoP
		}
		if err != nil {
			return err
		}
		var g FAPIExchangeGrant
		if refresh {
			v, err := p.Grants.RefreshInTransaction(ctx, req.RefreshToken, req.ClientID, proof.Thumbprint)
			if err != nil {
				return err
			}
			g = FAPIExchangeGrant{ProjectID: v.ProjectID, ClientID: v.ClientID, UserID: v.UserID, SessionID: v.SessionID, Scope: v.Scope, DPoPJKT: v.DPoPJKT, FromRefresh: true, PolicyVersion: v.PolicyVersion}
		} else {
			v, err := p.Grants.ConsumeCodeInTransaction(ctx, req.Code, req.ClientID, req.RedirectURI, req.Verifier, proof.Thumbprint)
			if err != nil {
				return err
			}
			g = FAPIExchangeGrant{ProjectID: v.ProjectID, ClientID: v.ClientID, UserID: v.UserID, SessionID: v.SessionID, Scope: v.Scope, Nonce: v.Nonce, DPoPJKT: v.DPoPJKT, PolicyVersion: v.PolicyVersion}
		}
		policy, err := p.Policies.require(ctx, g.ClientID, g.Scope)
		if errors.Is(err, ErrFAPIPolicyDenied) {
			if refresh {
				return ErrInvalidRefresh
			}
			return ErrInvalidCode
		}
		if err != nil {
			return err
		}
		if g.PolicyVersion <= 0 || policy.Version != g.PolicyVersion {
			if refresh {
				return ErrInvalidRefresh
			}
			return ErrInvalidCode
		}
		if err := x.CheckSession(ctx, g.ProjectID, g.UserID, g.SessionID); err != nil {
			return err
		}
		result, err := x.Mint(ctx, g)
		if err != nil {
			return err
		}
		if len(result) == 0 {
			return errors.New("empty private FAPI mint result")
		}
		if err = x.Audit(ctx, g); err != nil {
			return err
		}
		committed = result
		return nil
	})
	if err != nil {
		return nil, err
	}
	return committed, nil
}

// ExchangeCode authenticates the client, verifies a fresh token-endpoint DPoP
// proof, consumes the PKCE-bound code and commits session, mint and audit work
// atomically. The result is returned only after successful commit.
func (x FAPIExchange) ExchangeCode(ctx context.Context, req FAPIExchangeRequest) ([]byte, error) {
	return x.exchange(ctx, req, false)
}

// ExchangeRefresh verifies a fresh proof bound to the non-rotating grant and
// repeats session, mint and audit checks in the same transaction.
func (x FAPIExchange) ExchangeRefresh(ctx context.Context, req FAPIExchangeRequest) ([]byte, error) {
	return x.exchange(ctx, req, true)
}
