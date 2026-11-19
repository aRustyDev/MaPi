# Isolated team-management proof

The test-only `mapi_teams` build wires the pinned Nextgen team service and generated authorization, decoding and response handlers for create, query, read, rename and deactivate operations, with `/api/v1` aliases. It does not change production ingress or deploy a Worker.

With the synthetic local fixture and `.dev.vars.poc` present, run:

```sh
node scripts/build-teams-test.mjs
node scripts/test-teams-parity.mjs
node scripts/parity-inventory.mjs --check
```

Run `node scripts/fixture.mjs` first if the fixture is absent. The build uses a temporary Git archive of the pinned source and applies the overlay. The test drives a native SQLite server and local workerd through upstream project/session credentials. It checks unauthorized and unprivileged-session access, CSRF, create/read/rename/deactivate, case-insensitive duplicate names, concurrent duplicate creation, query pagination and invalid cursors, tombstone reads and idempotent deactivation. It checks `team.created`, `team.updated`, and `team.deactivated` audit records on both targets and injects audit failures locally to verify that creates, renames, deactivation, memberships and owned-user status roll back together.

For the cascade test, a synthetic owned user, active membership and an owning-team assignment for a second project are inserted directly into each local test database. Both servers reject deactivation while the owning grant is active and leave all state untouched; after it is revoked, both deactivate the team and user and mark the membership removed. These inserts are fixture setup, not evidence of grant or membership administration.

**The owning-grant test is not a cross-object proof.** The Worker fixture contains rows for two projects in one SQLite object, so the upstream `HasActiveOwningTeamGrant` query can see both. With one object per project, a team can own a project whose grant lives in another object; the current local query cannot establish that no such grant exists. The adapter must remain unexposed until an authoritative cross-object ownership and revocation protocol fences team deactivation and its races. The same caution applies to users and memberships with cross-project dependencies.

The fixture also includes the second project's token and keys in that same object. A foreign-credential control reaches the common auth-attempt project fence (403 `proj.mismatch`, compared with native 201 for its own project), while the team adapter returns 401 for foreign-project scope where native returns 404. This is not a test of a credential issued by a second independently owned Worker object. Broader scoped/delegated permissions, request audits, mutation races under load, hosted limits and real ingress remain unproven. The local test-only build measured 53,370,812 bytes of Wasm once; it is not a total Worker upload, hosted CPU or isolate-memory measurement.
