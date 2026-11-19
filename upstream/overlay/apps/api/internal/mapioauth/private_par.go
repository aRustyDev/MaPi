package mapioauth

import (
	"context"
	"database/sql"
	"errors"
	"net/http"
	"slices"
	"strings"
	"time"

	"github.com/zitadel/nextgen/internal/audit"
	"github.com/zitadel/nextgen/internal/domain"
	"github.com/zitadel/nextgen/internal/mapidpop"
	"github.com/zitadel/nextgen/internal/service"
)

// PrivatePARConfig connects the independently tested private_key_jwt, PAR and
// DPoP primitives. It is not a complete FAPI authorization server and must
// not be mounted or advertised. All services and the Store must use the same
// authoritative project transaction. DPoP nonces are stored by project,
// authenticated client and purpose; the untrusted proof cannot select a nonce
// outside that server-established scope.
type PrivatePARConfig struct {
	ProjectID, Issuer string
	Store             Store
	Pool              *service.DB
}

type PrivatePAR struct {
	Assertions ClientAssertions
	PAR        PARStore
	Nonces     mapidpop.NonceStore
	Grants     FAPIGrants
	Policies   FAPIResourcePolicies
	Store      Store
}

// NewPrivatePAR provides private grant storage but no nonce challenge, token
// endpoint, signed sender-constrained tokens or resource-server binding.
// Those are required before any public FAPI profile.
func NewPrivatePAR(c PrivatePARConfig) (*PrivatePAR, error) {
	if c.ProjectID == "" || c.Store.DB == nil || c.Store.Now == nil || c.Store.Transaction == nil || c.Pool == nil {
		return nil, errors.New("private PAR configuration incomplete")
	}
	stmts := c.Pool.Statements()
	registry := ClientRegistry{Statements: stmts}
	policies := FAPIResourcePolicies{Store: c.Store, ProjectID: c.ProjectID, Registry: registry}
	policies.Audit = func(ctx context.Context, policy FAPIClientPolicy) error {
		return audit.Emit(ctx, stmts, audit.EmitSpec{Type: domain.EventType("mapi.fapi.resource_policy.updated"), Category: domain.EventCategoryAdmin, ProjectID: c.ProjectID, EntityType: "oauth_client", EntityID: policy.ClientID, Payload: map[string]any{"audience": policy.Audience, "scopes": policy.Scopes, "enabled": policy.Enabled, "version": policy.Version}})
	}
	assertions := ClientAssertions{ProjectID: c.ProjectID, Issuer: c.Issuer, Store: c.Store, Registry: registry}
	if !assertions.valid() {
		return nil, errors.New("invalid private PAR issuer")
	}
	assertions.AuditKeys = func(ctx context.Context, client string, kids []string) error {
		return audit.Emit(ctx, stmts, audit.EmitSpec{Type: domain.EventType("mapi.fapi.client_keys.changed"), Category: domain.EventCategoryAdmin, ProjectID: c.ProjectID, EntityType: "oauth_client", EntityID: client, Payload: map[string]any{"kids": kids}})
	}
	assertions.AuditAuthentication = func(ctx context.Context, client, kid string) error {
		return audit.Emit(ctx, stmts, audit.EmitSpec{Type: domain.EventType("mapi.fapi.client_assertion.accepted"), Category: domain.EventCategoryAuth, ProjectID: c.ProjectID, EntityType: "oauth_client", EntityID: client, Payload: map[string]string{"kid": kid}})
	}
	nonces := mapidpop.NonceStore{DB: c.Store.DB, Transaction: c.Store.Transaction, Now: c.Store.Now, TTL: time.Minute}
	nonces.Audit = func(ctx context.Context, scope mapidpop.NonceScope) error {
		if err := nonces.Cleanup(ctx, c.ProjectID); err != nil {
			return err
		}
		return audit.Emit(ctx, stmts, audit.EmitSpec{Type: domain.EventType("mapi.fapi.dpop.nonce.issued"), Category: domain.EventCategoryAuth, ProjectID: c.ProjectID, EntityType: "oauth_client", EntityID: scope.ClientID, Payload: map[string]string{"purpose": scope.Purpose}})
	}
	par := PARStore{Store: c.Store, ProjectID: c.ProjectID, Endpoint: c.Issuer + "/par", TTL: time.Minute, Authenticate: assertions.PARAuthenticator()}
	par.CheckClient = func(ctx context.Context, project, clientID, redirect, scope string) error {
		if project != c.ProjectID {
			return ErrInvalidClient
		}
		client, err := registry.Lookup(ctx, project, clientID)
		if err != nil {
			return err
		}
		if !slices.Contains(client.RedirectURIs, redirect) || !slices.Contains(client.GrantTypes, "authorization_code") {
			return ErrInvalidPAR
		}
		if slices.Contains(strings.Fields(scope), "offline_access") && !slices.Contains(client.GrantTypes, "refresh_token") {
			return ErrInvalidClient
		}
		_, err = policies.require(ctx, clientID, scope)
		if errors.Is(err, ErrFAPIPolicyDenied) {
			return ErrInvalidPAR
		}
		return err
	}
	par.PolicyVersion = policies.Version
	par.VerifyDPoP = func(ctx context.Context, clientID, proof, expectedJKT, endpoint string) (string, error) {
		if proof == "" {
			// RFC 9449 permits a client to commit to dpop_jkt at PAR without
			// presenting a proof here. Token exchange must still require a
			// proof and verify it matches any committed thumbprint.
			return expectedJKT, nil
		}
		nonce, err := nonces.ResolveProof(ctx, mapidpop.NonceScope{ProjectID: c.ProjectID, ClientID: clientID, Purpose: "par"}, proof)
		if errors.Is(err, mapidpop.ErrInvalidNonce) {
			return "", newNonceRequired(mapidpop.NonceScope{ProjectID: c.ProjectID, ClientID: clientID, Purpose: "par"})
		}
		if err != nil {
			return "", err
		}
		verified, err := mapidpop.Verify(ctx, []string{proof}, mapidpop.Options{ProjectID: c.ProjectID, Method: http.MethodPost, URL: endpoint, Nonce: nonce, ExpectedThumbprint: expectedJKT, Now: c.Store.Now(), MaxAge: time.Minute, FutureSkew: 10 * time.Second}, mapidpop.SQLReplay{DB: c.Store.DB})
		if errors.Is(err, mapidpop.ErrInvalidProof) {
			return "", ErrInvalidDPoP
		}
		if err != nil {
			return "", err
		}
		return verified.Thumbprint, nil
	}
	par.Audit = func(ctx context.Context, action string, request PushedAuthorizationRequest) error {
		return audit.Emit(ctx, stmts, audit.EmitSpec{Type: domain.EventType("mapi.fapi.par." + action), Category: domain.EventCategoryAuth, ProjectID: c.ProjectID, EntityType: "oauth_client", EntityID: request.ClientID})
	}
	return &PrivatePAR{Assertions: assertions, PAR: par, Nonces: nonces, Grants: FAPIGrants{Store: c.Store, ProjectID: c.ProjectID}, Policies: policies, Store: c.Store}, nil
}

// InitializeSchema installs a private, separate migration marker and all
// state tables atomically. It does not alter the public app schema.
func (p *PrivatePAR) InitializeSchema(ctx context.Context) error {
	if p == nil || p.Store.DB == nil || p.Store.Transaction == nil {
		return errors.New("private PAR not configured")
	}
	return p.Store.Transaction(func() error {
		if _, err := p.Store.DB.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS mapi_private_par_schema (singleton INTEGER PRIMARY KEY CHECK(singleton=1),version INTEGER NOT NULL)`); err != nil {
			return err
		}
		var version int
		err := p.Store.DB.QueryRowContext(ctx, `SELECT version FROM mapi_private_par_schema WHERE singleton=1`).Scan(&version)
		if err == nil {
			if version < 1 || version > 8 {
				return errors.New("unsupported private PAR schema version")
			}
			if version == 8 {
				return nil
			}
			if version == 1 {
				if err := mapidpop.InitNonceSchema(ctx, p.Store.DB); err != nil {
					return err
				}
			}
			if err := p.Grants.CreateSchema(ctx); err != nil {
				return err
			}
			if err := (FAPILogin{Store: p.Store}).CreateSchema(ctx); err != nil {
				return err
			}
			if err := (FAPISigningKeys{Store: p.Store}).CreateSchema(ctx); err != nil {
				return err
			}
			if err := createFAPIRevocationSchema(ctx, p.Store); err != nil {
				return err
			}
			if err := (FAPIResourcePolicies{Store: p.Store}).CreateSchema(ctx); err != nil {
				return err
			}
			if err := createFAPIPolicyBindings(ctx, p.Store); err != nil {
				return err
			}
			if err = createFAPIPromptSchema(ctx, p.Store); err != nil {
				return err
			}
			if err = createFAPIReloadSchema(ctx, p.Store); err != nil {
				return err
			}
			_, err := p.Store.DB.ExecContext(ctx, `UPDATE mapi_private_par_schema SET version=8 WHERE singleton=1 AND version=?`, version)
			return err
		}
		if !errors.Is(err, sql.ErrNoRows) {
			return err
		}
		if err = p.Assertions.CreateSchema(ctx); err != nil {
			return err
		}
		if err = p.PAR.CreatePARSchema(ctx); err != nil {
			return err
		}
		if err = mapidpop.InitReplaySchema(ctx, p.Store.DB); err != nil {
			return err
		}
		if err = mapidpop.InitNonceSchema(ctx, p.Store.DB); err != nil {
			return err
		}
		if err = p.Grants.CreateSchema(ctx); err != nil {
			return err
		}
		if err = (FAPILogin{Store: p.Store}).CreateSchema(ctx); err != nil {
			return err
		}
		if err = (FAPISigningKeys{Store: p.Store}).CreateSchema(ctx); err != nil {
			return err
		}
		if err = createFAPIRevocationSchema(ctx, p.Store); err != nil {
			return err
		}
		if err = (FAPIResourcePolicies{Store: p.Store}).CreateSchema(ctx); err != nil {
			return err
		}
		if err = createFAPIPolicyBindings(ctx, p.Store); err != nil {
			return err
		}
		if err = createFAPIPromptSchema(ctx, p.Store); err != nil {
			return err
		}
		if err = createFAPIReloadSchema(ctx, p.Store); err != nil {
			return err
		}
		_, err = p.Store.DB.ExecContext(ctx, `INSERT INTO mapi_private_par_schema(singleton,version) VALUES(1,8)`)
		return err
	})
}
