package mapioauth

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"errors"
	"net/http"
	"net/url"
	"strings"
	"time"
)

const parPrefix = "urn:ietf:params:oauth:request_uri:"

var (
	ErrInvalidPAR  = errors.New("invalid pushed authorization request")
	ErrInvalidDPoP = errors.New("invalid DPoP proof or binding")
)

// PushedAuthorizationRequest contains only authorization parameters. Client
// assertions and DPoP proof JWTs must never be persisted in this record.
type PushedAuthorizationRequest struct {
	ProjectID, ClientID, RedirectURI, Scope, State, Nonce, CodeChallenge, DPoPJKT string
}

// PARStore is a private FAPI-oriented building block. All hooks must use the
// same authoritative transaction/connection as Store. Authenticate must
// verify a private_key_jwt including issuer audience and assertion replay.
// VerifyDPoP receives the authenticated client ID and must validate proof
// signature, htm/htu/time/replay and RFC 9449
// section 10.1 binding rules; it returns the verified thumbprint, or empty only
// when both proof and dpop_jkt are absent. A form-supplied thumbprint is never
// accepted as a substitute for that callback. CheckClient revalidates the
// current client, redirect and scope both when pushing and consuming. Audit
// must write an audit record in the current transaction without storing secrets.
// These hooks have no defaults; this component must not be mounted until real
// implementations and complete FAPI conformance testing exist.
type PARStore struct {
	Store               Store
	ProjectID, Endpoint string
	TTL                 time.Duration
	Authenticate        func(context.Context, *http.Request, url.Values) (string, error)
	VerifyDPoP          func(context.Context, string, string, string, string) (string, error)
	CheckClient         func(context.Context, string, string, string, string) error
	Audit               func(context.Context, string, PushedAuthorizationRequest) error
}

func (p PARStore) configured() bool {
	u, err := url.Parse(p.Endpoint)
	return err == nil && u.Scheme == "https" && u.Host != "" && u.User == nil && u.RawQuery == "" && u.Fragment == "" && u.Path != "" && p.ProjectID != "" && p.Store.DB != nil && p.Store.Transaction != nil && p.Store.Now != nil && p.TTL >= time.Second && p.TTL < 600*time.Second && p.TTL%time.Second == 0 && p.Authenticate != nil && p.VerifyDPoP != nil && p.CheckClient != nil && p.Audit != nil
}

// CreatePARSchema belongs in a versioned migration, not the request path.
func (p PARStore) CreatePARSchema(ctx context.Context) error {
	if p.Store.DB == nil {
		return errors.New("PAR database not configured")
	}
	_, err := p.Store.DB.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS mapi_oauth_par (
		handle_hash BLOB PRIMARY KEY, project_id TEXT NOT NULL, client_id TEXT NOT NULL,
		redirect_uri TEXT NOT NULL, scope TEXT NOT NULL, state TEXT NOT NULL, nonce TEXT NOT NULL,
		code_challenge TEXT NOT NULL, dpop_jkt TEXT NOT NULL, expires_at INTEGER NOT NULL
	)`)
	return err
}

// Push performs client authentication, request validation, DPoP binding and
// persistence in one transaction. r.Form is already parsed and bounded by the
// HTTP adapter; callbacks must not retain or log assertion or proof values.
func (p PARStore) Push(ctx context.Context, r *http.Request, form url.Values) (string, error) {
	if !p.configured() {
		return "", errors.New("PAR not configured")
	}
	if r == nil || form == nil || r.Method != http.MethodPost || r.URL == nil {
		return "", ErrInvalidPAR
	}
	endpoint, _ := url.Parse(p.Endpoint)
	if r.Host != endpoint.Host || r.URL.Path != endpoint.Path || r.URL.RawQuery != "" || (r.TLS == nil && r.URL.Scheme != "https") {
		return "", ErrInvalidPAR
	}
	allowed := map[string]bool{"client_id": true, "client_assertion_type": true, "client_assertion": true, "response_type": true, "redirect_uri": true, "scope": true, "state": true, "nonce": true, "code_challenge": true, "code_challenge_method": true, "dpop_jkt": true}
	// Unknown OAuth parameters are ignored. Recognized parameters with
	// semantics this narrow profile does not implement are rejected explicitly,
	// rather than silently treating e.g. prompt=none as an interactive request.
	unsupported := map[string]bool{"request_uri": true, "request": true, "client_secret": true, "prompt": true, "max_age": true, "claims": true, "authorization_details": true, "resource": true, "response_mode": true, "login_hint": true, "id_token_hint": true}
	for name, values := range form {
		if len(values) != 1 || (!allowed[name] && unsupported[name]) {
			return "", ErrInvalidPAR
		}
	}
	if r.Header.Get("Authorization") != "" || len(r.Header.Values("DPoP")) > 1 || len(r.Header.Get("DPoP")) > 16384 || form.Get("client_id") == "" || len(form.Get("client_id")) > 512 || form.Get("client_assertion_type") != "urn:ietf:params:oauth:client-assertion-type:jwt-bearer" || form.Get("client_assertion") == "" || len(form.Get("client_assertion")) > 16384 || form.Get("response_type") != "code" || form.Get("redirect_uri") == "" || len(form.Get("redirect_uri")) > 2048 || len(form.Get("state")) > 2048 || len(form.Get("nonce")) > 512 || form.Get("code_challenge_method") != "S256" || !validChallenge(form.Get("code_challenge")) {
		return "", ErrInvalidPAR
	}
	if _, err := safeAuthorizationRedirect(CompletedLogin{RedirectURI: form.Get("redirect_uri"), Code: "validation"}); err != nil {
		return "", ErrInvalidPAR
	}
	scope := CanonicalLoginScope(strings.Fields(form.Get("scope")))
	if scope != "openid" && scope != "openid offline_access" {
		return "", ErrInvalidPAR
	}
	requestedJKT := form.Get("dpop_jkt")
	if requestedJKT != "" && !validLoginSecret(requestedJKT) {
		return "", ErrInvalidDPoP
	}
	handle, err := randomLoginSecret()
	if err != nil {
		return "", err
	}
	hash := sha256.Sum256([]byte(handle))
	request := PushedAuthorizationRequest{ProjectID: p.ProjectID, ClientID: form.Get("client_id"), RedirectURI: form.Get("redirect_uri"), Scope: scope, State: form.Get("state"), Nonce: form.Get("nonce"), CodeChallenge: form.Get("code_challenge")}
	err = p.Store.Transaction(func() error {
		clientID, err := p.Authenticate(ctx, r, form)
		if err != nil {
			return err
		}
		if clientID != request.ClientID {
			return ErrInvalidClient
		}
		if err := p.CheckClient(ctx, p.ProjectID, clientID, request.RedirectURI, request.Scope); err != nil {
			return err
		}
		binding, err := p.VerifyDPoP(ctx, clientID, r.Header.Get("DPoP"), requestedJKT, p.Endpoint)
		if err != nil {
			return err
		}
		if binding != "" && !validLoginSecret(binding) {
			return ErrInvalidDPoP
		}
		if r.Header.Get("DPoP") == "" && requestedJKT == "" && binding != "" {
			return ErrInvalidDPoP
		}
		if requestedJKT != "" && binding != requestedJKT {
			return ErrInvalidDPoP
		}
		if r.Header.Get("DPoP") != "" && binding == "" {
			return ErrInvalidDPoP
		}
		request.DPoPJKT = binding
		_, err = p.Store.DB.ExecContext(ctx, `INSERT INTO mapi_oauth_par
			(handle_hash,project_id,client_id,redirect_uri,scope,state,nonce,code_challenge,dpop_jkt,expires_at)
			VALUES(?,?,?,?,?,?,?,?,?,?)`, hash[:], request.ProjectID, request.ClientID, request.RedirectURI, request.Scope, request.State, request.Nonce, request.CodeChallenge, request.DPoPJKT, p.Store.Now().Add(p.TTL).UnixMilli())
		if err != nil {
			return err
		}
		return p.Audit(ctx, "pushed", request)
	})
	if err != nil {
		return "", err
	}
	return parPrefix + handle, nil
}

// Consume must be called at authorization, not on a speculative page load.
// begin runs within the same transaction and must persist the resulting login
// transaction without starting a nested transaction. On failure the request
// remains usable and no audit or login state may survive.
func (p PARStore) Consume(ctx context.Context, projectID, clientID, requestURI string, begin func(context.Context, PushedAuthorizationRequest) error) error {
	if !p.configured() || begin == nil {
		return errors.New("PAR not configured")
	}
	if projectID != p.ProjectID || clientID == "" || !strings.HasPrefix(requestURI, parPrefix) {
		return ErrInvalidPAR
	}
	handle := strings.TrimPrefix(requestURI, parPrefix)
	if !validLoginSecret(handle) {
		return ErrInvalidPAR
	}
	hash := sha256.Sum256([]byte(handle))
	return p.Store.Transaction(func() error {
		var request PushedAuthorizationRequest
		var expires int64
		err := p.Store.DB.QueryRowContext(ctx, `SELECT project_id,client_id,redirect_uri,scope,state,nonce,code_challenge,dpop_jkt,expires_at FROM mapi_oauth_par WHERE handle_hash=?`, hash[:]).Scan(&request.ProjectID, &request.ClientID, &request.RedirectURI, &request.Scope, &request.State, &request.Nonce, &request.CodeChallenge, &request.DPoPJKT, &expires)
		if errors.Is(err, sql.ErrNoRows) {
			return ErrInvalidPAR
		}
		if err != nil {
			return err
		}
		if request.ProjectID != projectID || request.ClientID != clientID || !p.Store.Now().Before(time.UnixMilli(expires)) {
			return ErrInvalidPAR
		}
		if err := p.CheckClient(ctx, projectID, clientID, request.RedirectURI, request.Scope); err != nil {
			return err
		}
		result, err := p.Store.DB.ExecContext(ctx, "DELETE FROM mapi_oauth_par WHERE handle_hash=?", hash[:])
		if err != nil {
			return err
		}
		count, err := result.RowsAffected()
		if err != nil || count != 1 {
			return ErrInvalidPAR
		}
		if err := begin(ctx, request); err != nil {
			return err
		}
		return p.Audit(ctx, "consumed", request)
	})
}
