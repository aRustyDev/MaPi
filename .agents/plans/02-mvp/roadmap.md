# MaPi roadmap from the Woven prototype to full ZITADEL Nextgen parity

## Destination

**MVP:** On Woven staging, an operator provisions a project, deploys a login configuration, and registers an OIDC client. The official `<zitadel-login>` component signs a user into an independent relying party. Two projects run side by side with separate data, keys, issuers, and sessions. The entire MVP runs on Workers and Cloudflare bindings.

**Full parity:** MaPi reproduces the shipped behavior of pinned, self-hosted Nextgen **v0.7.0** across the server, Console, CLI, SDKs, and operational workflows. The MVP issuer is an additional deliverable. The pinned native server mounts issuer scaffolding, denies issuer admission, and leaves the provider endpoints unimplemented. Use the existing upstream Go OAuth package and complete that path as a testable extension. [Pinned release](https://github.com/zitadel/nextgen/releases/tag/v0.7.0) · [Pinned issuer implementation](https://github.com/zitadel/nextgen/blob/b0b74cd4a198428ea9b82910c217259ffc62b65c/apps/api/internal/oauth/server.go) · [Nextgen protocol design](https://github.com/zitadel/nextgen/blob/b0b74cd4a198428ea9b82910c217259ffc62b65c/docs/adrs/082-oauth-and-oidc-server.md)


## Phase 2 · Ship the MVP

### Build

Mount the upstream flow start, read, and submit routes, plus session exchange, probe, CSRF, and logout. Serve `<zitadel-login>` with the pinned SDK proxy, one configurable password journey, branding, and locale assets. Extend the operator workflow to provision projects and users, publish and roll back login releases, and configure the issuer and a confidential web client. Implement discovery, authorization code with S256 PKCE, signed ID and access tokens, JWKS, userinfo, rotating refresh tokens, revocation, and RP-initiated logout. Use stable project issuers, exact redirect matching, and atomic code consumption and refresh rotation. Add readiness, abuse controls, redacted traces, key rollover, and recovery runbooks before pilot access.

### Exit gate

An independent RP completes login, refresh, revocation, and logout through the official component. The advertised OIDC profile passes the OpenID Foundation conformance suite. Verify code replay rejection, refresh reuse handling, key rollover, wrong issuer and audience rejection, cross-project isolation, keyboard and mobile use, and immediate rejection of a revoked app session. Repeat the runtime gate on the deployed MVP. [OpenID conformance suite](https://openid.net/certification/about-conformance-suite/) · [OAuth security BCP](https://www.rfc-editor.org/rfc/rfc9700.html)
