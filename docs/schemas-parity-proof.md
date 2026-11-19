# Isolated schema revision parity

The local-only `mapi_schemas` adapter uses the pinned Nextgen schema service, JSON Schema validator/resolver, generated request and security handlers, and original mutation audit path for `POST /schemas`, `GET /schemas`, and `GET /schemas/{schema_id}` (including `/api/v1` aliases). It does not change public ingress or deploy a Worker. The resolver is intentionally constructed without outbound HTTP: remote schema URL ingestion and remote `$ref` resolution are not implemented by this adapter.

After preparing the synthetic fixture and `.dev.vars.poc` with `node scripts/fixture.mjs`, run:

```sh
node scripts/build-schemas-test.mjs
node scripts/test-schemas-parity.mjs
```

The test compares native Nextgen SQLite with local workerd using real project credentials and session cookies. It covers absent credentials, unprivileged sessions, invalid schema designation, immutable revisions, duplicate IDs and a concurrent duplicate race, object-type/kind and latest-revision filtering, paginated lists, rejection of a cursor from a different revision mode, direct reads, and eviction. It counts `schema.created` audits and injects a local audit failure to verify that neither the revision nor its mutation audit survives. Both implementations reject a foreign-project credential, but native returns HTTP 400 `sch.invalid_request` and workerd returns HTTP 401 `auth.unauthorized`. A separate foreign-project auth-attempt control returns native 201 versus workerd 403 `proj.mismatch`. The local Worker fixture holds both projects in one database; it is not an independently owned second Worker object or a cross-object authorization proof.

The test's Wasm was 53,326,945 bytes in one local build. No hosted memory, CPU, upload, concurrency or latency measurement has been made. Native remote schema ingestion, private-address egress policy, JSON Schema `$ref` graph behavior and timeouts, other schema kinds, large payloads, team/delegated grants, broader response and audit-payload matrices, and native fault injection remain untested. Actual configured flow rendering, production authorization and independent-project isolation also require tests. Keep this adapter private until those gates pass.
