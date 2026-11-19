//go:build wasip1 && mapi_schemas

package api

import (
	"context"
	"net/http"
	"net/url"

	lru "github.com/hashicorp/golang-lru/v2"
	"github.com/ianlancetaylor/jsonschema"
	generated "github.com/zitadel/nextgen/internal/api/generated"
	"github.com/zitadel/nextgen/internal/domain"
	"github.com/zitadel/nextgen/internal/service"
	defaults "github.com/zitadel/nextgen/packages/config/defaults"
)

// Test-only wiring: there is no outbound fetch capability in this adapter.
func configureMaPiSchemas(h *Handler, server *generated.Server, mux *http.ServeMux) {
	base := defaults.DefaultBuiltinSchemaBase
	bases := domain.BuiltinSchemaBasesFor(base)
	parsed, err := url.Parse(base)
	if err != nil {
		panic(err)
	}
	validator, err := domain.NewSchemaValidator(base)
	if err != nil {
		panic(err)
	}
	cache, err := lru.New2Q[string, *jsonschema.Schema](64)
	if err != nil {
		panic(err)
	}
	resolver := domain.NewJSONSchemaResolver(cache, 10, 0, nil, parsed)
	h.schemaService = service.NewSchemaService(h.pool, resolver, validator, bases)
	h.builtinBases = bases
	server.MountMaPiSchemas(mux, "")
	server.MountMaPiSchemas(mux, "/api/v1")
}

func (r cloudflareRoutes) PublishSchema(ctx context.Context, req generated.PublishSchemaReq, p generated.PublishSchemaParams) (generated.PublishSchemaRes, error) {
	if !r.inProject(ctx) {
		return nil, domain.ErrAuthUnauthorized(nil)
	}
	return r.handler.PublishSchema(ctx, req, p)
}
func (r cloudflareRoutes) ListSchemas(ctx context.Context, p generated.ListSchemasParams) (generated.ListSchemasRes, error) {
	if !r.inProject(ctx) {
		return nil, domain.ErrAuthUnauthorized(nil)
	}
	return r.handler.ListSchemas(ctx, p)
}
func (r cloudflareRoutes) GetSchema(ctx context.Context, p generated.GetSchemaParams) (generated.GetSchemaRes, error) {
	if !r.inProject(ctx) {
		return nil, domain.ErrAuthUnauthorized(nil)
	}
	return r.handler.GetSchema(ctx, p)
}
