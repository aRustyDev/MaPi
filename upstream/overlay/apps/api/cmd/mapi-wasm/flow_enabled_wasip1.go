//go:build wasip1 && mapi_flow

package main

import (
	"net/url"
	"time"

	lru "github.com/hashicorp/golang-lru/v2"
	"github.com/ianlancetaylor/jsonschema"
	"github.com/zitadel/nextgen/internal/crypto"
	"github.com/zitadel/nextgen/internal/domain"
	"github.com/zitadel/nextgen/internal/policy"
	"github.com/zitadel/nextgen/internal/service"
	configdefaults "github.com/zitadel/nextgen/packages/config/defaults"
)

func newFlowStack(pool *service.DB, keys service.KeyService, hashers *crypto.HasherFactory, attempts service.AuthAttemptService) (service.FlowService, service.ProjectService, error) {
	base := configdefaults.DefaultBuiltinSchemaBase
	bases := domain.BuiltinSchemaBasesFor(base)
	baseURL, err := url.Parse(base)
	if err != nil {
		return nil, nil, err
	}
	validator, err := domain.NewSchemaValidator(base)
	if err != nil {
		return nil, nil, err
	}
	schemaCache, err := lru.New2Q[string, *jsonschema.Schema](64)
	if err != nil {
		return nil, nil, err
	}
	resolver := domain.NewJSONSchemaResolver(schemaCache, 10, 0, nil, baseURL)
	engine, err := policy.New()
	if err != nil {
		return nil, nil, err
	}
	policies := service.NewPolicyService(pool, engine)
	passwords, err := service.NewPasswordPolicy(engine, policies, hashers.Default(), pool)
	if err != nil {
		return nil, nil, err
	}
	createPolicy, err := service.NewUserCreatePolicy(engine, policies)
	if err != nil {
		return nil, nil, err
	}
	protection := service.NewSignupProtection(pool, keys, createPolicy)
	projectHashers := service.NewProjectHasherResolver(pool, hashers)
	store := domain.WithBuiltinSchemaAliases(pool.Statements(), bases)
	refs := service.StatementsUserRefResolver{Pool: pool}
	users := service.NewUserService(pool, store, projectHashers, passwords, refs, bases)
	createUser := service.NewFlowCreateUserHandler(projectHashers, passwords, users, store, pool, protection)
	auth := service.NewFlowAuthAttemptAdapter(attempts, store, protection)
	connections := service.NewIDPConnectionService(pool, validator)
	providers := service.NewFlowSSOProviderResolver(connections)
	identities := service.NewFlowSSOIdentityResolver(pool, connections, users, store, projectHashers, passwords)
	// The outbound redirect issuer is deliberately not wired until the Worker
	// has an egress adapter. The identity resolver is still required on every
	// render to detect expired or already handed-off attempts.
	machine := domain.NewFlowStateMachine(resolver, pool.Statements(), domain.NewSchemaFieldResolver(), createUser, auth, providers, identities, nil, passwords, time.Now)
	projects := service.NewProjectService(pool, base, validator, keys, hashers, domain.DefaultSharedHosts)
	return service.NewFlowService(pool, machine, bases, protection), projects, nil
}
