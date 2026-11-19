package mapioauth

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"database/sql"
	"errors"
	"time"
)

// FAPICodeIssuer must write to the same transaction as the login and audit.
type FAPICodeIssuer interface {
	IssueCodeInTransaction(context.Context, AuthorizationCode, string) (string, error)
}

// FAPILogin accepts optional authorization-code DPoP key binding; redemption
// must always verify a fresh proof, matching this key when one was supplied.
// Its isolated state never changes the legacy bearer tables.
// Every callback and Codes must use Store's authoritative DB transaction.
type FAPILogin struct {
	Store         Store
	ProjectID     string
	LoginTTL      time.Duration
	CodeTTL       time.Duration
	Codes         FAPICodeIssuer
	CheckClient   func(context.Context, string, string, string, string) error
	PolicyVersion func(context.Context, string, string, string) (int64, error)
	Session       func(context.Context, string, string) (LoginIdentity, error)
	Audit         func(context.Context, string, AuthorizationCode, string) error
}

func (f FAPILogin) configured() bool {
	return f.Store.DB != nil && f.Store.Transaction != nil && f.Store.Now != nil && f.ProjectID != "" && f.Codes != nil && f.CheckClient != nil && f.PolicyVersion != nil && f.Session != nil && f.Audit != nil && f.LoginTTL >= time.Second && f.LoginTTL <= 10*time.Minute && f.CodeTTL >= time.Second && f.CodeTTL <= time.Minute
}

// CreateSchema belongs in the private FAPI versioned migration.
func (f FAPILogin) CreateSchema(ctx context.Context) error {
	if f.Store.DB == nil {
		return errors.New("FAPI login database not configured")
	}
	_, err := f.Store.DB.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS mapi_fapi_logins (
		handle_hash BLOB PRIMARY KEY, browser_hash BLOB NOT NULL,
		project_id TEXT NOT NULL, client_id TEXT NOT NULL, redirect_uri TEXT NOT NULL,
		scope TEXT NOT NULL, state TEXT NOT NULL, nonce TEXT NOT NULL,
		code_challenge TEXT NOT NULL, dpop_jkt TEXT NOT NULL, expires_at INTEGER NOT NULL
	)`)
	if err != nil {
		return err
	}
	return createFAPIPolicyBindings(ctx, f.Store)
}

// BeginInTransaction is called only from PARStore.Consume's callback. The
// caller sets binding in a Secure, HttpOnly, SameSite=Lax host cookie and only
// exposes handle in the issuer-owned login URL after the outer commit succeeds.
// On any later failure the outer PAR consume rolls back this insert and audit.
func (f FAPILogin) BeginInTransaction(ctx context.Context, request PushedAuthorizationRequest) (handle, binding string, err error) {
	if !f.configured() {
		return "", "", errors.New("FAPI login not configured")
	}
	if request.ProjectID != f.ProjectID || request.ClientID == "" || request.RedirectURI == "" || !validChallenge(request.CodeChallenge) || (request.DPoPJKT != "" && !validLoginSecret(request.DPoPJKT)) {
		return "", "", ErrInvalidLogin
	}
	if request.PolicyVersion <= 0 {
		return "", "", ErrInvalidLogin
	}
	if canonical, err := canonicalFAPIScopes(request.Scope); err != nil || canonical != request.Scope {
		return "", "", ErrInvalidLogin
	}
	if _, err := safeAuthorizationRedirect(CompletedLogin{RedirectURI: request.RedirectURI, Code: "validation"}); err != nil {
		return "", "", ErrInvalidLogin
	}
	if err := f.CheckClient(ctx, request.ProjectID, request.ClientID, request.RedirectURI, request.Scope); err != nil {
		return "", "", err
	}
	current, err := f.PolicyVersion(ctx, request.ProjectID, request.ClientID, request.Scope)
	if err != nil {
		return "", "", err
	}
	if current != request.PolicyVersion {
		return "", "", ErrInvalidLogin
	}
	handle, err = randomLoginSecret()
	if err != nil {
		return "", "", err
	}
	binding, err = randomLoginSecret()
	if err != nil {
		return "", "", err
	}
	handleHash, bindingHash := sha256.Sum256([]byte(handle)), sha256.Sum256([]byte(binding))
	_, err = f.Store.DB.ExecContext(ctx, `INSERT INTO mapi_fapi_logins
		(handle_hash,browser_hash,project_id,client_id,redirect_uri,scope,state,nonce,code_challenge,dpop_jkt,expires_at)
		VALUES(?,?,?,?,?,?,?,?,?,?,?)`, handleHash[:], bindingHash[:], request.ProjectID, request.ClientID, request.RedirectURI, request.Scope,
		request.State, request.Nonce, request.CodeChallenge, request.DPoPJKT, f.Store.Now().Add(f.LoginTTL).UnixMilli())
	if err != nil {
		return "", "", err
	}
	if err = bindFAPIPolicy(ctx, f.Store, "login", handleHash[:], request.ProjectID, request.ClientID, request.PolicyVersion, f.Store.Now().Add(f.LoginTTL)); err != nil {
		return "", "", err
	}
	grant := AuthorizationCode{ProjectID: request.ProjectID, ClientID: request.ClientID, RedirectURI: request.RedirectURI, Scope: request.Scope, Nonce: request.Nonce, CodeChallenge: request.CodeChallenge, PolicyVersion: request.PolicyVersion}
	if err = f.Audit(ctx, "login_started", grant, request.DPoPJKT); err != nil {
		return "", "", err
	}
	return handle, binding, nil
}

// validatedLogin reads authoritative state inside an existing transaction.
// Preview and completion both call it, and completion always repeats the
// checks so a client/session revocation after preview fences code issuance.
func (f FAPILogin) validatedLogin(ctx context.Context, handle, binding, sessionCookie string) (PushedAuthorizationRequest, LoginIdentity, error) {
	handleHash, bindingHash := sha256.Sum256([]byte(handle)), sha256.Sum256([]byte(binding))
	var saved []byte
	var request PushedAuthorizationRequest
	var expiry int64
	err := f.Store.DB.QueryRowContext(ctx, `SELECT browser_hash,project_id,client_id,redirect_uri,scope,state,nonce,code_challenge,dpop_jkt,expires_at FROM mapi_fapi_logins WHERE handle_hash=?`, handleHash[:]).Scan(&saved, &request.ProjectID, &request.ClientID, &request.RedirectURI, &request.Scope, &request.State, &request.Nonce, &request.CodeChallenge, &request.DPoPJKT, &expiry)
	if errors.Is(err, sql.ErrNoRows) {
		return request, LoginIdentity{}, ErrInvalidLogin
	}
	if err != nil {
		return request, LoginIdentity{}, err
	}
	if request.ProjectID != f.ProjectID || len(saved) != len(bindingHash) || subtle.ConstantTimeCompare(saved, bindingHash[:]) != 1 || !f.Store.Now().Before(time.UnixMilli(expiry)) || (request.DPoPJKT != "" && !validLoginSecret(request.DPoPJKT)) {
		return request, LoginIdentity{}, ErrInvalidLogin
	}
	if err := f.CheckClient(ctx, request.ProjectID, request.ClientID, request.RedirectURI, request.Scope); err != nil {
		return request, LoginIdentity{}, err
	}
	request.PolicyVersion, err = getFAPIPolicyBinding(ctx, f.Store, "login", handleHash[:], request.ProjectID, request.ClientID)
	if errors.Is(err, ErrFAPIPolicyDenied) {
		return request, LoginIdentity{}, ErrInvalidLogin
	}
	if err != nil {
		return request, LoginIdentity{}, err
	}
	current, err := f.PolicyVersion(ctx, request.ProjectID, request.ClientID, request.Scope)
	if errors.Is(err, ErrFAPIPolicyDenied) {
		return request, LoginIdentity{}, ErrInvalidLogin
	}
	if err != nil {
		return request, LoginIdentity{}, err
	}
	if current != request.PolicyVersion {
		return request, LoginIdentity{}, ErrInvalidLogin
	}
	identity, err := f.Session(ctx, request.ProjectID, sessionCookie)
	if err != nil || identity.ProjectID != request.ProjectID || identity.UserID == "" || identity.SessionID == "" {
		return request, LoginIdentity{}, ErrInvalidLogin
	}
	return request, identity, nil
}

// RedirectURI validates a live browser binding, session and current client
// without consuming the request. An HTTP adapter may use its returned origin
// to constrain its confirmation page's form-action CSP; it must still call
// Complete on a same-origin, CSRF-protected POST.
func (f FAPILogin) RedirectURI(ctx context.Context, handle, binding, sessionCookie string) (string, error) {
	if !f.configured() || !validLoginSecret(handle) || !validLoginSecret(binding) || sessionCookie == "" || len(sessionCookie) > 8192 {
		return "", ErrInvalidLogin
	}
	var redirect string
	err := f.Store.Transaction(func() error {
		request, _, err := f.validatedLogin(ctx, handle, binding, sessionCookie)
		if err != nil {
			return err
		}
		if canonical, err := canonicalFAPIScopes(request.Scope); err != nil || canonical != request.Scope {
			return ErrInvalidLogin
		}
		if _, err := safeAuthorizationRedirect(CompletedLogin{RedirectURI: request.RedirectURI, Code: "validation"}); err != nil {
			return ErrInvalidLogin
		}
		redirect = request.RedirectURI
		return nil
	})
	if err != nil {
		return "", err
	}
	return redirect, nil
}

// Complete validates the browser binding and authoritative session, consumes
// the login, and issues one DPoP-bound code with its audit in one transaction.
// No browser-supplied user/session identifiers are trusted. A future HTTP
// adapter must enforce exact Origin and session-bound CSRF on its POST, and
// must validate the stored binding before rendering any RP-specific CSP.
func (f FAPILogin) Complete(ctx context.Context, handle, binding, sessionCookie string) (CompletedLogin, error) {
	if !f.configured() {
		return CompletedLogin{}, errors.New("FAPI login not configured")
	}
	if !validLoginSecret(handle) || !validLoginSecret(binding) || sessionCookie == "" || len(sessionCookie) > 8192 {
		return CompletedLogin{}, ErrInvalidLogin
	}
	handleHash := sha256.Sum256([]byte(handle))
	var result CompletedLogin
	err := f.Store.Transaction(func() error {
		request, identity, err := f.validatedLogin(ctx, handle, binding, sessionCookie)
		if err != nil {
			return err
		}
		grant := AuthorizationCode{ProjectID: request.ProjectID, ClientID: request.ClientID, RedirectURI: request.RedirectURI, UserID: identity.UserID, SessionID: identity.SessionID, Scope: request.Scope, Nonce: request.Nonce, CodeChallenge: request.CodeChallenge, ExpiresAt: f.Store.Now().Add(f.CodeTTL), PolicyVersion: request.PolicyVersion}
		var deleted []byte
		err = f.Store.DB.QueryRowContext(ctx, "DELETE FROM mapi_fapi_logins WHERE handle_hash=? RETURNING handle_hash", handleHash[:]).Scan(&deleted)
		if errors.Is(err, sql.ErrNoRows) {
			return ErrInvalidLogin
		}
		if err != nil {
			return err
		}
		if err = deleteFAPIPolicyBinding(ctx, f.Store, "login", handleHash[:]); err != nil {
			return err
		}
		code, err := f.Codes.IssueCodeInTransaction(ctx, grant, request.DPoPJKT)
		if err != nil {
			return err
		}
		if err := f.Audit(ctx, "code_issued", grant, request.DPoPJKT); err != nil {
			return err
		}
		result = CompletedLogin{Code: code, RedirectURI: request.RedirectURI, State: request.State}
		return nil
	})
	if err != nil {
		return CompletedLogin{}, err
	}
	return result, nil
}
