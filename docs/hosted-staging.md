# Isolated Woven OIDC staging

The experimental Worker is `mapi-nextgen-oidc-isolated-staging` in account
`4d90c2d31b480584f8f878d2f62848ab`. The deployed version
`c9bac9b3-abce-4f52-b570-bcebeb6b979d` was built from commit `2c9e779` with
an empty SQLite baseline and its own Durable Object namespaces. It is an
isolated test deployment, not the existing Woven application or a pilot release.
Public OIDC discovery is disabled pending the selected strict-PKCE profile and
its conformance gates.

The deployment-specific master key, key ID and operator token are backed up in
the personal 1Password Developer vault item `MaPi OIDC isolated staging recovery`.
The synthetic user and local copy of the secrets are in ignored owner-only files
under `.mapi/` in the development workspace. Do not commit them.

Cloudflare reported a **54,395.67 KiB** uncompressed upload and **101 ms**
startup validation. The official component passed a hosted browser test for
sign-in, protected reload, origin and CSRF rejection, logout and cookie replay.
A hosted 20-journey password-flow burst at concurrency four measured **2.49 s**
sign-in p95, with **106,168,320 bytes** of observed Wasm linear memory.

The hosted browser-to-independent-RP test passed signed ID-token verification
and one-time authorization-code replay rejection with no third-party backend.
Two 20-journey OIDC bursts at concurrency four measured **4.55 s** and **3.82 s**
sign-in p95, respectively, so the **3.5 s** target has not passed. Their full
journey p95s were **4.87 s** and **4.19 s**, including the relying party's token,
JWKS and replay checks. Observed Wasm linear memory was **106,168,320 bytes**.
These figures do not establish total isolate memory or Durable Object CPU.
Cloudflare's Worker invocation analytics showed no errors for the sampled
ingress requests, but the Durable Object CPU dataset returned no rows for this
run; do not interpret ingress CPU or memory as Durable Object measurements.

To repeat the hosted RP test, set `MAPI_URL`, `MAPI_OPERATOR_TOKEN`, and
`MAPI_TEST_USER_FILE` to the isolated deployment and its private synthetic test
user, then run `MAPI_TEST_BURST=1 npm run test:hosted-oidc`. The test creates a
temporary local HTTPS relying party and another synthetic client. Keep its
credentials and temporary files private. Run in a fresh throttle window.

The selected mandatory-S256 policy does not pass the official Basic OP profile;
see [OIDF conformance](oidf-conformance.md). FAPI, a second hosted project,
cross-project OIDC load, recovery at multi-project scale, the rest of Nextgen
parity and the full hosted performance and security gates remain open.
