# Isolated self-service reads

The test-only `mapi_self` adapter invokes the pinned Nextgen generated handlers, session security, authorization and SQLite statements for `GET /users/me/schema`, `/users/me/teams`, `/users/me/identity_links`, `/users/{user_id}/teams`, and `/users/{user_id}/identity_links`, including their `/api/v1` aliases. It is a separate build from the account, passkey and management adapters and adds no production ingress.

With a local synthetic fixture and `.dev.vars.poc` already generated, reproduce from MaPi:

```sh
node scripts/build-self-test.mjs
node scripts/test-self-parity.mjs
node scripts/parity-inventory.mjs --check
```

Run `node scripts/fixture.mjs` first if the local fixture is absent. The build archives the pinned source and applies the overlay in a temporary checkout. The test starts a native server and local workerd, signs in through their actual password and session handlers, and inserts identical synthetic roster and identity-link records directly into each test database. These inserts are fixture setup, not evidence for team membership or external IdP management writes.

The comparisons check session-only and management credentials, missing credentials, an unprivileged session, wrong project, immediate session revocation, `no-store`, schema response keys, one-record pagination and invalid cursors. An active and an inactive team are returned; a removed membership and a different user's active membership are excluded. Two linked identities are paginated in order, while a different user's link and the upstream IdP subjects are absent from both self and admin responses. These tests do not exercise a real external IdP, cross-object grants, or all schema bodies and filters.

The fixture includes a second native project's token, key and authorization rows in the same test object. Its foreign credential returns 404 `user.not_found` on the native server and 401 `auth.unauthorized` through this object's project fence; a separate auth-attempt control confirms the fixture credential is recognized before that fence. This is not a second independently owned Worker object, and cross-object credential and authorization behavior remain unproven. The local test-only build measured 53,504,527 bytes of Wasm once; this is not hosted CPU, startup, full isolate memory or Worker upload evidence. Request-audit parity, scoped project credentials, broader delegated grants, production ingress and actual cross-project routing remain open. Do not expose the adapter on the strength of this proof alone.
