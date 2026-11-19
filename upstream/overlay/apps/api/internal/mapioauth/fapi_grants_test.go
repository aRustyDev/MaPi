package mapioauth

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"testing"
	"time"
)

func TestFAPIRefreshBindingAndRollback(t *testing.T) {
	ctx := context.Background()
	s, c := fixture(t)
	now := s.Now()
	s.Now = func() time.Time { return now }
	g := FAPIGrants{Store: s, ProjectID: c.ProjectID}
	if err := s.Transaction(func() error { return g.CreateSchema(ctx) }); err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256([]byte("device key"))
	jkt := base64.RawURLEncoding.EncodeToString(digest[:])
	otherDigest := sha256.Sum256([]byte("other key"))
	other := base64.RawURLEncoding.EncodeToString(otherDigest[:])
	grant := FAPIRefresh{RefreshGrant: RefreshGrant{ProjectID: c.ProjectID, ClientID: c.ClientID, UserID: c.UserID, SessionID: c.SessionID, Scope: "openid offline_access", ExpiresAt: now.Add(time.Hour)}, DPoPJKT: jkt, PolicyVersion: 1}
	var token string
	injected := errors.New("injected audit failure")
	err := s.Transaction(func() error {
		var err error
		token, err = g.IssueRefreshInTransaction(ctx, grant)
		if err != nil {
			return err
		}
		return injected
	})
	if !errors.Is(err, injected) {
		t.Fatalf("injected failure: %v", err)
	}
	err = s.Transaction(func() error { _, err := g.RefreshInTransaction(ctx, token, c.ClientID, jkt); return err })
	if !errors.Is(err, ErrInvalidRefresh) {
		t.Fatalf("rollback persisted token: %v", err)
	}
	if err = s.Transaction(func() error { var err error; token, err = g.IssueRefreshInTransaction(ctx, grant); return err }); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		client, jkt string
		valid       bool
	}{{c.ClientID, jkt, true}, {c.ClientID, jkt, true}, {c.ClientID, other, false}, {c.ClientID, "", false}, {"another-client", jkt, false}} {
		err = s.Transaction(func() error { _, err := g.RefreshInTransaction(ctx, token, tc.client, tc.jkt); return err })
		if (err == nil) != tc.valid {
			t.Fatalf("refresh valid=%v err=%v", tc.valid, err)
		}
	}
	foreign := g
	foreign.ProjectID = "another-project"
	err = s.Transaction(func() error { _, err := foreign.RefreshInTransaction(ctx, token, c.ClientID, jkt); return err })
	if !errors.Is(err, ErrInvalidRefresh) {
		t.Fatalf("cross-project refresh: %v", err)
	}
	err = s.Transaction(func() error {
		changed, err := g.RevokeRefreshInTransaction(ctx, token, c.ClientID)
		if err != nil {
			return err
		}
		if !changed {
			t.Fatal("did not revoke")
		}
		return injected
	})
	if !errors.Is(err, injected) {
		t.Fatal(err)
	}
	if err = s.Transaction(func() error { _, err := g.RefreshInTransaction(ctx, token, c.ClientID, jkt); return err }); err != nil {
		t.Fatalf("rollback revoked token: %v", err)
	}
	if err = s.Transaction(func() error {
		changed, err := g.RevokeRefreshInTransaction(ctx, token, c.ClientID)
		if err != nil {
			return err
		}
		if !changed {
			t.Fatal("did not revoke")
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if err = s.Transaction(func() error {
		changed, err := g.RevokeRefreshInTransaction(ctx, token, c.ClientID)
		if changed {
			t.Fatal("revoked twice")
		}
		return err
	}); err != nil {
		t.Fatal(err)
	}
	if err = s.Transaction(func() error { _, err := g.RefreshInTransaction(ctx, token, c.ClientID, jkt); return err }); !errors.Is(err, ErrInvalidRefresh) {
		t.Fatalf("revoked refresh: %v", err)
	}
}

func TestPrivateFAPISchemaUpgradeIsAtomic(t *testing.T) {
	ctx := context.Background()
	s, c := fixture(t)
	p := PrivatePAR{Store: s, Assertions: ClientAssertions{Store: s}, PAR: PARStore{Store: s}, Grants: FAPIGrants{Store: s, ProjectID: c.ProjectID}}
	if err := p.InitializeSchema(ctx); err != nil {
		t.Fatal(err)
	}
	for _, version := range []int{1, 2, 3, 4, 5, 6} {
		for _, q := range []string{"DROP TABLE mapi_fapi_logins", "DROP TABLE mapi_fapi_codes", "DROP TABLE mapi_fapi_refresh_tokens"} {
			if _, err := s.DB.Exec(q); err != nil {
				t.Fatal(err)
			}
		}
		if _, err := s.DB.Exec("UPDATE mapi_private_par_schema SET version=?", version); err != nil {
			t.Fatal(err)
		}
		if _, err := s.DB.Exec("CREATE VIEW mapi_fapi_refresh_tokens AS SELECT 1 AS project_id, 1 AS client_id"); err != nil {
			t.Fatal(err)
		}
		if err := p.InitializeSchema(ctx); err == nil {
			t.Fatal("expected failed migration")
		}
		var got int
		if err := s.DB.QueryRow("SELECT version FROM mapi_private_par_schema").Scan(&got); err != nil || got != version {
			t.Fatalf("version after failed migration = %d, %v", got, err)
		}
		var count int
		if err := s.DB.QueryRow("SELECT count(*) FROM sqlite_master WHERE type='table' AND name='mapi_fapi_codes'").Scan(&count); err != nil || count != 0 {
			t.Fatalf("partially created tables after failure: %d %v", count, err)
		}
		if _, err := s.DB.Exec("DROP VIEW mapi_fapi_refresh_tokens"); err != nil {
			t.Fatal(err)
		}
		if err := p.InitializeSchema(ctx); err != nil {
			t.Fatal(err)
		}
		if err := s.DB.QueryRow("SELECT version FROM mapi_private_par_schema").Scan(&got); err != nil || got != 7 {
			t.Fatalf("successful migration version = %d, %v", got, err)
		}
	}
	if _, err := s.DB.Exec("UPDATE mapi_private_par_schema SET version=99"); err != nil {
		t.Fatal(err)
	}
	if err := p.InitializeSchema(ctx); err == nil {
		t.Fatal("unsupported version accepted")
	}
}
