# Isolated branding-revision parity

This test-only build mounts pinned Nextgen's `POST /branding`, `GET /branding`, and `GET /branding/{branding_id}` handlers with their original generated decoding, authorization and response handling. It constructs the upstream branding service against the Durable Object SQLite bridge. It does not change public Worker ingress or publish anything to staging.

With the synthetic fixture (`node scripts/fixture.mjs`) and local dependencies available, run:

```sh
node scripts/build-branding-test.mjs
node scripts/test-branding-parity.mjs
```

The test compares native SQLite and local workerd statuses and stable error codes for bearer authorization, missing credentials, session-only writes and CSRF, unprivileged session reads, invalid layouts and script tags, publishing, reading, invalid cursors and missing revisions. It publishes concurrent equal configurations and proves each creates a distinct immutable revision, pages through the results without duplicate IDs, and checks that each successful publication emits exactly one `branding.created` event. It checks the event payload does not contain the synthetic Liquid template. Local workerd additionally injects an audit-write failure and verifies no event or revision remains; after eviction, a successful revision and its audit count remain readable. Native audit-fault injection was not performed.

**Foreign-project response parity is open.** The fixture contains a second project's token and keys in the same object. Its control request reaches the common project fence (`403 proj.mismatch`, compared with native `201` for that project's own attempt). A request to publish branding for the first project with that credential returns native `400 brnd.invalid` and workerd `401 auth.unauthorized`; both reject the request. This does not test independent Worker project objects, delegated grants or cross-object authority.

The pinned handler permits session credentials on reads but requires an operator credential for publishing: a session-only write returns `401`, even when a CSRF token is supplied. The lexical script-rejection check does not prove that all unsafe Liquid, URLs or browser rendering cases are safe. Release pinning, branding resolution in an actual flow, full page ordering/filters and error matrix, session grants, concurrent revocation, complete audit payloads and request auditing, host ingress, hosted performance and security review remain untested. The local test-only Wasm measured **53,166,658 bytes** in one build; it is not total upload or hosted CPU/memory evidence. Keep these routes private until their real authority and operational gates pass.
