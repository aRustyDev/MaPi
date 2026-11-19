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

Use `npm run dev` for an interactive local run after generating the fixture. Generated code, fixture data, and credentials live in ignored paths. Each fixture generation creates a new project ID and therefore a separate Durable Object.

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
