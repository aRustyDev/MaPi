# Local login enumeration experiment

**Private experiment; do not mount or deploy.** The pinned default login flow reveals whether an email exists: a known identifier advances to the password step, while an unknown identifier advances to registration. This difference is observable both in the browser and in the flow API response.

The test-only adapter publishes a login-only flow requesting email and password together. For unknown identities it invokes `domain.UserPassword.Verify` against a synthetic, randomly generated hash from the same upstream hasher, then returns the same generic failure response as a wrong password. On either failure it denies access to the failed flow and issues a fresh upstream flow. No synthetic user is created, and success still goes through the real upstream challenge and handoff exchange. The adapter includes test-only per-IP and object-wide limits; it is not wired into the application.

**Critical gap: failure counter continuity.** Nextgen records a failed password proof on its challenge for rate-limiting and audit. Replacing the failed flow creates a different challenge, so the original challenge's failure count is not carried forward. The test limiter does not establish equivalence with upstream failure accounting. This experiment must not be deployed until a design preserves the upstream state and effective abuse protections (including on retries, concurrent requests, eviction and restore) and is tested against the native behavior. Creating new flows also accumulates provisional session and flow records; retention and resource bounds are not implemented.

## Reproduce

From the MaPi root, with the pinned upstream checkout and dependencies already prepared:

```sh
node scripts/test-enumeration-browser.mjs
```

The test starts local HTTPS workerd and Chromium using a generated certificate pinned by its SPKI. It builds `wasip1` with the test-only `mapi_enumeration_test` tag and does not deploy or call external services. It checks equivalent error JSON after removing generated IDs, status and cookie attributes, no password echo, no credential-authenticated session factors or new user, rejection of flow cookies by `/sessions/me`, rejection of discarded flow IDs, a concurrent shared per-IP throttle, cross-project rejection, a valid password followed by real handoff exchange and authoritative session read, and the official component's identical error for both failures.

One local run measured five alternating warm failures per case: unknown median **270.9 ms**, wrong-password median **268.9 ms**; the Wasm artifact was **55,590,342 bytes**. This small local sample is not evidence of constant-time behavior or hosted capacity. The experiment uses the pinned default hasher; accounts with legacy or different hash costs, cost upgrades, lockouts and other factor types require their own side-channel analysis. A robust production design also needs bounded cleanup, authoritative multi-project and origin isolation, uniform error and throttling behavior for all failure states, failure injection, load testing and hosted memory measurements. There is no guarantee that normalizing a response alone hides an account's existence.
