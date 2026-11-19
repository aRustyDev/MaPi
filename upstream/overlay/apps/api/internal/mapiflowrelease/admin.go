//go:build mapi_oauth

// Package mapiflowrelease adds an opt-in operator workflow on top of pinned
// Nextgen flow definition, release, runtime resolution and deployment services.
package mapiflowrelease

import (
	"context"
	"errors"
	"fmt"
	"slices"

	"github.com/zitadel/nextgen/internal/api"
	"github.com/zitadel/nextgen/internal/domain"
	"github.com/zitadel/nextgen/internal/service"
	configdefaults "github.com/zitadel/nextgen/packages/config/defaults"
)

// Transaction must provide a DB whose statements and nested transactions join
// one authoritative transaction. On Workers the host transaction bridge does
// this; a native adapter can pass Nextgen's transaction-scoped statements.
type Transaction func(context.Context, func(context.Context, *service.DB) error) error

type Manager struct {
	ProjectID   string
	Origin      string
	Pool        *service.DB
	Keys        service.KeyService
	Schemas     service.BuiltinSchemaProvider
	Transaction Transaction
}

type Status struct {
	DeploymentID string `json:"deploymentId"`
	ReleaseID    string `json:"releaseId"`
	LoginFlows   []Flow `json:"loginFlows"`
}
type Flow struct {
	Name       string `json:"name"`
	RevisionID string `json:"revisionId"`
}
type Result struct {
	PreviousDeploymentID string `json:"previousDeploymentId"`
	DeploymentID         string `json:"deploymentId"`
	ReleaseID            string `json:"releaseId"`
	FlowRevisionID       string `json:"flowRevisionId,omitempty"`
	Created              bool   `json:"created"`
}

func (m Manager) configured() error {
	normalized, err := domain.NormalizeOrigin(m.Origin)
	if err != nil || normalized != m.Origin || m.ProjectID == "" || m.Pool == nil || m.Keys == nil || m.Schemas == nil || m.Transaction == nil {
		return errors.New("flow release manager not configured")
	}
	return nil
}
func (m Manager) services(db *service.DB) (*service.RuntimeResolver, service.ReleaseService, *service.DeploymentService, service.FlowDefinitionService) {
	bases := domain.BuiltinSchemaBasesFor(configdefaults.DefaultBuiltinSchemaBase)
	releases := service.NewReleaseService(db, nil, nil, nil, nil, nil, bases)
	deployments := service.NewDeploymentService(db, service.NewVariableService(db, m.Keys))
	flows := service.NewFlowDefinitionService(db, m.Schemas, nil, bases)
	return service.NewRuntimeResolver(db, releases), releases, deployments, flows
}

// current verifies the configured origin is a primary origin of this exact
// project and that it resolves to the same current primary deployment.
func (m Manager) current(ctx context.Context, db *service.DB) (*service.RuntimeResolution, error) {
	resolver, _, _, _ := m.services(db)
	primary, err := resolver.ResolvePrimary(ctx, m.ProjectID)
	if err != nil {
		return nil, err
	}
	if primary.Project == nil || primary.Project.ID != m.ProjectID || primary.Deployment == nil || primary.Release == nil {
		return nil, errors.New("primary deployment is unavailable")
	}
	allowed := false
	for _, origin := range primary.Project.Origins {
		if origin.Kind == domain.OriginKindPrimary && origin.Pattern == m.Origin {
			allowed = true
			break
		}
	}
	if !allowed {
		return nil, errors.New("origin is not a primary project origin")
	}
	routed, err := resolver.Resolve(ctx, m.ProjectID, m.Origin)
	if err != nil {
		return nil, err
	}
	if routed.Deployment == nil || routed.Deployment.ID != primary.Deployment.ID {
		return nil, errors.New("origin does not resolve to the current primary deployment")
	}
	return primary, nil
}

func (m Manager) Status(ctx context.Context) (Status, error) {
	if err := m.configured(); err != nil {
		return Status{}, err
	}
	var result Status
	err := m.Transaction(ctx, func(ctx context.Context, db *service.DB) error {
		current, err := m.current(ctx, db)
		if err != nil {
			return err
		}
		_, _, _, flows := m.services(db)
		result = Status{DeploymentID: current.Deployment.ID, ReleaseID: current.Release.ID, LoginFlows: []Flow{}}
		for _, pointer := range current.Release.Pointers {
			if pointer.Kind != domain.ReleasePointerKindFlowDefinition {
				continue
			}
			flow, err := flows.Get(ctx, m.ProjectID, pointer.RevisionID)
			if err != nil {
				return err
			}
			if _, ok := flow.Purposes[domain.FlowDefinitionPurposeLogin]; ok {
				result.LoginFlows = append(result.LoginFlows, Flow{Name: flow.Name, RevisionID: flow.ID})
			}
		}
		return nil
	})
	return result, err
}

// Publish replaces exactly one existing, project-wide login-flow revision in
// the current release and deploys it to primary origins. Definition, release,
// deployment and all upstream mutation audit events commit atomically.
func (m Manager) Publish(ctx context.Context, document []byte, expectedDeploymentID string) (Result, error) {
	if err := m.configured(); err != nil {
		return Result{}, err
	}
	if expectedDeploymentID == "" {
		return Result{}, errors.New("expected deployment is required")
	}
	definition, err := api.MaPiFlowDefinitionRequest(m.ProjectID, document)
	if err != nil {
		return Result{}, err
	}
	if definition.Purposes["login"] == "" || len(definition.Audience.AppIDs) > 0 || len(definition.Audience.TeamIDs) > 0 {
		return Result{}, errors.New("flow must define project-wide login")
	}
	var result Result
	err = m.Transaction(ctx, func(ctx context.Context, db *service.DB) error {
		ctx = service.WithAuthzListUnrestricted(ctx)
		current, err := m.current(ctx, db)
		if err != nil {
			return err
		}
		if current.Deployment.ID != expectedDeploymentID {
			return errors.New("deployment changed; refresh status")
		}
		_, releases, deployments, flows := m.services(db)
		var previous *domain.FlowDefinition
		for _, pointer := range current.Release.Pointers {
			if pointer.Kind == domain.ReleasePointerKindFlowDefinition && pointer.Handle == definition.Name {
				previous, err = flows.Get(ctx, m.ProjectID, pointer.RevisionID)
				if err != nil {
					return err
				}
				break
			}
		}
		if previous == nil || previous.Purposes[domain.FlowDefinitionPurposeLogin] == "" || len(previous.Audience.AppIDs) > 0 || len(previous.Audience.TeamIDs) > 0 {
			return errors.New("flow is not an existing pinned login flow")
		}
		flow, err := flows.Create(ctx, definition)
		if err != nil {
			return err
		}
		pointers := make([]service.CreateReleasePointer, 0, len(current.Release.Pointers))
		for _, pointer := range current.Release.Pointers {
			revision := pointer.RevisionID
			if pointer.Kind == domain.ReleasePointerKindFlowDefinition && pointer.Handle == definition.Name {
				revision = flow.ID
			}
			pointers = append(pointers, service.CreateReleasePointer{Kind: pointer.Kind, RevisionID: revision})
		}
		release, err := releases.Create(ctx, service.CreateReleaseInput{ProjectID: m.ProjectID, Pointers: pointers})
		if err != nil {
			return err
		}
		deployed, err := deployments.Deploy(ctx, service.DeployInput{ProjectID: m.ProjectID, ReleaseID: release.Release.ID, To: domain.DeployToPrimary(), Reason: domain.DeploymentReasonDeploy, ExpectedDeploymentID: &expectedDeploymentID})
		if err != nil {
			return err
		}
		if deployed.Deployment == nil {
			return errors.New("deployment was not returned")
		}
		resolved, err := m.current(ctx, db)
		if err != nil {
			return err
		}
		if resolved.Deployment.ID != deployed.Deployment.ID || resolved.Release.ID != release.Release.ID {
			return errors.New("deployed release did not resolve")
		}
		result = Result{PreviousDeploymentID: current.Deployment.ID, DeploymentID: deployed.Deployment.ID, ReleaseID: release.Release.ID, FlowRevisionID: flow.ID, Created: deployed.Created}
		return nil
	})
	return result, err
}

// Rollback uses the upstream rollback operation and refuses a deployment from
// another project, preview or a primary deployment that excluded this origin.
func (m Manager) Rollback(ctx context.Context, targetID, expectedDeploymentID string) (Result, error) {
	if err := m.configured(); err != nil {
		return Result{}, err
	}
	if targetID == "" || expectedDeploymentID == "" {
		return Result{}, errors.New("target and expected deployment are required")
	}
	var result Result
	err := m.Transaction(ctx, func(ctx context.Context, db *service.DB) error {
		ctx = service.WithAuthzListUnrestricted(ctx)
		current, err := m.current(ctx, db)
		if err != nil {
			return err
		}
		if current.Deployment.ID != expectedDeploymentID {
			return errors.New("deployment changed; refresh status")
		}
		_, _, deployments, _ := m.services(db)
		target, err := deployments.Get(ctx, m.ProjectID, targetID)
		if err != nil {
			return err
		}
		if target.ProjectID != m.ProjectID || target.OriginKind != domain.DeploymentOriginKindPrimary || !slices.Contains(target.Origins(), m.Origin) {
			return errors.New("rollback target does not include this primary origin")
		}
		restored, err := deployments.Rollback(ctx, service.RollbackDeploymentInput{ProjectID: m.ProjectID, DeploymentID: targetID, ExpectedDeploymentID: &expectedDeploymentID})
		if err != nil {
			return err
		}
		if restored.Deployment == nil {
			return errors.New("rollback deployment missing")
		}
		resolved, err := m.current(ctx, db)
		if err != nil {
			return err
		}
		if resolved.Deployment.ID != restored.Deployment.ID || resolved.Release.ID != target.ReleaseID {
			return fmt.Errorf("rollback did not resolve target release")
		}
		result = Result{PreviousDeploymentID: current.Deployment.ID, DeploymentID: restored.Deployment.ID, ReleaseID: target.ReleaseID, Created: restored.Created}
		return nil
	})
	return result, err
}
