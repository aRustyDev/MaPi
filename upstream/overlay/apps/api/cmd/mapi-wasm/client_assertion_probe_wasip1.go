//go:build wasip1 && mapi_oauth && mapi_assertion_test

package main

import (
	"context"
	"crypto/ecdsa"
	"crypto/ed25519"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/rsa"
	"encoding/json"
	"errors"
	"fmt"
	"net/http/httptest"
	"net/url"
	"time"

	"github.com/go-jose/go-jose/v4"
	"github.com/go-jose/go-jose/v4/jwt"
	"github.com/zitadel/nextgen/internal/audit"
	"github.com/zitadel/nextgen/internal/cloudflarewasm"
	"github.com/zitadel/nextgen/internal/domain"
	"github.com/zitadel/nextgen/internal/mapioauth"
	"github.com/zitadel/nextgen/internal/secrets"
	"github.com/zitadel/nextgen/internal/service"
)

// This diagnostic export is excluded from every normal and deployable build.
//
//go:wasmexport mapi_assertion_probe
func assertionProbe() uint64 {
	var args struct{ ProjectID, Origin string }
	if err := json.Unmarshal(input, &args); err != nil {
		return failure(err)
	}
	ctx := context.Background()
	_, db, err := oauthComposition(ctx, args.ProjectID, args.Origin)
	if err != nil {
		return failure(err)
	}
	defer db.Close()
	pool := runtimePool
	apps := service.NewApplicationService(pool, oauthSchemas, secrets.NewRandomSecretGenerator())
	doc := []byte(`{"slug":"assertion-test","name":"Assertion Test","clients":[{"slug":"web","type":"confidential","grant_types":["authorization_code"],"redirect_uris":["https://rp.example/callback"]}]}`)
	app, err := apps.CreateOrRevise(ctx, args.ProjectID, doc)
	if err != nil {
		return failure(err)
	}
	if len(app.Secrets) != 1 {
		return failure(errors.New("test client unavailable"))
	}
	client := app.Secrets[0].ClientID
	store := mapioauth.Store{DB: db, Transaction: cloudflarewasm.Transaction, Now: time.Now}
	stmts := pool.Statements()
	a := mapioauth.ClientAssertions{ProjectID: args.ProjectID, Issuer: args.Origin + "/oauth/" + args.ProjectID, Store: store, Registry: mapioauth.ClientRegistry{Statements: stmts}}
	a.AuditKeys = func(ctx context.Context, client string, kids []string) error {
		return audit.Emit(ctx, stmts, audit.EmitSpec{Type: domain.EventType("mapi.test.assertion.keys"), Category: domain.EventCategoryAdmin, ProjectID: args.ProjectID, EntityType: "oauth_client", EntityID: client})
	}
	a.AuditAuthentication = func(ctx context.Context, client, kid string) error {
		return audit.Emit(ctx, stmts, audit.EmitSpec{Type: domain.EventType("mapi.test.assertion.used"), Category: domain.EventCategoryAuth, ProjectID: args.ProjectID, EntityType: "oauth_client", EntityID: client})
	}
	if err = cloudflarewasm.Transaction(func() error { return a.CreateSchema(ctx) }); err != nil {
		return failure(err)
	}
	rsaKey, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		return failure(err)
	}
	ecKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return failure(err)
	}
	edPub, edPrivate, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return failure(err)
	}
	entries := []struct {
		id              string
		algorithm       jose.SignatureAlgorithm
		private, public any
	}{{"rsa", jose.PS256, rsaKey, &rsaKey.PublicKey}, {"ec", jose.ES256, ecKey, &ecKey.PublicKey}, {"ed", jose.EdDSA, edPrivate, edPub}}
	keys := make([]jose.JSONWebKey, 0, len(entries))
	signers := make([]jose.Signer, 0, len(entries))
	for _, entry := range entries {
		keys = append(keys, jose.JSONWebKey{Key: entry.public, KeyID: entry.id, Algorithm: string(entry.algorithm), Use: "sig"})
		signer, err := jose.NewSigner(jose.SigningKey{Algorithm: entry.algorithm, Key: &jose.JSONWebKey{Key: entry.private, KeyID: entry.id}}, nil)
		if err != nil {
			return failure(err)
		}
		signers = append(signers, signer)
	}
	if err = a.SetKeys(ctx, client, keys); err != nil {
		return failure(err)
	}
	makeAssertion := func(index int, id string) (string, error) {
		return jwt.Signed(signers[index]).Claims(map[string]any{"iss": client, "sub": client, "aud": a.Issuer, "jti": id, "exp": time.Now().Add(time.Minute).Unix()}).Serialize()
	}
	authenticate := func(raw string) error {
		return cloudflarewasm.Transaction(func() error {
			_, err := a.AuthenticateInTransaction(ctx, client, "urn:ietf:params:oauth:client-assertion-type:jwt-bearer", raw)
			return err
		})
	}
	for i := range entries {
		raw, err := makeAssertion(i, "algorithm-"+entries[i].id)
		if err != nil {
			return failure(err)
		}
		if err = authenticate(raw); err != nil {
			return failure(fmt.Errorf("algorithm %s first assertion: %w", entries[i].id, err))
		}
		if err = authenticate(raw); !errors.Is(err, mapioauth.ErrInvalidClient) {
			return failure(errors.New("assertion replay accepted"))
		}
	}
	raw, err := makeAssertion(1, "transaction-rollback")
	if err != nil {
		return failure(err)
	}
	abort := errors.New("test abort")
	form := url.Values{"client_id": {client}, "client_assertion_type": {"urn:ietf:params:oauth:client-assertion-type:jwt-bearer"}, "client_assertion": {raw}}
	err = cloudflarewasm.Transaction(func() error {
		if _, err := a.PARAuthenticator()(ctx, httptest.NewRequest("POST", args.Origin+"/par", nil), form); err != nil {
			return err
		}
		return abort
	})
	if !errors.Is(err, abort) {
		return failure(errors.New("transaction did not roll back"))
	}
	if err = authenticate(raw); err != nil {
		return failure(fmt.Errorf("assertion after rollback: %w", err))
	}
	if err = a.SetKeys(ctx, client, keys[1:]); err != nil {
		return failure(err)
	}
	retired, err := makeAssertion(0, "retired-key")
	if err != nil {
		return failure(err)
	}
	if err = authenticate(retired); !errors.Is(err, mapioauth.ErrInvalidClient) {
		return failure(errors.New("retired client key accepted"))
	}
	var count int
	if err = db.QueryRowContext(ctx, `SELECT count(*) FROM events WHERE project_id=? AND event_type='mapi.test.assertion.used'`, args.ProjectID).Scan(&count); err != nil {
		return failure(err)
	}
	if count != 4 {
		return failure(errors.New("assertion audit transaction mismatch"))
	}
	return marshal(map[string]any{"ok": true, "algorithms": 3, "auditedUses": count})
}
