package mapioauth

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"database/sql"
	"encoding/base64"
	"errors"
	"strings"
	"time"
)

var ErrInvalidLogin = errors.New("invalid or expired authorization login")

// LoginIdentity must come from an authoritative validation of the browser's
// Nextgen session credential in the same transaction as code issuance.
type LoginIdentity struct{ ProjectID, UserID, SessionID string }

// LoginBridge is a persistence primitive, not an HTTP endpoint. The adapter
// must set a separate random browser binding as a Secure, HttpOnly, SameSite=Lax
// cookie on the authorize response. It must neither log nor put that binding
// in a URL. The handle can be placed in the issuer-owned login URL. Both are
// one-time secrets and only their hashes are stored.
//
// CheckClient, Session and Audit must use the same authoritative transaction
// connection as Store. Session must validate the full Nextgen session cookie,
// including the currently active token, expiry and project; accepting a
// browser-provided user/session ID is not sufficient.
type LoginBridge struct {
	Store       Store
	ProjectID   string
	CheckClient func(context.Context, string, string, string, string) error
	Session     func(context.Context, string, string) (LoginIdentity, error)
	Audit       func(context.Context, AuthorizationCode) error
	LoginTTL    time.Duration
	CodeTTL     time.Duration
}

type LoginRequest struct {
	ClientID, RedirectURI, Scope, State, Nonce, CodeChallenge string
}

type CompletedLogin struct {
	Code, RedirectURI, State string
}

func (b LoginBridge) valid() bool {
	return b.Store.DB != nil && b.Store.Transaction != nil && b.Store.Now != nil && b.ProjectID != "" && b.CheckClient != nil && b.Session != nil && b.Audit != nil && b.LoginTTL > 0 && b.LoginTTL <= 10*time.Minute && b.CodeTTL > 0 && b.CodeTTL <= 5*time.Minute
}

// CreateSchema belongs in a versioned migration, not the request path.
func (b LoginBridge) CreateSchema(ctx context.Context) error {
	if b.Store.DB == nil {
		return errors.New("login bridge database not configured")
	}
	_, err := b.Store.DB.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS mapi_oauth_logins (
		handle_hash BLOB PRIMARY KEY, browser_hash BLOB NOT NULL,
		project_id TEXT NOT NULL, client_id TEXT NOT NULL, redirect_uri TEXT NOT NULL,
		scope TEXT NOT NULL, state TEXT NOT NULL, nonce TEXT NOT NULL,
		code_challenge TEXT NOT NULL, expires_at INTEGER NOT NULL
	)`)
	return err
}

func randomLoginSecret() (string, error) {
	var value [32]byte
	if _, err := rand.Read(value[:]); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(value[:]), nil
}

func validLoginSecret(value string) bool {
	if len(value) != 43 {
		return false
	}
	raw, err := base64.RawURLEncoding.DecodeString(value)
	return err == nil && len(raw) == 32 && base64.RawURLEncoding.EncodeToString(raw) == value
}

// Begin is called only after Provider.Authorize has validated the request.
// It repeats client admission transactionally to fence registration changes.
// The returned binding must be sent only in a secure cookie, never in JSON or
// a redirect. A separate cookie name per handle supports concurrent tabs.
func (b LoginBridge) Begin(ctx context.Context, request LoginRequest) (handle, binding string, err error) {
	if !b.valid() {
		return "", "", errors.New("login bridge not configured")
	}
	if request.ClientID == "" || len(request.ClientID) > 512 || request.RedirectURI == "" || len(request.RedirectURI) > 2048 || len(request.State) > 1024 || len(request.Nonce) > 512 || !validChallenge(request.CodeChallenge) || (request.Scope != "openid" && request.Scope != "openid offline_access") {
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
	handleHash, browserHash := sha256.Sum256([]byte(handle)), sha256.Sum256([]byte(binding))
	err = b.Store.Transaction(func() error {
		if err := b.CheckClient(ctx, b.ProjectID, request.ClientID, request.RedirectURI, request.Scope); err != nil {
			return err
		}
		_, err := b.Store.DB.ExecContext(ctx, `INSERT INTO mapi_oauth_logins
			(handle_hash,browser_hash,project_id,client_id,redirect_uri,scope,state,nonce,code_challenge,expires_at)
			VALUES (?,?,?,?,?,?,?,?,?,?)`, handleHash[:], browserHash[:], b.ProjectID, request.ClientID, request.RedirectURI,
			request.Scope, request.State, request.Nonce, request.CodeChallenge, b.Store.Now().Add(b.LoginTTL).UnixMilli())
		return err
	})
	if err != nil {
		return "", "", err
	}
	return handle, binding, nil
}

// Complete atomically validates the browser binding and live session, fences
// client changes, consumes the login, issues a code and audits its issuance.
// The caller must require a same-origin POST with CSRF protection and clear the
// binding cookie. On any failure the transaction leaves no code or audit row.
func (b LoginBridge) Complete(ctx context.Context, handle, binding, sessionCookie string) (CompletedLogin, error) {
	if !b.valid() {
		return CompletedLogin{}, errors.New("login bridge not configured")
	}
	if !validLoginSecret(handle) || !validLoginSecret(binding) || sessionCookie == "" || len(sessionCookie) > 8192 {
		return CompletedLogin{}, ErrInvalidLogin
	}
	handleHash, browserHash := sha256.Sum256([]byte(handle)), sha256.Sum256([]byte(binding))
	var completed CompletedLogin
	err := b.Store.Transaction(func() error {
		var savedHash []byte
		var project string
		var request LoginRequest
		var expires int64
		err := b.Store.DB.QueryRowContext(ctx, `SELECT browser_hash,project_id,client_id,redirect_uri,scope,state,nonce,code_challenge,expires_at
			FROM mapi_oauth_logins WHERE handle_hash=?`, handleHash[:]).Scan(&savedHash, &project, &request.ClientID, &request.RedirectURI,
			&request.Scope, &request.State, &request.Nonce, &request.CodeChallenge, &expires)
		if errors.Is(err, sql.ErrNoRows) {
			return ErrInvalidLogin
		}
		if err != nil {
			return err
		}
		if project != b.ProjectID || len(savedHash) != len(browserHash) || subtle.ConstantTimeCompare(savedHash, browserHash[:]) != 1 || !b.Store.Now().Before(time.UnixMilli(expires)) {
			return ErrInvalidLogin
		}
		if err := b.CheckClient(ctx, project, request.ClientID, request.RedirectURI, request.Scope); err != nil {
			return err
		}
		identity, err := b.Session(ctx, project, sessionCookie)
		if err != nil || identity.ProjectID != project || identity.UserID == "" || identity.SessionID == "" {
			return ErrInvalidLogin
		}
		grant := AuthorizationCode{ProjectID: project, ClientID: request.ClientID, RedirectURI: request.RedirectURI,
			UserID: identity.UserID, SessionID: identity.SessionID, Scope: request.Scope, Nonce: request.Nonce,
			CodeChallenge: request.CodeChallenge, ExpiresAt: b.Store.Now().Add(b.CodeTTL)}
		result, err := b.Store.DB.ExecContext(ctx, "DELETE FROM mapi_oauth_logins WHERE handle_hash=?", handleHash[:])
		if err != nil {
			return err
		}
		count, err := result.RowsAffected()
		if err != nil || count != 1 {
			return ErrInvalidLogin
		}
		code, err := b.Store.IssueInTransaction(ctx, grant)
		if err != nil {
			return err
		}
		if err = b.Audit(ctx, grant); err != nil {
			return err
		}
		completed = CompletedLogin{Code: code, RedirectURI: request.RedirectURI, State: request.State}
		return nil
	})
	if err != nil {
		return CompletedLogin{}, err
	}
	return completed, nil
}

// CanonicalLoginScope is used after OAuth validation; a stable ordering keeps
// pending-state comparisons independent of the client's scope order.
func CanonicalLoginScope(scopes []string) string {
	if len(scopes) == 1 && scopes[0] == "openid" {
		return "openid"
	}
	if len(scopes) == 2 && ((scopes[0] == "openid" && scopes[1] == "offline_access") || (scopes[1] == "openid" && scopes[0] == "offline_access")) {
		return "openid offline_access"
	}
	return strings.Join(scopes, " ")
}
