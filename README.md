# MaPi

MaPi runs a ZITADEL Nextgen password and session flow on Cloudflare Workers. The Worker admits the prototype HTTP routes and forwards them to a SQLite-backed Durable Object. Inside the object, the pinned Nextgen Go handlers, credential checks, password verifier, and session services run in WebAssembly. The hosted runtime uses the Durable Object binding for storage.

The build fetches [Nextgen v0.7.0](https://github.com/zitadel/nextgen/releases/tag/v0.7.0) at `b0b74cd4a198428ea9b82910c217259ffc62b65c` and applies the adapter under `upstream/`. Upstream Go is covered by the [Nextgen license](https://github.com/zitadel/nextgen/blob/b0b74cd4a198428ea9b82910c217259ffc62b65c/LICENSE).

## Run locally

Use Node 24 or later and Go with toolchain downloads enabled. The build selects Go 1.26.9. The upstream fixture kit runs on macOS and Linux.

```sh
npm ci
npm run build
npm run test:baseline
npm run test:worker
```

The baseline starts the upstream SQLite server, provisions synthetic users and project credentials, exports a SQL fixture, and records HTTP and mutation audit behavior. The Worker suite runs the same flow in workerd. It also checks that an interrupted exchange rolls back, rejected requests cannot change project scope, and session state survives a Durable Object reset and a workerd restart.

Use `npm run dev` for an interactive local run after generating the fixture. Generated code, fixture data, and credentials live in ignored paths. The fixture uses `.dev.vars.poc`, keeping its key separate from the application key. Each fixture generation creates a new project ID and therefore a separate Durable Object.

## Cloudflare staging

Select your Cloudflare account through Wrangler or `CLOUDFLARE_ACCOUNT_ID` and keep the fixture that you used for parity.

```sh
npm run prepare:staging
npm run deploy:staging
MAPI_WORKER_URL=https://your-staging-worker.example npm run test:worker
```

The staging script writes the fixture’s master key and a generated request gate key to `.mapi/staging-secrets.json`. Wrangler uploads them as Worker secrets. The test client reads the gate key from that file. Local fault injection and object reset are available only on the loopback development server.

## Storage and transaction boundary

The Go SQLite statement layer uses its existing `database/sql` interface with a Durable Object-backed driver. Go transaction callbacks run synchronously inside `transactionSync`, so handoff consumption, session creation, and mutation audit records retain the same commit boundary. The bridge converts SQLite 64-bit integers to decimal text before they cross JavaScript, then reconstructs the exact integers in Go. This preserves Nextgen's nanosecond timestamps.

See [prototype results](REPORT.md) for the verified behavior and measurements.

The generated [parity inventory](docs/parity-inventory.md) tracks the pinned
OpenAPI operations and the other upstream surfaces. Run `npm run inventory:check`
after changing the adapter. A mounted route is not by itself evidence of parity.

### Experimental official login build

The official login component and upstream flow adapter use a separate build and
an isolated Wrangler configuration. This is a development lane, not a completed
OIDC issuer or a production-ready MVP. It does not replace the existing staging
application or its Durable Object namespace. See [MVP progress](docs/mvp-progress.md)
for the tested boundaries and remaining gates.

```sh
npm run build:flow
npm run build:login-assets
npm run baseline
XDG_CONFIG_HOME=/tmp/mapi-wrangler-config npx wrangler deploy --config wrangler.mvp.jsonc --env staging --dry-run
```

`build:flow` produces both the regular reactor and the flow-enabled reactor;
the isolated configuration selects the latter through a module alias. Generate
local secrets with `npm run prepare:app-local` before starting `wrangler dev`
with this configuration. Do not deploy this lane for pilot use until the OIDC,
browser security, hosted capacity, isolation, recovery, and conformance gates
in the roadmap pass.

## Application prototype

The application has its own Worker configuration and Durable Object namespace. Its baseline is generated from a freshly migrated SQLite database. Project creation, the primary release and its password policy are written by Nextgen in one transaction. User and password creation share a transaction and a failed audit write rolls it back.

For a fresh local installation, use Node 24 or newer, Go toolchain downloads, and Wrangler.

```sh
npm ci
npm run build
npm run baseline
npm run prepare:app-local
npm run dev:app
```

In a second terminal, read the operator token from the ignored `.dev.vars.app` file, then provision a project and user. Enter the password at the prompt.

```sh
export MAPI_URL=http://localhost:8787
export MAPI_OPERATOR_TOKEN="$(node -e 'const fs=require("fs"); const s=fs.readFileSync(".dev.vars.app","utf8"); console.log(s.match(/^MAPI_OPERATOR_TOKEN=(.*)$/m)[1])')"
node scripts/mapi.mjs admin init --name "My project"
node scripts/mapi.mjs admin user add --email user@example.com
node scripts/mapi.mjs admin status
```

The project registry associates each exact browser origin with one Durable Object. To provision another project, first configure its HTTPS hostname to route to the same Worker, then use `node scripts/mapi.mjs admin project add --name NAME --origin ORIGIN`. Run user-management commands against that project's origin. Project creation retries use the same reserved object and project. The existing application is registered at its configured origin using its existing object name.

Open `http://localhost:8787/login`. The user must be created before sign-in. The operator CLI also accepts a password on standard input for automation. Keep `.dev.vars.app` private.

### Isolated Cloudflare staging

The configuration targets the Woven account and its [staging application](https://mapi-nextgen-app-staging.woven-4d9.workers.dev/login). The following creates a new key and operator token once for a fresh installation. Back up `.mapi/app-staging-secrets.json` securely, including its master key and key ID. Reuse the file for subsequent deployments of the migrated application.

```sh
export CLOUDFLARE_ACCOUNT_ID=4d90c2d31b480584f8f878d2f62848ab
npm run prepare:app-staging
npm run deploy:app-staging
export MAPI_URL=https://mapi-nextgen-app-staging.woven-4d9.workers.dev
export MAPI_OPERATOR_TOKEN="$(node -p "require('./.mapi/app-staging-secrets.json').MAPI_OPERATOR_TOKEN")"
node scripts/mapi.mjs admin init --name "Staging project"
node scripts/mapi.mjs admin user add --email user@example.com
npm run test:app
npx playwright install chromium
npm run test:browser
npm run benchmark:app
```

The benchmark creates a synthetic user and runs 20 journeys at concurrency four. It writes its measurements to the ignored `.mapi/app-benchmark.json`. The login throttle allows 60 submissions per IP and 120 per object per minute; the official flow normally uses two submissions per sign-in. Run benchmarks in a fresh window. The operator API is authenticated with a separate token and is never called by the browser.

### Recovery and rollback

The `admin bookmark` command returns the current SQLite point-in-time bookmark. To restore, first set `MAPI_MAINTENANCE` to `1` and set `MAPI_RECOVERY_EPOCH` to a newly generated unique value in the environment's Wrangler variables, then deploy that version. This blocks application traffic and operator mutations. Keep the same master key.

```sh
node scripts/mapi.mjs admin bookmark
# After deploying maintenance mode with a new MAPI_RECOVERY_EPOCH:
node scripts/mapi.mjs admin restore --bookmark BOOKMARK
node scripts/mapi.mjs admin recover
node scripts/mapi.mjs admin status
```

`restore` schedules a restore and restarts the object. Wait until the object responds before running `recover`. Recovery revokes restored sessions through Nextgen, expires outstanding handoffs, records an audit event, and records the new epoch atomically. Confirm `recoveryReady` is true, remove `MAPI_MAINTENANCE`, retain the new `MAPI_RECOVERY_EPOCH`, and deploy again. Before each later restore, choose another new epoch. The epoch guard keeps traffic closed if maintenance is removed before invalidation completes. Point-in-time recovery reverts writes made after the bookmark.

Use `npx wrangler rollback VERSION_ID --config wrangler.app.jsonc --env staging` only with a Woven account version that supports the current schema and recovery epoch. Schema version 2 is an additive migration. Worker version IDs and point-in-time recovery bookmarks are scoped to their account.
