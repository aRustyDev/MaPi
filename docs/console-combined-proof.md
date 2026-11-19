# Combined Console assets and runtime: local proof

The isolated Worker in `scripts/console-combined-proof-worker.mjs` combines the real pinned Console static build with the separate real-project Console runtime proof. It has no public deployment, is restricted to `MAPI_LOCAL_TEST=1` and loopback hostnames, and owns a local project registry and SQLite Durable Object namespace. The static proof's synthetic runtime is not used. No flow or management API is exposed by this Worker.

The sole browser API read is `GET /api/v1/sessions/me`. It resolves the exact request origin through the registry, requires one matching `project_id`, ignores forwarded-host and bearer headers, copies only the session cookie to the actual upstream handler, and checks object identity, origin, maintenance and recovery epoch in the same owner turn as that read. Responses use `no-store`. A mismatched Origin or project is rejected before the handler. This is test-only and is not the production ingress. It has not been reviewed for all encodings, duplicate cookies, revoked or relocated registry routes, or the full upstream session API.

## Run

Build the pinned Console with Node 24 and pnpm 12 in an isolated source checkout as described in [console-static-investigation.md](console-static-investigation.md), and generate the empty baseline as described by the project setup. From MaPi:

```sh
MAPI_CONSOLE_DIST=/private/tmp/mapi-console-proof/apps/api/internal/staticui/console/dist node scripts/build-console-static-proof.mjs
GOPROXY=off GOMODCACHE=/private/tmp/zitadel-nextgen-poc/go-mod GOCACHE=/private/tmp/zitadel-nextgen-poc/go-cache node scripts/build-console-runtime-proof.mjs
node scripts/test-console-combined-proof.mjs
```

Local workerd and Playwright prove that an unprovisioned origin renders the real Console's server-unavailable screen under this proof's intentionally strict runtime behavior. After two independently owned projects are provisioned, retry loads the first project's actual runtime and the official `<zitadel-login>` receives that project's ID. A second origin gets its own project and publishable key; mismatched Origin and forwarded-host attempts are fenced. The official component attempts `/api/v1/flows`, which returns 404 because the flow API is absent. The test creates a synthetic user and an actual upstream password session through operator-protected local-only setup endpoints, and checks anonymous/invalid rejection, a valid authoritative session read, browser session read, wrong-project and cross-object cookie rejection, and rejection of unsafe methods. Browser, network and test output do not print the synthetic credentials or session cookie.

The setup and `__test/session` endpoints are privileged test scaffolding; the latter makes separate admission and login calls and is not a safe production login interface. Never deploy this config or those endpoints. The Console browser was **not** signed in through its own component: the component's flow API, handoff exchange and logout are still missing from this integration. User/team/project reads, mutations, CSRF, platform users, delegated grants, claims and all other Console management APIs remain missing. The project-per-origin choice differs from native standalone's default/platform-project selection. The registry lookup and owner call are not a cross-object atomic operation; project relocation, stale route generations and revocation races require a durable fencing protocol before exposure. No hosted execution, asset deployment, security review, upstream Console suite, or production load test has been performed.
