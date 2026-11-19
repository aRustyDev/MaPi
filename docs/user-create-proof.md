# Isolated user-creation parity proof

The `mapi_usercreate` test build mounts pinned Nextgen's `POST /users` and its `/api/v1` alias through the generated request, security, and response handlers. It reuses the test account adapter's upstream user service, schema store, password-policy dependencies, and project fence. It is not wired to production ingress or deployed. The local-only worker exposes privileged fixture and fault-injection hooks and must not be deployed.

After installing dependencies and generating the local synthetic fixture (`node scripts/fixture.mjs`), run:

```sh
GOPROXY=off GOMODCACHE=/private/tmp/zitadel-nextgen-poc/go-mod GOCACHE=/private/tmp/zitadel-nextgen-poc/go-cache GOTOOLCHAIN=go1.26.9 node scripts/build-usercreate-test.mjs
node scripts/test-usercreate-parity.mjs
node scripts/parity-inventory.mjs --check
```

The native SQLite and local workerd comparison covers correct project credentials, missing and invalid credentials, an unprivileged session with and without CSRF or with a foreign origin, invalid project/schema/attributes, duplicate identifiers, two concurrent creates for the same identifier, generated response field names, reads of a newly created user, and the API alias. It asserts exactly one successful concurrent creation and one committed `user.created` event. It also seeds a synthetic team directly in each database, creates a user with `team_id`, and checks the corresponding membership and audit. In workerd, injected audit-write failure rolls back both a user-only creation and a user-with-membership creation; the latter verifies that neither user nor membership nor its success event persists. Native audit fault injection is not exercised. The local test build produced 54,641,545 bytes of Wasm in one run; this is not the complete Worker upload, hosted memory or CPU.

The upstream pinned native server returned `400 user.invalid` to the tested unprivileged session with valid CSRF and to a foreign-project credential targeting the primary project. The local adapter returned `401 auth.unauthorized` for that foreign credential. The fixture contains both projects and their credentials in one SQLite object; it does not exercise a credential issued by a second independently owned Worker object. For a nonexistent `team_id`, both tested targets returned `500 internal` without retaining a user or success audit; this records the pinned behavior, not a recommendation for an API contract.

These comparisons do not cover every schema, response field, lifecycle owner, delegated/team-scoped permission, transaction failure, or uniqueness race. Cross-project team and principal ownership, management ingress, registration, request auditing, native fault injection, all supported aliases, full error details and production size, load, security, and recovery gates remain open. No password is created by this API operation; password enrollment and login remain separate. In particular, a production implementation must establish authoritative ownership, route fencing and transaction behavior before it treats a local team lookup as sufficient across project objects.
