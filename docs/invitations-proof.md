# Invitation administration: isolated parity proof

This is a **local, test-only** adapter for pinned Nextgen v0.7.0. It mounts the upstream create, list, get, and cancel handlers using the original generated HTTP decoder, authentication middleware, authorization checks, services, project encryption keys and mutation audit. It is not connected to the application ingress. The adapter fixes `proj_platform` and a synthetic Console URL solely for this test; neither is a deployable configuration.

With Go 1.26.9, Node and the installed dependencies and fixture described in the main repository setup, run:

```sh
node scripts/fixture.mjs
GOPROXY=off GOMODCACHE=/private/tmp/zitadel-nextgen-poc/go-mod GOCACHE=/private/tmp/zitadel-nextgen-poc/go-cache node scripts/build-invitations-test.mjs
node scripts/test-invitations-parity.mjs
```

The fixture contains generated credentials; do not commit or publish it. The suite starts the pinned native server with `NEXTGEN_PLATFORM_BOOTSTRAP_PROJECT=true`, then an isolated local workerd object. It inserts the same synthetic owning-team assignment directly into each database to model a claimed project; it does **not** exercise the project claim workflow or create an actual owning team. It compares unauthorized, session CSRF and unprivileged-session responses, unclaimed rejection, encrypted-metadata creation and reading, project-scoped listing, one-item cursor pagination, replacement retaining journey and metadata, cancellation and duplicate cancellation. Two concurrent cancellations produce one success. Successful mutation audit counts are checked on both runtimes; injected audit failure tests rollback of creation, replacement and cancellation on workerd. The returned invitation link is checked at creation and absent from later read and list responses; secret values are not printed.

The other-project bearer credential is demonstrably recognized in the imported local fixture: an auth-attempt request for its own project reaches the project's fence and returns `403 proj.mismatch`, while the native shared-database control returns 201. A foreign credential against the invitation admin endpoint returns native `404 inv.not_found` and workerd `401 auth.unauthorized` because the adapter first fences to the object project. This differs from native behavior and has not been tested with separately owned Worker objects. The synthetic assignment is not evidence of safe cross-object ownership or delegated authorization.

At this pin, lookup, accept and reject are upstream `not_implemented` stubs. This proof does not mount them or implement redemption, membership creation, email delivery, expiry, pending limits, browser use, independent object isolation, or hosted execution. No invitation route should be exposed publicly from this harness.

## Integration constraints

Upstream creation checks whether the project is claimed before its transaction; its pending limit, replacement and audit writes occur in its project transaction. Any real cross-object ownership/claim changes must be serialized or fenced against creation to avoid a grant revocation race. The authoritative project grants, project keys, invitations and mutation audit must be routed to the same owning project object, while user/team lifecycle and delegated grant authorization must consult their authoritative owners with a proven fencing protocol. Do not treat this test's direct SQL assignment or the separate ownership coordinator proof as integrated safety. The console link must use the real configured origin; do not log links, tokens, metadata, project secrets or keys. The isolated Wasm measured 53,601,171 bytes; this excludes Worker JS and any combined feature graph.
