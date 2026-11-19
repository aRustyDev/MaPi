# Isolated user-deletion proof

The test-only `mapi_userdelete` build wires the pinned Nextgen `DELETE /users/{user_id}` and `GET /users/{user_id}` handlers, with `/api/v1` aliases, through upstream security, user service and SQLite statements. It does not modify public ingress or deploy a Worker.

With the existing synthetic fixture and `.dev.vars.poc` present, run:

```sh
node scripts/build-userdelete-test.mjs
node scripts/test-userdelete-parity.mjs
node scripts/parity-inventory.mjs --check
```

Run `node scripts/fixture.mjs` first if the fixture is absent. The build archives the pinned source into a temporary checkout and applies the overlay. The test uses a native SQLite server and one local workerd Durable Object, signs in a real synthetic user, and compares status and stable error codes. It tests no or invalid credential, session CSRF and unprivileged-session rejection, deletion of a last owning-team member, concurrent/idempotent deletion, a subsequent read and a revoked session cookie.

For the cascade case, fixture setup inserts a home-project membership and an active owning-team grant and a direct user grant in another project, plus a different user's decoy grant. In each single database, the last-owner guard returns `409 proj.last_owner` without changes. After the synthetic owning grant is revoked, two concurrent deletes return 204, the user and membership disappear, the user's other-project grant is revoked, the decoy grant survives, and exactly one `user.deleted` and one foreign-project `authz.revoked` event are committed. The local workerd test also injects an audit failure and verifies the user, membership, grant, events and active session remain intact. Synthetic SQL fixture writes do not prove the corresponding team and grant management APIs.

**This does not prove cross-object deletion is safe.** Both test projects and all grants live in one SQLite object. In a one-object-per-project deployment, upstream `ensureProjectOwnerRemains` and `RevokeAuthzAssignmentsByPrincipal` can only see rows local to that object; owning-team membership and a user's grants in another object may be missed. Correct production behavior needs authoritative cross-project ownership and grant discovery, write fencing, transactional or durable idempotent revocation/audit reconciliation, and crash/restore/relocation tests. The separate team-ownership proof is not integrated and does not establish those user-deletion guarantees. Keep this mutation unexposed.

The fixture's second native project and its token, encryption/signing keys and authorization rows are included in the same Worker object. A control request proves the credential is recognized before the common project fence returns 403; the user-delete route returns 401 where native returns 404 for that foreign credential. This is not a test of independently owned Worker projects. Scoped and delegated credentials, native audit fault injection, request-audit parity, sustained concurrency, hosted limits and production ingress remain open. One local build measured 53,165,258 Wasm bytes; total Worker size, startup, CPU and peak isolate memory were not measured.
