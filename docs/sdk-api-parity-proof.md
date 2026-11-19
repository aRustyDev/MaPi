# Pinned TypeScript API client: local parity slice

`scripts/test-sdk-api-parity.mjs` runs the actual `@zitadel/api@0.7.0` client against the pinned native Nextgen server and a separate local workerd SQLite object using the test-only management adapter. The test provisions a synthetic project and three users, exports the native SQLite fixture into the local object, and uses the same synthetic IDs and credentials for both targets. It compares client results and typed errors without printing credentials or response bodies.

After installing dependencies and generating the baseline fixture, build the private adapter and run the test:

```sh
node scripts/fixture.mjs
node scripts/build-management-test.mjs
node scripts/test-sdk-api-parity.mjs
```

It exercises the SDK's `getUser`, `queryUsers`, `queryUsers.pages`, `queryUsers.items`, and `queryUsers.all` through three one-item pages; verifies that page and item iterators return the same users without duplication; and checks `onResponse` and `onError` hooks, the typed `ApiError` and error code, missing and invalid inputs, foreign credentials, and concurrent clients with and without project credentials. It also checks the generated client's handling of a base URL already ending in `/api/v1`. Native and workerd produced matching results on these cases. The test starts only local synthetic servers and removes its temporary credentials and generated fixture.

This is **not** the upstream framework SDK conformance suite or a complete `@zitadel/api` audit. It exercises only these management reads, one cursor shape, the test adapter and local Node client. It does not establish browser cookie/CSRF behavior, write methods, framework SDK integration, true cross-object delegated grants, other paginated operations, error envelopes across all endpoints, hosted execution, or production ingress security. The fixture includes the second project's synthetic rows in the same object; it is not evidence of physical tenant isolation. The test-only adapter remains unexposed.

The repository pins `@zitadel/api` directly at `0.7.0`. `npm ci --dry-run --offline --ignore-scripts --no-audit --fund=false` against a temporary copy of the package manifest and lockfile passed; this verifies lockfile consistency, not a clean online dependency download.
