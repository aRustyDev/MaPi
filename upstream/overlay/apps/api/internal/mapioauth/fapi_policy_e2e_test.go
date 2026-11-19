//go:build mapi_native_e2e && !wasip1

package mapioauth

import (
	"context"
	"database/sql"
	"errors"
	"sync"
	"sync/atomic"
	"testing"
)

func exerciseFAPIPolicies(t *testing.T, p *PrivatePAR, db *sql.DB, client string) {
	t.Helper()
	ctx := context.Background()
	before, err := p.Policies.Get(ctx, client)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = p.Policies.Put(ctx, client, client, nil, true, 0); !errors.Is(err, ErrFAPIPolicyConflict) {
		t.Fatalf("duplicate creation: %v", err)
	}
	if _, err = p.Policies.Put(ctx, client, client, nil, true, before.Version-1); !errors.Is(err, ErrFAPIPolicyConflict) {
		t.Fatalf("stale update: %v", err)
	}
	failure := errors.New("injected policy audit failure")
	bad := p.Policies
	oldAudit := bad.Audit
	bad.Audit = func(ctx context.Context, v FAPIClientPolicy) error {
		if err := oldAudit(ctx, v); err != nil {
			return err
		}
		return failure
	}
	var auditsBefore int
	if err = db.QueryRow(`SELECT COUNT(*) FROM events WHERE project_id=? AND event_type=?`, p.Grants.ProjectID, "mapi.fapi.resource_policy.updated").Scan(&auditsBefore); err != nil {
		t.Fatal(err)
	}
	if _, err = bad.Put(ctx, client, "https://rollback.example", nil, true, before.Version); !errors.Is(err, failure) {
		t.Fatalf("audit failure: %v", err)
	}
	after, err := p.Policies.Get(ctx, client)
	if err != nil || after.Version != before.Version || after.Audience != before.Audience {
		t.Fatal("failed update persisted")
	}
	var auditsAfter int
	if err = db.QueryRow(`SELECT COUNT(*) FROM events WHERE project_id=? AND event_type=?`, p.Grants.ProjectID, "mapi.fapi.resource_policy.updated").Scan(&auditsAfter); err != nil || auditsAfter != auditsBefore {
		t.Fatal("failed policy audit persisted")
	}
	var successes atomic.Int32
	var wg sync.WaitGroup
	for n := 0; n < 10; n++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, err := p.Policies.Put(ctx, client, before.Audience, before.Scopes, true, before.Version)
			if err == nil {
				successes.Add(1)
			} else if !errors.Is(err, ErrFAPIPolicyConflict) {
				t.Errorf("concurrent update: %v", err)
			}
		}()
	}
	wg.Wait()
	if successes.Load() != 1 {
		t.Fatalf("concurrent updates=%d", successes.Load())
	}
	current, err := p.Policies.Get(ctx, client)
	if err != nil || current.Version != before.Version+1 {
		t.Fatal("version after race")
	}
	current, err = p.Policies.Put(ctx, client, current.Audience, current.Scopes, false, current.Version)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = p.Policies.require(ctx, client, "openid"); !errors.Is(err, ErrFAPIPolicyDenied) {
		t.Fatal("disabled policy allowed")
	}
	if _, err = p.Policies.Put(ctx, client, current.Audience, current.Scopes, true, current.Version); err != nil {
		t.Fatal(err)
	}
	foreign := p.Policies
	foreign.ProjectID = "proj_other"
	if _, err = foreign.Get(ctx, client); !errors.Is(err, ErrFAPIPolicyDenied) {
		t.Fatal("cross-project policy exposed")
	}
	if _, err = p.Policies.Get(ctx, "missing-client"); !errors.Is(err, ErrFAPIPolicyDenied) {
		t.Fatal("missing policy allowed")
	}
	if _, err = p.Policies.Put(ctx, client, client, []string{"openid"}, true, current.Version+1); err == nil {
		t.Fatal("reserved resource scope accepted")
	}
}
