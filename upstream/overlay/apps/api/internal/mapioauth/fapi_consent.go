package mapioauth

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"errors"
	"net/url"
)

// FAPIConsentDetails is derived from the stored pushed request and live
// session; browser-supplied client, scope and redirect values are never used.
type FAPIConsentDetails struct{ ClientID, Scope, RedirectURI string }
type FAPIConsentDenied struct{ RedirectURI, State string }

// ConsentPreview repeats all authoritative binding, session, client and
// policy checks without consuming the login. Completion must revalidate.
func (f FAPILogin) ConsentPreview(ctx context.Context, handle, binding, session string) (FAPIConsentDetails, error) {
	if !f.configured() || !validLoginSecret(handle) || !validLoginSecret(binding) || session == "" || len(session) > 8192 {
		return FAPIConsentDetails{}, ErrInvalidLogin
	}
	var result FAPIConsentDetails
	err := f.Store.Transaction(func() error {
		request, _, err := f.validatedLogin(ctx, handle, binding, session)
		if err != nil {
			return err
		}
		if canonical, e := canonicalFAPIScopes(request.Scope); e != nil || canonical != request.Scope {
			return ErrInvalidLogin
		}
		if _, e := safeAuthorizationRedirect(CompletedLogin{RedirectURI: request.RedirectURI, Code: "validation"}); e != nil {
			return ErrInvalidLogin
		}
		result = FAPIConsentDetails{ClientID: request.ClientID, Scope: request.Scope, RedirectURI: request.RedirectURI}
		return nil
	})
	if err != nil {
		return FAPIConsentDetails{}, err
	}
	return result, nil
}

// Deny consumes one live browser-bound login and writes its denial audit in the
// same transaction. It issues no authorization code or session credential.
func (f FAPILogin) Deny(ctx context.Context, handle, binding, session string) (FAPIConsentDenied, error) {
	if !f.configured() || !validLoginSecret(handle) || !validLoginSecret(binding) || session == "" || len(session) > 8192 {
		return FAPIConsentDenied{}, ErrInvalidLogin
	}
	var result FAPIConsentDenied
	hash := sha256.Sum256([]byte(handle))
	err := f.Store.Transaction(func() error {
		request, identity, err := f.validatedLogin(ctx, handle, binding, session)
		if err != nil {
			return err
		}
		if _, err = safeAuthorizationRedirect(CompletedLogin{RedirectURI: request.RedirectURI, Code: "validation"}); err != nil {
			return ErrInvalidLogin
		}
		redirect, err := url.Parse(request.RedirectURI)
		if err != nil || redirect.Query().Has("iss") {
			return ErrInvalidLogin
		}
		var deleted []byte
		err = f.Store.DB.QueryRowContext(ctx, "DELETE FROM mapi_fapi_logins WHERE handle_hash=? RETURNING handle_hash", hash[:]).Scan(&deleted)
		if errors.Is(err, sql.ErrNoRows) {
			return ErrInvalidLogin
		}
		if err != nil {
			return err
		}
		if err = deleteFAPIPolicyBinding(ctx, f.Store, "login", hash[:]); err != nil {
			return err
		}
		if err = deleteFAPIPrompt(ctx, f.Store, "login", hash[:]); err != nil {
			return err
		}
		if _, err = f.Store.DB.ExecContext(ctx, `DELETE FROM mapi_fapi_reload WHERE project_id=? AND login_hash=?`, request.ProjectID, hash[:]); err != nil {
			return err
		}
		grant := AuthorizationCode{ProjectID: request.ProjectID, ClientID: request.ClientID, RedirectURI: request.RedirectURI, UserID: identity.UserID, SessionID: identity.SessionID, Scope: request.Scope, PolicyVersion: request.PolicyVersion}
		if err = f.Audit(ctx, "login_denied", grant, request.DPoPJKT); err != nil {
			return err
		}
		result = FAPIConsentDenied{RedirectURI: request.RedirectURI, State: request.State}
		return nil
	})
	if err != nil {
		return FAPIConsentDenied{}, err
	}
	return result, nil
}
