//go:build mapi_oauth && mapi_native_e2e && !wasip1

package mapiflowrelease

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"os"
	"testing"

	"github.com/zitadel/nextgen/internal/cache"
	"github.com/zitadel/nextgen/internal/crypto"
	"github.com/zitadel/nextgen/internal/domain"
	"github.com/zitadel/nextgen/internal/service"
	"github.com/zitadel/nextgen/internal/storage/dialect/sqlite"
	configdefaults "github.com/zitadel/nextgen/packages/config/defaults"
	"github.com/zitadel/oidc/v3/pkg/op"
	_ "modernc.org/sqlite"
)

type fixture struct {
	ProjectID, DBPath string
	Key               struct{ ID, PEM string }
}
type txPool struct{ stmts service.AllStatements }

func (p txPool) Statements() service.AllStatements { return p.stmts }
func (p txPool) Transaction(ctx context.Context, fn func(context.Context, service.Statementer[service.AllStatements]) error) error {
	return fn(ctx, p)
}

type auditFault struct {
	service.AllStatements
	fail *bool
}

func (s auditFault) InsertEvent(ctx context.Context, event *domain.Event) error {
	if *s.fail {
		return errors.New("injected audit failure")
	}
	return s.AllStatements.InsertEvent(ctx, event)
}

func TestNativeFlowReleasePublishRollback(t *testing.T) {
	var f fixture
	if err := json.Unmarshal([]byte(os.Getenv("MAPI_NATIVE_OIDC_FIXTURE")), &f); err != nil || f.ProjectID == "" {
		t.Skip("requires isolated native fixture runner")
	}
	ctx := context.Background()
	db, err := sql.Open("sqlite", f.DBPath)
	if err != nil {
		t.Fatal(err)
	}
	db.SetMaxOpenConns(1)
	sqlitePool := sqlite.NewMaPiNativeTestPool(db)
	t.Cleanup(func() { sqlitePool.Close(ctx) })
	base := service.NewPool(sqlitePool)
	project, err := base.Statements().GetProjectByID(ctx, f.ProjectID)
	if err != nil {
		t.Fatal(err)
	}
	var origin string
	for _, o := range project.Origins {
		if o.Kind == domain.OriginKindPrimary {
			origin = o.Pattern
			break
		}
	}
	if origin == "" {
		t.Fatal("fixture has no primary origin")
	}
	masterKey, err := crypto.ParseRSAKey(f.Key.PEM)
	if err != nil {
		t.Fatal(err)
	}
	master, err := domain.NewMasterKeys([]domain.MasterKey{domain.NewMasterKey(f.Key.ID, *masterKey, true)})
	if err != nil {
		t.Fatal(err)
	}
	crypters, err := cache.NewMeteredLRU[service.CrypterCacheKey, op.Crypto](cache.NameCrypter, 16)
	if err != nil {
		t.Fatal(err)
	}
	signing, err := cache.NewMeteredLRU[service.SigningKeyCacheKey, domain.SigningKey](cache.NameSigningKey, 16)
	if err != nil {
		t.Fatal(err)
	}
	keys := service.NewKeyService(base, *master, crypters, signing)
	schemas, err := domain.NewSchemaValidator(configdefaults.DefaultBuiltinSchemaBase)
	if err != nil {
		t.Fatal(err)
	}
	fail := false
	manager := Manager{ProjectID: f.ProjectID, Origin: origin, Pool: base, Keys: keys, Schemas: schemas, Transaction: func(ctx context.Context, fn func(context.Context, *service.DB) error) error {
		return sqlitePool.Transaction(ctx, func(ctx context.Context, tx service.Statementer[service.AllStatements]) error {
			return fn(ctx, service.NewPool(txPool{stmts: auditFault{AllStatements: tx.Statements(), fail: &fail}}))
		})
	}}
	initial, err := manager.Status(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(initial.LoginFlows) != 1 {
		t.Fatalf("expected one pinned login flow: %+v", initial)
	}
	var doc map[string]any
	if err = json.Unmarshal(configdefaults.DefaultLoginFlowDefinition(), &doc); err != nil {
		t.Fatal(err)
	}
	doc["name"] = initial.LoginFlows[0].Name
	steps := doc["steps"].([]any)
	first := steps[0].(map[string]any)
	actions := first["actions"].([]any)
	actions[0].(map[string]any)["text_key"] = "identifier.action.modified"
	valid, err := json.Marshal(doc)
	if err != nil {
		t.Fatal(err)
	}
	count := func(table string) int {
		var n int
		if err := db.QueryRow("SELECT count(*) FROM "+table+" WHERE project_id=?", f.ProjectID).Scan(&n); err != nil {
			t.Fatal(err)
		}
		return n
	}
	tables := []string{"flow_definitions", "releases", "deployments", "events"}
	before := make([]int, len(tables))
	for i, table := range tables {
		before[i] = count(table)
	}
	if _, err = manager.Publish(ctx, []byte(`{"name":"broken","steps":[]}`), initial.DeploymentID); err == nil {
		t.Fatal("invalid flow accepted")
	}
	if _, err = manager.Publish(ctx, valid, "stale"); err == nil {
		t.Fatal("stale deployment accepted")
	}
	fail = true
	if _, err = manager.Publish(ctx, valid, initial.DeploymentID); err == nil {
		t.Fatal("audit fault accepted")
	}
	fail = false
	for i, table := range tables {
		if got := count(table); got != before[i] {
			t.Fatalf("failed publish wrote %s: %d != %d", table, got, before[i])
		}
	}
	published, err := manager.Publish(ctx, valid, initial.DeploymentID)
	if err != nil {
		t.Fatal(err)
	}
	if published.DeploymentID == initial.DeploymentID || published.ReleaseID == initial.ReleaseID || published.FlowRevisionID == "" {
		t.Fatalf("invalid publish: %+v", published)
	}
	current, err := manager.Status(ctx)
	if err != nil || current.DeploymentID != published.DeploymentID || current.LoginFlows[0].RevisionID != published.FlowRevisionID {
		t.Fatalf("incorrect live flow: %+v %v", current, err)
	}
	if _, err = manager.Rollback(ctx, initial.DeploymentID, initial.DeploymentID); err == nil {
		t.Fatal("stale rollback accepted")
	}
	wrong := manager
	wrong.Origin = "https://other.example"
	if _, err = wrong.Status(ctx); err == nil {
		t.Fatal("foreign origin accepted")
	}
	rolled, err := manager.Rollback(ctx, initial.DeploymentID, published.DeploymentID)
	if err != nil {
		t.Fatal(err)
	}
	if rolled.ReleaseID != initial.ReleaseID || rolled.DeploymentID == published.DeploymentID {
		t.Fatalf("incorrect rollback: %+v", rolled)
	}
	final, err := manager.Status(ctx)
	if err != nil || final.ReleaseID != initial.ReleaseID || final.LoginFlows[0].RevisionID != initial.LoginFlows[0].RevisionID {
		t.Fatalf("rollback did not restore flow: %+v %v", final, err)
	}
}
