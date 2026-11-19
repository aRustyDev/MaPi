# TypeScript API client session and CSRF parity

This local-only test exercises `@zitadel/api@0.7.0` against both pinned native Nextgen and the private workerd account adapter. It creates real password-authenticated Nextgen sessions and calls the SDK's `updateMyUser` and `getMyUser` methods. Node supplies the session cookie and same-origin header through a test fetch wrapper; this is a simulation of browser transport, not a browser security test.

After generating the synthetic fixture and building the test-only adapter, run:

```sh
node scripts/fixture.mjs
node scripts/build-account-test.mjs
node scripts/test-sdk-session-parity.mjs
```

Native and workerd agree for these scenarios: a missing CSRF token receives `403 auth.csrf_invalid`; a valid token permits the user update; a stale token invokes the SDK's registered handler exactly once and succeeds on exactly one retry if the handler returns the valid token; and a handler returning no token leaves the update refused without retry. A token bound to a different origin is not sent. Exactly two successful updates yield exactly two `user.updated` audit records; rejected requests leave the user and audit count unchanged. After operator revocation the SDK's self-read receives 401. Credentials, cookies and tokens remain local and are not printed.

The test does not use the browser's actual cookie jar, SameSite/CORS enforcement, another authenticated browser tab or a real cross-project Durable Object. It does not test all mutation APIs or the full upstream SDK/framework conformance suites. The adapter and helper ingress are isolated test code and are not deployed.
