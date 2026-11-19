# MaPi roadmap from the Woven prototype to full ZITADEL Nextgen parity

## Destination

**MVP:** On Woven staging, an operator provisions a project, deploys a login configuration, and registers an OIDC client. The official `<zitadel-login>` component signs a user into an independent relying party. Two projects run side by side with separate data, keys, issuers, and sessions. The entire MVP runs on Workers and Cloudflare bindings.

**Full parity:** MaPi reproduces the shipped behavior of pinned, self-hosted Nextgen **v0.7.0** across the server, Console, CLI, SDKs, and operational workflows. The MVP issuer is an additional deliverable. The pinned native server mounts issuer scaffolding, denies issuer admission, and leaves the provider endpoints unimplemented. Use the existing upstream Go OAuth package and complete that path as a testable extension. [Pinned release](https://github.com/zitadel/nextgen/releases/tag/v0.7.0) · [Pinned issuer implementation](https://github.com/zitadel/nextgen/blob/b0b74cd4a198428ea9b82910c217259ffc62b65c/apps/api/internal/oauth/server.go) · [Nextgen protocol design](https://github.com/zitadel/nextgen/blob/b0b74cd4a198428ea9b82910c217259ffc62b65c/docs/adrs/082-oauth-and-oidc-server.md)


## Phase 1 · Prove the runtime and storage boundaries

### Build

Build the real Go flow, issuer, and management dependency graphs and measure their size, cold start, memory, CPU, and throughput. Serve UI assets through Workers Static Assets. Use separate Worker builds for management or background processing where route selection and dead-code elimination leave insufficient headroom. Run upstream SQLite statement and migration tests against the Durable Object bridge, including exact 64-bit values, nested transaction behavior, SQL limits, and large imports. Build one SQLite Durable Object per project and a strongly consistent registry for project and origin routing. Use the existing snapshot approach to migrate the singleton into a project object under a write fence.

### Exit gate

Two projects stay isolated during concurrent requests, and the migrated project retains its ID, users, and audit history. Run a 20-journey burst at concurrency four per project, then repeat with concurrent management activity. Initial release budgets are **55 MiB uncompressed per Worker**, **750 ms startup validation**, and **3.5 s warm sign-in p95**, with unchanged Argon2 settings and zero CPU, memory, or overload errors. Profile allocation and report Wasm pages and total isolate memory separately when measurable. [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) · [Durable Object limits](https://developers.cloudflare.com/durable-objects/platform/limits/) · [Project data boundary](https://github.com/zitadel/nextgen/blob/b0b74cd4a198428ea9b82910c217259ffc62b65c/docs/adrs/068-project-is-the-data-boundary.md)
