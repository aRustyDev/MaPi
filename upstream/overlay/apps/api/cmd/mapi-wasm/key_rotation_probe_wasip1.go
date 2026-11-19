//go:build wasip1 && mapi_oauth && mapi_key_rotation_test

package main

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/go-jose/go-jose/v4"
	"github.com/zitadel/nextgen/internal/cloudflarewasm"
	"github.com/zitadel/nextgen/internal/mapioauth"
	"github.com/zitadel/nextgen/internal/secrets"
	"github.com/zitadel/nextgen/internal/service"
)

// This export is compiled only into the isolated local test reactor.
//
//go:wasmexport mapi_key_rotation_probe
func keyRotationProbe() uint64 {
	var args struct{ ProjectID, Origin, UserID, SessionID, ForeignBearer, OwnBearer, OwnFAPIID, OwnFAPIAccess, OwnFAPIClient, ForeignFAPIID, ForeignFAPIAccess, ForeignFAPIClient string }
	if err := json.Unmarshal(input, &args); err != nil {
		return failure(err)
	}
	ctx := context.Background()
	c, db, err := oauthComposition(ctx, args.ProjectID, args.Origin)
	if err != nil {
		return failure(err)
	}
	defer db.Close()
	if args.ForeignBearer != "" {
		if _, err = c.Tokens.Access(ctx, args.ForeignBearer, ""); err == nil {
			return failure(errors.New("foreign project token accepted"))
		}
		if _, err = c.Tokens.Access(ctx, args.OwnBearer, ""); err != nil {
			return failure(errors.New("own project token rejected"))
		}
		p, err := mapioauth.NewPrivatePAR(mapioauth.PrivatePARConfig{ProjectID: args.ProjectID, Issuer: args.Origin + "/oauth/" + args.ProjectID, Store: mapioauth.Store{DB: db, Transaction: cloudflarewasm.Transaction, Now: c.Tokens.Store.Now}, Pool: runtimePool})
		if err != nil {
			return failure(err)
		}
		f, err := mapioauth.ComposePrivateFAPI(p, runtimePool, runtimeKeys)
		if err != nil {
			return failure(err)
		}
		if _, err = f.Tokens.ValidateIDToken(ctx, args.ForeignFAPIID, args.ForeignFAPIClient, "", args.ForeignFAPIAccess); err == nil {
			return failure(errors.New("foreign project FAPI token accepted"))
		}
		if _, err = f.Tokens.ValidateIDToken(ctx, args.OwnFAPIID, args.OwnFAPIClient, "", args.OwnFAPIAccess); err != nil {
			return failure(errors.New("own project FAPI token rejected"))
		}
		return marshal(map[string]bool{"ok": true})
	}
	if err = c.Admin.InitializeSchema(ctx); err != nil {
		return failure(err)
	}
	first, err := c.Admin.EnsureSigningKey(ctx)
	if err != nil {
		return failure(err)
	}
	if again, e := c.Admin.EnsureSigningKey(ctx); e != nil || again != first {
		return failure(errors.New("bootstrap was not idempotent"))
	}
	grant := mapioauth.AuthorizationCode{ProjectID: args.ProjectID, ClientID: "synthetic-client", UserID: args.UserID, SessionID: args.SessionID, Scope: "openid"}
	token1, err := c.Tokens.MintCodeTokens(ctx, grant)
	if err != nil {
		return failure(err)
	}
	second, err := c.Admin.RotateSigningKey(ctx)
	if err != nil || second == first {
		return failure(errors.New("bearer rotation failed"))
	}
	token2, err := c.Tokens.MintCodeTokens(ctx, grant)
	if err != nil {
		return failure(err)
	}
	for _, tok := range []string{token1.AccessToken, token2.AccessToken} {
		if _, e := c.Tokens.Access(ctx, tok, ""); e != nil {
			return failure(fmt.Errorf("bearer rollover validation: %w", e))
		}
	}
	public, err := c.Tokens.Keys.PublicKeys(ctx)
	if err != nil || len(public.Keys) != 2 {
		return failure(errors.New("bearer JWKS rollover failed"))
	}
	var before int
	if err = db.QueryRowContext(ctx, `SELECT count(*) FROM events WHERE project_id=? AND event_type='mapi.oauth.signing_key.rotated'`, args.ProjectID).Scan(&before); err != nil || before != 2 {
		return failure(errors.New("bearer audit count"))
	}
	bad := c.Tokens.Keys
	audit := bad.AuditRotation
	injected := errors.New("injected key audit failure")
	bad.AuditRotation = func(ctx context.Context, id string) error {
		if e := audit(ctx, id); e != nil {
			return e
		}
		return injected
	}
	if _, e := bad.Rotate(ctx, true); !errors.Is(e, injected) {
		return failure(errors.New("bearer audit failure ignored"))
	}
	var active string
	var count int
	if err = db.QueryRowContext(ctx, `SELECT key_id FROM mapi_oauth_signing_keys WHERE project_id=? AND active=1`, args.ProjectID).Scan(&active); err != nil || active != second {
		return failure(errors.New("bearer active key changed on rollback"))
	}
	if err = db.QueryRowContext(ctx, `SELECT count(*) FROM events WHERE project_id=? AND event_type='mapi.oauth.signing_key.rotated'`, args.ProjectID).Scan(&count); err != nil || count != before {
		return failure(errors.New("bearer audit survived rollback"))
	}
	if public, err = c.Tokens.Keys.PublicKeys(ctx); err != nil || len(public.Keys) != 2 {
		return failure(errors.New("bearer failed key persisted"))
	}

	apps := service.NewApplicationService(runtimePool, oauthSchemas, secrets.NewRandomSecretGenerator())
	app, err := apps.CreateOrRevise(ctx, args.ProjectID, []byte(`{"slug":"rotation-test","name":"Rotation test","clients":[{"slug":"web","type":"confidential","grant_types":["authorization_code"],"redirect_uris":["https://rp.example/callback"]}]}`))
	if err != nil || len(app.Secrets) != 1 {
		return failure(errors.New("test client provisioning failed"))
	}
	client := app.Secrets[0].ClientID
	p, err := mapioauth.NewPrivatePAR(mapioauth.PrivatePARConfig{ProjectID: args.ProjectID, Issuer: args.Origin + "/oauth/" + args.ProjectID, Store: mapioauth.Store{DB: db, Transaction: cloudflarewasm.Transaction, Now: c.Tokens.Store.Now}, Pool: runtimePool})
	if err != nil {
		return failure(err)
	}
	if err = p.InitializeSchema(ctx); err != nil {
		return failure(err)
	}
	pub, _, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return failure(err)
	}
	if err = p.Assertions.SetKeys(ctx, client, []jose.JSONWebKey{{Key: pub, KeyID: "synthetic-client-key", Algorithm: "EdDSA", Use: "sig"}}); err != nil {
		return failure(err)
	}
	policy, err := p.Policies.Put(ctx, client, client, nil, true, 0)
	if err != nil {
		return failure(err)
	}
	f, err := mapioauth.ComposePrivateFAPI(p, runtimePool, runtimeKeys)
	if err != nil {
		return failure(err)
	}
	f1, err := f.Keys.Rotate(ctx, false)
	if err != nil {
		return failure(err)
	}
	fgrant := mapioauth.FAPIExchangeGrant{ProjectID: args.ProjectID, ClientID: client, UserID: args.UserID, SessionID: args.SessionID, Scope: "openid", DPoPJKT: strings.Repeat("A", 43), PolicyVersion: policy.Version}
	mint := func() (string, string, error) {
		raw, e := f.Tokens.Mint(ctx, fgrant)
		if e != nil {
			return "", "", e
		}
		var v struct {
			Access string `json:"access_token"`
			ID     string `json:"id_token"`
		}
		if e = json.Unmarshal(raw, &v); e != nil {
			return "", "", e
		}
		return v.Access, v.ID, nil
	}
	access1, id1, err := mint()
	if err != nil {
		return failure(err)
	}
	f2, err := f.Keys.Rotate(ctx, true)
	if err != nil || f2 == f1 {
		return failure(errors.New("FAPI rotation failed"))
	}
	access2, id2, err := mint()
	if err != nil {
		return failure(err)
	}
	if _, err = f.Tokens.ValidateIDToken(ctx, id1, client, "", access1); err != nil {
		return failure(fmt.Errorf("old FAPI ID token: %w", err))
	}
	if _, err = f.Tokens.ValidateIDToken(ctx, id2, client, "", access2); err != nil {
		return failure(fmt.Errorf("new FAPI ID token: %w", err))
	}
	fpub, err := f.Keys.PublicKeys(ctx)
	if err != nil || len(fpub.Keys) != 2 {
		return failure(errors.New("FAPI JWKS rollover failed"))
	}
	if err = db.QueryRowContext(ctx, `SELECT count(*) FROM events WHERE project_id=? AND event_type='mapi.fapi.signing_key.rotated'`, args.ProjectID).Scan(&before); err != nil || before != 2 {
		return failure(errors.New("FAPI audit count"))
	}
	badF := f.Keys
	faudit := badF.AuditRotation
	badF.AuditRotation = func(ctx context.Context, id string) error {
		if e := faudit(ctx, id); e != nil {
			return e
		}
		return injected
	}
	if _, e := badF.Rotate(ctx, true); !errors.Is(e, injected) {
		return failure(errors.New("FAPI audit failure ignored"))
	}
	if err = db.QueryRowContext(ctx, `SELECT key_id FROM mapi_fapi_signing_keys WHERE project_id=? AND active=1`, args.ProjectID).Scan(&active); err != nil || active != f2 {
		return failure(errors.New("FAPI active key changed on rollback"))
	}
	if err = db.QueryRowContext(ctx, `SELECT count(*) FROM events WHERE project_id=? AND event_type='mapi.fapi.signing_key.rotated'`, args.ProjectID).Scan(&count); err != nil || count != before {
		return failure(errors.New("FAPI audit survived rollback"))
	}
	if fpub, err = f.Keys.PublicKeys(ctx); err != nil || len(fpub.Keys) != 2 {
		return failure(errors.New("FAPI failed key persisted"))
	}
	// Direct SQL removal is test-only fault injection. There is no supported
	// emergency signing-key revocation endpoint in these private issuer rings.
	if _, err = db.ExecContext(ctx, `DELETE FROM mapi_oauth_signing_keys WHERE project_id=? AND key_id=?`, args.ProjectID, first); err != nil {
		return failure(err)
	}
	if _, err = c.Tokens.Access(ctx, token1.AccessToken, ""); err == nil {
		return failure(errors.New("removed bearer key accepted"))
	}
	if _, err = c.Tokens.Access(ctx, token2.AccessToken, ""); err != nil {
		return failure(errors.New("current bearer key rejected"))
	}
	if _, err = db.ExecContext(ctx, `DELETE FROM mapi_fapi_signing_keys WHERE project_id=? AND key_id=?`, args.ProjectID, f1); err != nil {
		return failure(err)
	}
	if _, err = f.Tokens.ValidateIDToken(ctx, id1, client, "", access1); err == nil {
		return failure(errors.New("removed FAPI key accepted"))
	}
	if _, err = f.Tokens.ValidateIDToken(ctx, id2, client, "", access2); err != nil {
		return failure(errors.New("current FAPI key rejected"))
	}
	return marshal(map[string]any{"ok": true, "bearer": token2.AccessToken, "projectId": args.ProjectID, "fapiID": id2, "fapiAccess": access2, "fapiClient": client})
}
