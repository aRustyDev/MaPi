# Experimental user read and query adapter

This is a local, opt-in proof for `GET /users/{user_id}` and `POST /users/query` and their `/api/v1` aliases. It is not mounted by the default application or its public ingress. `scripts/build-management-test.mjs` copies the pinned checkout to a temporary directory, applies one hook there, and builds a test-only `mapi_management` Wasm module. It does not change the default build. `scripts/test-management-parity.mjs` compares a separately seeded native server with a local workerd and normalizes generated identifiers and timestamps.

The generated handlers run the upstream Ogen decoders, Bearer/session security handling, and response encoders. Upstream handlers then run `requireResourceAccess` or `requireProjectListAccess` against the authoritative project SQLite state, including the upstream list-filter and permission decisions. The local tests cover successful own-project reads and lists, root aliases, absent and preview credentials, a credential from another project, unknown users and invalid paging. They do not establish full permissions parity for delegated grants, team-restricted lists, session credentials, expansions, filtering, pagination across multiple users, concurrent revocation, or cross-object authorization.

To evaluate integration, add `configureMaPiManagement(h, server, mux)` after creating the mux in `CloudflareHandler`, only in a build that includes the `mapi_management` tag; unconditional calls need a no-op implementation for other builds. The tagged function mounts only the two handlers and constructs a user service with read dependencies. Its write-related dependencies are deliberately nil: do not mount any user mutations through this service. The original user handler and authorization logic are not replaced. The generated `Server` must keep the upstream `NewSecurityHandler(tokens)`.

Before public exposure, resolve the project object from a trusted registry or origin and forward the Bearer credential to that object; do not use a client-supplied project ID as routing authority. Preserve the upstream session and CSRF middleware, bound query bodies and response sizes, redact authorization headers and user data from logs, and verify principal permissions and grant revocations on authoritative state. The route handlers can accept a project selector for upstream compatibility, but their authorization decisions must remain scoped to the owning object's authoritative data. Project-local data isolation and cross-project delegation require integration-specific tests; a credential accepted by one object must not bypass another object's ownership boundary. These read APIs do not write mutation audit records, but request auditing and cross-object consistency still require separate work.

Reproduction after generating `.mapi/fixture.json`, `worker/generated/fixture.json`, and `.dev.vars.poc` with `node scripts/fixture.mjs --test`:

```sh
node scripts/build-management-test.mjs
node scripts/test-management-parity.mjs
```

The test needs Go 1.26.9, the existing pinned Nextgen checkout and dependency cache, and local loopback ports. The local-only generated Wasm and credentials are ignored by Git. Successful local comparisons do not establish hosted capacity, full API parity, or permission to expose the experimental endpoints.

Ingress review identified several details that must be preserved during integration:

- Do not forward client-supplied `X-Forwarded-Host` or `X-Forwarded-Proto`: upstream derives its effective request origin from forwarding headers. Construct the request URL from the verified, registry-bound origin.
- Forward `Sec-Fetch-Site`, `Origin`, and `X-Zitadel-CSRF` for session-authenticated requests. Upstream checks unsafe request origins even for the CSRF-token-exempt user query; dropping browser metadata can make a request look like a non-browser request.
- Preserve Ogen's credential precedence: an accepted Bearer takes precedence over an accompanying cookie. The flow proxy substitutes an internal project credential for session exchange and must not be reused for management requests.
- Require an active registry route and verify that its project ID matches the Durable Object's identity. The current app has special handling for the pending singleton; pending routes are not suitable as public management authority.
- The local fixture contains key records for two projects in one object. Its cross-project 404 results do not prove status-code parity when each project has a separate object, or that delegated user sessions work across objects.
- Avoid caching token or grant authorization decisions; the upstream token service checks revocable token records. Compare behavior after revocation and during grant changes. Never log authorization headers, cookies, query bodies, or response bodies containing user data.

## Opt-in ingress component

`worker/management-proxy.js` exports `isManagementRoute` and `handleManagementIngress(request, registry, namespace)`. It is not called by the application. If the management build and route are explicitly enabled after review, the app can call the handler with its trusted `PROJECT_REGISTRY` and `NEXTGEN_APPLICATION` bindings for matching routes. The handler resolves the request origin itself, requires an active registry route and an object identity matching that route's project, and rejects foreign or repeated project selectors. It forwards bounded requests, the original Bearer and session credentials, browser-origin and CSRF headers, and no client forwarding headers. It returns `no-store` and forwards only a small allowlist of upstream response headers.

Run `node scripts/test-management-proxy.mjs` for the isolated routing and header tests. The tests use mocks for both the registry and the object: they verify how the proxy forwards session and Bearer credentials, but do not authenticate those credentials or prove CSRF decisions in a real Durable Object. The separately built `scripts/test-management-parity.mjs` compares native and workerd handlers, but bypasses this new ingress. A public deployment requires an end-to-end suite combining the real registry, ingress, Go adapter and project objects for Bearer, session, cross-origin and invalid-CSRF cases; that suite must also cover separate objects and delegated grants.

The proxy's identity check and registry lookup are separate calls. This is sufficient only while registry routes are immutable; it is not a relocation fence. Relocation must enforce a route generation and a local fence in the same authoritative transaction as each operation, including reads that mutate state, before old or cached routes can be accepted. The application must also enforce maintenance and recovery readiness before invoking the proxy. Body size is capped at 64 KiB; operational rate limits and a bounded response strategy remain integration work.

## Separate Worker build and real-object local test

The separate, experimental entry point is `worker/management-app.js`. Build it from the pinned Git object and checked overlays with `node scripts/build-management.mjs`. The build adds the management hook only to a temporary source tree and produces an ignored Wasm and a generated app module **without** the test credential helper. `wrangler.management.jsonc` defaults `MAPI_MANAGEMENT_ENABLED` to `0`, sets `workers_dev` to false, and is for local evaluation only. Nothing has been deployed.

**This configuration declares its own Durable Object classes and therefore creates separate namespaces. It does not administer the existing application deployment.** Production exposure requires an explicitly shared authoritative namespace or another reviewed binding design, plus tests proving that routing, identity, session and authorization decisions use the same live project data. Enabling the flag in this local configuration does not connect it to the app's database.

From a clean checkout, run `npm ci` and `bash scripts/build.sh` first to fetch the pinned Nextgen checkout and apply the baseline overlays. Then prepare the baseline and local secrets, and run:

```sh
node scripts/baseline.mjs
node scripts/app-secrets.mjs --local
node scripts/build-management-test.mjs
node scripts/test-management-e2e.mjs
node scripts/test-management-proxy.mjs
```

The test build has a synthetic, localhost-only method for obtaining project credentials; it must never be deployed. The end-to-end harness runs the same management ingress module as the separate Worker, a real registry and two real SQLite application objects. It checks project-secret access and precedence, unprivileged sessions, foreign cookies and credentials, route identity, pending and unregistered origins, cross-origin requests, query and body bounds, spoofed forwarding headers, logout CSRF, revocation, the disabled feature flag, and maintenance mode. The upstream user query is a read encoded as POST and is explicitly exempt from the CSRF token requirement; invalid and missing CSRF tokens on that query are not evidence that mutation CSRF works. Logout exercises the app's write CSRF path, not a management mutation.

A local dry run of the separate Worker reported 52,082.17 KiB uncompressed and 10,461.22 KiB gzip. The end-to-end run observed 104,857,600 bytes of Wasm linear memory for one exercised project; it did not measure total isolate memory, platform startup validation, hosted CPU or burst behavior. Still missing are positive delegated or administrator session cases, real management mutations and their CSRF/audit guarantees, grant-revocation races, request-audit parity, full pagination and filtering, bounded response sizes, relocation fencing, and a hosted workload assessment. These gaps preclude a claim of full API parity or readiness for public exposure.

## Shared authoritative namespaces: local proof

The separate owner and consumer are `worker/combined-owner.js` and `worker/shared-management.js`, configured by `wrangler.combined-owner.jsonc` and `wrangler.shared-management.jsonc`. The owner compiles the Go reactor with **both** `mapi_flow` and `mapi_management`. The consumer declares external Durable Object bindings for the owner's `ProjectRegistry` and `NextgenApplication` classes using `script_name`; it imports neither the application object nor its Wasm. Calls on those bindings execute the **owner Worker's code and environment**, so changing the consumer's Wasm or adding a local class to the consumer would not upgrade the authoritative objects. The owner must contain the combined reactor before those methods can serve management requests. See [Cloudflare's Durable Object binding configuration](https://developers.cloudflare.com/workers/wrangler/configuration/#durable-objects).

The checked configs are local examples, with `workers_dev: false` and `MAPI_MANAGEMENT_ENABLED: 0`. They have no production account or environment configured. Actual deployment requires both Workers to target the same Cloudflare account, the consumer's `script_name` and optional environment to identify the **exact** owner Worker that owns the intended namespaces, and tested bindings to the intended deployment. Changing Worker names, environments, migrations or declaring new local classes can create or target different namespaces; do not point the consumer at the current application until the owner's upgrade and the binding plan have been reviewed and tested. A successful dry run does not prove any remote binding exists.

After `npm ci`, `bash scripts/build.sh`, `node scripts/baseline.mjs`, and `node scripts/app-secrets.mjs --local` on a fresh checkout, run:

```sh
node scripts/build-combined.mjs
node scripts/build-combined-test.mjs
node scripts/test-shared-management.mjs
```

The first build creates the owner artifact without the test credential helper. The second creates an ignored, local-only owner with a synthetic credential helper; never deploy it. The test starts two separate local Wrangler processes and binds the management process to the owner process's real classes. It provisions two owner projects and users, observes an additional user written by the owner after both Workers start, checks project isolation and Bearer/session precedence, revokes a session on the owner and observes rejection through the consumer, restarts the owner with maintenance enabled and disabled to verify the separate consumer closes and reopens, then restarts the consumer disabled while the owner remains online. The shared consumer requires the owner status to include an explicit maintenance signal and fails closed if it is missing. It also starts and reads the flow engine through the combined owner (HTTP 201/200). This is not a complete official login or OIDC journey.

Local dry-run uploads were 53,017.18 KiB uncompressed / 10,648.85 KiB gzip for the combined owner and 5.36 KiB / 1.75 KiB for the consumer. An exercised project reached 105,381,888 bytes of Wasm linear memory; this is not total isolate memory. No Worker or binding was deployed and no hosted CPU, memory, latency or load test has been run. Cross-project delegated sessions, mutation and grant races, shared-namespace recovery and relocation, flow completion and issuer behavior remain unproven. The prior local standalone management config still creates independent namespaces; this shared-binding design does not retroactively change it.
