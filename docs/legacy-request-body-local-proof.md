# Legacy request-body bounds: local evidence

The legacy app previously buffered every request-body chunk in an array until the byte limit was reached. A stream could emit arbitrarily many zero-length chunks without consuming that limit, and an oversized request waited for `reader.cancel()`, which can remain pending. The public same-origin legacy login and logout routes used this reader, as did several operator and local-test routes.

`worker/app.js` now uses `readBoundedText` from `worker/request-body.js`. It uses the existing bounded byte reader, rejects after 1,024 empty chunks or the existing route byte limit, starts cancellation without waiting for it, and preserves the previous nonfatal UTF-8 decoding. Existing route-specific error handling remains in place: legacy login/logout and several operator paths return 413, while project creation and OIDC admin JSON parsing return 400. Existing cache-header behavior remains unchanged.

Run from the implementation checkout:

```sh
node scripts/test-request-body.mjs
node --experimental-vm-modules scripts/test-legacy-body-boundary.mjs
```

Both commands passed. The first checks split UTF-8, replacement decoding, byte and empty-chunk limits, and nonsettling cancellation. The second evaluates the actual `app.fetch` source in a Node VM with synthetic registry/owner bindings and unrelated imported modules stubbed. It exercises same-origin accepted login, logout, and user creation; login with 1,024 empty chunks; and oversized or 1,025-empty-chunk streams for login, logout, user creation, singleton initialization, project creation, OIDC admin, and restore. The rejected streams leave the later login, session, user/admin, provision, and restore calls untouched and retain the route-specific status/cache headers. A bounded one-second test timeout detects a stalled cancellation.

The registry lookup and owner identity/status checks can occur before body rejection. If the configured origin is absent, the app can reserve its route before reading the body; the singleton-init path can also attempt idempotent registry activation before the read. The fixture covers the existing active-route and activation cases, not absent-route reservation, and does not claim zero pre-read storage operations. It checks the later synthetic owner mutation calls only. It does not exercise a real Durable Object, Go handler, recovery workflow, hosted load, CPU or memory limits. No Woven deployment was touched.

The first two local runs exited with assertion failures because the synthetic source could close while Node wrapped the Request, so the underlying source's cancellation callback did not necessarily fire. The corrected failure streams remain open after their last chunk, making the nonsettling-cancellation check meaningful. Both corrected commands then exited successfully; no interrupted action was retried.
