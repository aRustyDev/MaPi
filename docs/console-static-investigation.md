# Pinned Console: static-assets investigation

The v0.7.0 Console is a Vite/React SPA, built from `apps/console` into `apps/api/internal/staticui/console/dist` by `turbo run build --filter=@zitadel/console`, including its workspace dependency builds. Its Vite base defaults to `/ui/console/`; `CONSOLE_BASE_PATH` can select another absolute path at build time. The shared checkout has no upstream `node_modules` or checked-in dist. An isolated build of the pinned source and frozen lockfile succeeded with Node 24.22.3 and pnpm 12.14.0. Its dist measured 3.3 MiB on disk across 185 files; these are static assets, separate from the Go Wasm bundle. The local-only Worker in `scripts/console-static-proof-worker.mjs` uses that actual build with a synthetic unprovisioned runtime. No hosted deployment or real API integration was tested.

The native server's static handler gives `/ui/console` a 308 redirect to `/ui/console/`, accepts only GET/HEAD, serves the SPA shell for client routes including dotted segments, but returns 404 for missing `assets/` paths. It sends `no-store` for index and one-year immutable caching for bundled assets. It also computes enforced and report-only CSP from the exact built index's inline-script hashes. A Workers Static Assets experiment must explicitly test these details, encoded paths, response types, redirects, and source maps; a generic SPA fallback may hide missing assets or accidentally intercept API calls.

The SPA fetches **same-origin** `/console/runtime.json` before rendering. The native GET/HEAD handler returns no-store JSON with `mode: "standalone"`, optional `console_project_id`, `publishable_key`, and, only for the reserved bootstrap project, `platform_project_id`; it resolves the default project on each request. The publishable key is derived from the project's active preview token and key, not a project secret. Runtime errors yield 500 and do not mean unprovisioned; unsupported methods return 405. A Worker implementation must preserve those behaviors, resolve the authoritative project and key per request, and never expose operator or project secrets. There is no production runtime endpoint in the current prototype.

The built Console assumes same-origin `/api/v1` flows and sessions, a browser-safe publishable key on public-plane flow calls, and the signed session cookie and session-bound CSRF on management mutations. Its signed-in routes require authoritative session validation and many management/project/authorization APIs. The project's experimental flow has unresolved local behavior; the optional management and invitation slices are private parity probes, not a complete Console backend. Serving a shell must not be presented as working login or management. Cross-project grants, platform operator identity, authorization consistency, existing private-probe namespace ownership, audit and resource limits remain open. No Console route should be deployed until the required session, CSRF, API ingress, routing and authorization path is tested end to end.

## Local proof and reproduction

The local Worker explicitly runs before the Static Assets binding and recreates the native static path routing and index-derived CSP. It provides only a synthetic empty standalone runtime; it does not forward or implement application APIs. The workerd test checks slash redirect, fallback including encoded paths, missing assets, content type, cache headers, CSP, HEAD and method handling, and confirms `/api/v1` is not caught by the SPA. Playwright renders the real built Console's `No project yet` screen, simulates a runtime outage, and verifies retry returns to the unprovisioned state. The computed CSP for the built index exactly matches the pinned upstream Go `console.Policies` output; the upstream static UI and security-header Go tests also pass. These are local checks against the native contracts; no real authenticated Console journey or route-by-route HTTP comparison with a running native server was performed.

From MaPi, the temporary toolchain and source checkout used here were prepared as follows (the install needs registry access):

```sh
mkdir -p /private/tmp/mapi-console-proof /private/tmp/mapi-console-toolchain/bin
git -C .mapi/nextgen archive b0b74cd4a198428ea9b82910c217259ffc62b65c | tar -x -C /private/tmp/mapi-console-proof
npm install --prefix /private/tmp/mapi-console-toolchain --no-audit --no-fund pnpm@12.14.0 node-bin-darwin-arm64@24.22.3
chmod +x /private/tmp/mapi-console-toolchain/node_modules/pnpm/bin/pnpm.mjs
ln -sf /private/tmp/mapi-console-toolchain/node_modules/node-bin-darwin-arm64/bin/node /private/tmp/mapi-console-toolchain/bin/node
ln -sf /private/tmp/mapi-console-toolchain/node_modules/pnpm/bin/pnpm.mjs /private/tmp/mapi-console-toolchain/bin/pnpm
cd /private/tmp/mapi-console-proof
PATH=/private/tmp/mapi-console-toolchain/bin:$PATH npm_config_manage_package_manager_versions=false PNPM_HOME=/private/tmp/mapi-console-toolchain/bin pnpm install --frozen-lockfile --filter '@zitadel/console...' --store-dir /private/tmp/mapi-console-pnpm-store
PATH=/private/tmp/mapi-console-toolchain/bin:$PATH npm_config_manage_package_manager_versions=false npm_config_cache=/private/tmp/mapi-console-npm-cache PNPM_HOME=/private/tmp/mapi-console-toolchain/bin pnpm exec turbo run build --filter=@zitadel/console --env-mode=loose
```

On other OS/architectures install the appropriate Node 24 binary. `--env-mode=loose` passes the temporary npm cache into package validation; use an appropriately controlled build environment in CI. Back in MaPi:

```sh
MAPI_CONSOLE_DIST=/private/tmp/mapi-console-proof/apps/api/internal/staticui/console/dist node scripts/build-console-static-proof.mjs
node scripts/test-console-static-proof.mjs
MAPI_NEXTGEN_SOURCE=/private/tmp/mapi-console-proof GOPROXY=off GOMODCACHE=/private/tmp/zitadel-nextgen-poc/go-mod GOCACHE=/private/tmp/zitadel-nextgen-poc/go-cache node scripts/test-console-csp.mjs
```

The builder copies generated assets and computes CSP hashes into ignored `worker/generated/`; it does not commit artifacts. The test requires loopback and the existing Playwright Chromium. The test config must never be deployed: it has no access control and its runtime is synthetic. An integration gate still needs real authoritative sessions, CSRF and management authorization, upstream Console suites (`console-smoke`, `console-real`, `console-embedded`, `console-platform`), project isolation and load tests.
