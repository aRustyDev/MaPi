package mapioauth

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"

	"github.com/zitadel/nextgen/internal/audit"
	"github.com/zitadel/nextgen/internal/domain"
	"github.com/zitadel/oidc/v3/pkg/oidc"
)

// IsolatedProfiles is an unmounted local experiment. It has distinct issuer
// identifiers, key rings, grant tables and an exclusive client-membership
// registry. It does not provide a public deployment or claim conformance.
type IsolatedProfiles struct {
	Bearer  *Composition
	FAPI    *PrivateFAPI
	Private *PrivatePAR
	Clients IsolatedProfileClients
	// FAPIScopes advertises only scopes configured for the private test deployment.
	// The caller must provision corresponding client policies.
	FAPIScopes []string
}
type IsolatedProfileClients struct {
	Store     Store
	ProjectID string
	Registry  ClientRegistry
	Audit     func(context.Context, string, string) error
}

func (p IsolatedProfileClients) CreateSchema(ctx context.Context) error {
	if p.Store.DB == nil {
		return errors.New("isolated profile database missing")
	}
	_, err := p.Store.DB.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS mapi_isolated_profile_clients (project_id TEXT NOT NULL,client_id TEXT NOT NULL,profile TEXT NOT NULL CHECK(profile IN ('bearer','fapi')),PRIMARY KEY(project_id,client_id))`)
	return err
}

// Assign is idempotent for the same profile and rejects cross-profile reuse.
// The client lookup, assignment and audit run in one project transaction.
func (p IsolatedProfileClients) Assign(ctx context.Context, client, profile string) error {
	if p.Store.DB == nil || p.Store.Transaction == nil || p.ProjectID == "" || p.Registry.Statements == nil || p.Audit == nil || client == "" || (profile != "bearer" && profile != "fapi") {
		return errors.New("invalid isolated profile assignment")
	}
	return p.Store.Transaction(func() error {
		if _, err := p.Registry.Lookup(ctx, p.ProjectID, client); err != nil {
			return err
		}
		var assigned string
		err := p.Store.DB.QueryRowContext(ctx, `INSERT INTO mapi_isolated_profile_clients(project_id,client_id,profile) VALUES(?,?,?) ON CONFLICT DO NOTHING RETURNING profile`, p.ProjectID, client, profile).Scan(&assigned)
		if errors.Is(err, sql.ErrNoRows) {
			if err = p.Store.DB.QueryRowContext(ctx, `SELECT profile FROM mapi_isolated_profile_clients WHERE project_id=? AND client_id=?`, p.ProjectID, client).Scan(&assigned); err != nil {
				return err
			}
			if assigned != profile {
				return ErrInvalidClient
			}
			return nil
		}
		if err != nil {
			return err
		}
		return p.Audit(ctx, client, profile)
	})
}
func (p IsolatedProfileClients) admit(profile string) func(context.Context, string, string) error {
	return func(ctx context.Context, project, client string) error {
		if project != p.ProjectID || client == "" {
			return ErrInvalidClient
		}
		var current string
		err := p.Store.DB.QueryRowContext(ctx, `SELECT profile FROM mapi_isolated_profile_clients WHERE project_id=? AND client_id=?`, project, client).Scan(&current)
		if errors.Is(err, sql.ErrNoRows) {
			return ErrInvalidClient
		}
		if err != nil {
			return err
		}
		if current != profile {
			return ErrInvalidClient
		}
		return nil
	}
}

// ComposeIsolatedProfiles shares only the authoritative Nextgen project and
// sessions; each issuer uses distinct credential admission and token stores.
// InitializeSchema must complete before assigning clients or issuing tokens.
func ComposeIsolatedProfiles(c Config) (*IsolatedProfiles, error) {
	bearer, err := Compose(c)
	if err != nil {
		return nil, err
	}
	private, err := NewPrivatePAR(PrivatePARConfig{ProjectID: c.ProjectID, Issuer: c.Origin + "/fapi/" + c.ProjectID, IssuerProfile: "fapi", Store: c.Store, Pool: c.Pool})
	if err != nil {
		return nil, err
	}
	fapi, err := ComposePrivateFAPI(private, c.Pool, c.Keys)
	if err != nil {
		return nil, err
	}
	if bearer.Issuer == private.Assertions.Issuer {
		return nil, errors.New("issuer profiles collide")
	}
	clients := IsolatedProfileClients{Store: c.Store, ProjectID: c.ProjectID, Registry: ClientRegistry{Statements: c.Pool.Statements()}}
	clients.Audit = func(ctx context.Context, client, profile string) error {
		return audit.Emit(ctx, c.Pool.Statements(), audit.EmitSpec{Type: domain.EventType("mapi.oauth.profile_client.assigned"), Category: domain.EventCategoryAdmin, ProjectID: c.ProjectID, EntityType: "oauth_client", EntityID: client, Payload: map[string]string{"profile": profile}})
	}
	bearer.Provider.Registry.Admit = clients.admit("bearer")
	bearer.Logout.Registry.Admit = clients.admit("bearer")
	oldLoginCheck := bearer.Login.Bridge.CheckClient
	bearer.Login.Bridge.CheckClient = func(ctx context.Context, project, client, redirect, scope string) error {
		if err := clients.admit("bearer")(ctx, project, client); err != nil {
			return err
		}
		return oldLoginCheck(ctx, project, client, redirect, scope)
	}
	bearer.Provider.BeginLogin = bearer.Login.Begin
	oldUserInfo := bearer.Provider.UserInfoToken
	bearer.Provider.UserInfoToken = func(ctx context.Context, token string) (*oidc.UserInfo, error) {
		identity, err := bearer.Tokens.Access(ctx, token, "")
		if err != nil {
			return nil, err
		}
		if err = clients.admit("bearer")(ctx, c.ProjectID, identity.ClientID); err != nil {
			return nil, err
		}
		return oldUserInfo(ctx, token)
	}
	oldRevoke := bearer.Provider.RevokeToken
	bearer.Provider.RevokeToken = func(ctx context.Context, client, secret, token string) error {
		if err := clients.admit("bearer")(ctx, c.ProjectID, client); err != nil {
			return err
		}
		return oldRevoke(ctx, client, secret, token)
	}
	private.Assertions.Registry.Admit = clients.admit("fapi")
	private.Policies.Registry.Admit = clients.admit("fapi")
	private.PAR.Authenticate = private.Assertions.PARAuthenticator()
	oldCheck := private.PAR.CheckClient
	private.PAR.CheckClient = func(ctx context.Context, project, client, redirect, scope string) error {
		if err := clients.admit("fapi")(ctx, project, client); err != nil {
			return err
		}
		return oldCheck(ctx, project, client, redirect, scope)
	}
	fapi.Tokens.Registry.Admit = clients.admit("fapi")
	fapi.Exchange.Mint = fapi.Tokens.Mint
	fapi.Revocation.Issuer = fapi.Tokens
	return &IsolatedProfiles{Bearer: bearer, FAPI: fapi, Private: private, Clients: clients, FAPIScopes: []string{"openid", "offline_access"}}, nil
}
func (p *IsolatedProfiles) InitializeSchema(ctx context.Context) error {
	if p == nil || p.Bearer == nil || p.Private == nil || p.Clients.Store.Transaction == nil {
		return errors.New("isolated profiles incomplete")
	}
	if err := p.Bearer.Admin.InitializeSchema(ctx); err != nil {
		return err
	}
	if err := p.Private.InitializeSchema(ctx); err != nil {
		return err
	}
	return p.Clients.Store.Transaction(func() error { return p.Clients.CreateSchema(ctx) })
}

// FAPIDiscovery returns metadata only in the private local harness; the
// caller must not mount it publicly before protocol and runtime gates pass.
func (p *IsolatedProfiles) FAPIDiscovery(w http.ResponseWriter, r *http.Request) {
	if p == nil || p.Private == nil {
		http.NotFound(w, r)
		return
	}
	issuer := p.Private.Assertions.Issuer
	u, err := url.Parse(issuer)
	if err != nil || r.Method != http.MethodGet || r.Host != u.Host || r.URL.Path != u.Path+"/.well-known/openid-configuration" || r.URL.RawQuery != "" {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{"issuer": issuer, "authorization_endpoint": issuer + "/authorize", "token_endpoint": issuer + "/token", "pushed_authorization_request_endpoint": issuer + "/par", "jwks_uri": issuer + "/jwks", "scopes_supported": p.FAPIScopes, "response_types_supported": []string{"code"}, "grant_types_supported": []string{"authorization_code", "refresh_token"}, "subject_types_supported": []string{"public"}, "id_token_signing_alg_values_supported": []string{"ES256"}, "token_endpoint_auth_methods_supported": []string{"private_key_jwt"}, "token_endpoint_auth_signing_alg_values_supported": []string{"PS256", "ES256", "EdDSA"}, "code_challenge_methods_supported": []string{"S256"}, "require_pushed_authorization_requests": true, "dpop_signing_alg_values_supported": []string{"PS256", "ES256", "EdDSA"}, "authorization_response_iss_parameter_supported": true})
}
