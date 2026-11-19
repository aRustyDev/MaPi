# MaPi roadmap from the Woven prototype to full ZITADEL Nextgen parity

## Destination

**MVP:** On Woven staging, an operator provisions a project, deploys a login configuration, and registers an OIDC client. The official `<zitadel-login>` component signs a user into an independent relying party. Two projects run side by side with separate data, keys, issuers, and sessions. The entire MVP runs on Workers and Cloudflare bindings.

**Full parity:** MaPi reproduces the shipped behavior of pinned, self-hosted Nextgen **v0.7.0** across the server, Console, CLI, SDKs, and operational workflows. The MVP issuer is an additional deliverable. The pinned native server mounts issuer scaffolding, denies issuer admission, and leaves the provider endpoints unimplemented. Use the existing upstream Go OAuth package and complete that path as a testable extension. [Pinned release](https://github.com/zitadel/nextgen/releases/tag/v0.7.0) · [Pinned issuer implementation](https://github.com/zitadel/nextgen/blob/b0b74cd4a198428ea9b82910c217259ffc62b65c/apps/api/internal/oauth/server.go) · [Nextgen protocol design](https://github.com/zitadel/nextgen/blob/b0b74cd4a198428ea9b82910c217259ffc62b65c/docs/adrs/082-oauth-and-oidc-server.md)


## Phase 0 · Establish the baseline

### Build

Capture the Woven prototype in a reproducible build from committed MaPi source. Pin the Go and npm builds, record the deployed version and schema, and run the same fixtures against native Nextgen, local workerd, and Woven. Generate a parity inventory from the **107 OpenAPI operations**, the additional native HTTP mounts, and the upstream browser, CLI, and SDK suites. Track draft capabilities separately from shipped behavior in the inventory.

### Exit gate

A clean checkout reproduces the empty-database deployment and passes the existing password, session, audit, rollback, eviction, and restore checks. Every shipped surface has a test or an identified test gap. [MaPi report](/Users/asmith/repos/arustydev/mapi/REPORT.md) · [Pinned OpenAPI](https://github.com/zitadel/nextgen/blob/b0b74cd4a198428ea9b82910c217259ffc62b65c/apps/api/api/openapi/bundled/openapi.json)
