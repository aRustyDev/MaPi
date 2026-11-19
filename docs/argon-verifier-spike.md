# Isolated upstream Argon2 verifier spike

This is a capacity experiment, not a login implementation. It runs pinned Nextgen v0.7.0 `domain.UserPassword.Verify` in a separate Go/WASI reactor and invokes it from another Worker over a service binding. Its configuration retains Argon2id version 19, 64 MiB memory, three iterations and four lanes. The synthetic service accepts only that exact PHC profile, so it does **not** represent Nextgen's supported verifier or rehash policies in general. It has no route to the application and is not deployed by these commands unless explicitly requested.

Run locally with `node scripts/test-argon-spike.mjs`. It builds the pinned reactor, starts three local Workers, checks the bearer secret and the private service binding, correct and incorrect passwords, length and cost bounds, then runs 20 verifications at concurrency four. It also tests the deployment probe with generated synthetic credentials. A November 19 local run measured a 14,409,340-byte Wasm binary and 78,643,200 bytes of linear memory throughout setup, first verification and the burst. The 20-request p95 was 1,010 ms and wall time was 4,959 ms; these figures are local, not a Cloudflare limit or hosted latency measurement. Total isolate memory, scheduler behavior and scaling remain unmeasured.

The verifier and probe are separate staging Workers. The verifier config sets `workers_dev: false` and `preview_urls: false`; the probe has a gated HTTPS endpoint that generates its own synthetic credentials and accepts no caller-supplied password. Both use a deployment-specific service secret, and the probe requires a second bearer secret. These scripts do not log either secret, the synthetic password or hash. The probe has no persistent data and makes no external backend call. Its Worker URL is public but its endpoint returns 404 without the high-entropy probe token. Restrict access further with network controls before keeping it around; remove both experimental Workers after measurements.

On Woven staging, the committed verifier and gated probe completed the synthetic
20-verification burst at concurrency four with **78,643,200 bytes** of Wasm
linear memory. An independent client measured **10.29 s** for the entire probe,
including setup, negative verification and the burst. The probe's internal
`Date.now()` timing fields are not reliable on Workers and must not be used as
latency evidence. Cloudflare's sampled verifier invocation metrics reported
**90,227,280 bytes** of isolate memory at p95 and p99, CPU p50 **505.2 ms**,
CPU p95 **804.5 ms**, and zero errors across 23 sampled invocations. These
samples are not guaranteed peaks or evidence of end-to-end login performance.
Both temporary Workers were deleted after the measurement. The spike is still
unconnected to the application and the fencing requirements below remain open.

For an authorized isolated Woven staging measurement, build from committed source, then set secrets without placing their values in shell history:

```sh
node scripts/build-argon-spike.mjs
umask 077
mapi_argon_secrets=$(mktemp -d)
openssl rand -base64 48 | tr -d '\n' > "$mapi_argon_secrets/service"
openssl rand -base64 48 | tr -d '\n' > "$mapi_argon_secrets/probe"
npx wrangler deploy --config scripts/argon-spike-hosted-verifier.wrangler.jsonc
npx wrangler secret put ARGON_SPIKE_SECRET --config scripts/argon-spike-hosted-verifier.wrangler.jsonc < "$mapi_argon_secrets/service"
npx wrangler deploy --config scripts/argon-spike-hosted-probe.wrangler.jsonc
npx wrangler secret put ARGON_SPIKE_SECRET --config scripts/argon-spike-hosted-probe.wrangler.jsonc < "$mapi_argon_secrets/service"
npx wrangler secret put ARGON_SPIKE_TEST_AUTH --config scripts/argon-spike-hosted-probe.wrangler.jsonc < "$mapi_argon_secrets/probe"
```

Set `MAPI_ARGON_PROBE_ORIGIN` to the exact deployed probe HTTPS origin and run the synthetic probe without printing its token:

```sh
export MAPI_ARGON_PROBE_ORIGIN
export MAPI_ARGON_PROBE_TOKEN_FILE="$mapi_argon_secrets/probe"
node --input-type=module -e 'import {readFile} from "node:fs/promises"; const token=await readFile(process.env.MAPI_ARGON_PROBE_TOKEN_FILE,"utf8"); const r=await fetch(new URL("/probe",process.env.MAPI_ARGON_PROBE_ORIGIN),{method:"POST",headers:{authorization:`Bearer ${token}`}}); if(!r.ok)throw Error(`probe HTTP ${r.status}`); console.log(await r.text());'
```

Collect Cloudflare Worker CPU, total isolate memory, concurrent request and error metrics for **both** Workers during a fresh-object run. The response's Wasm page counts are not total isolate memory. On completion, delete the probe and verifier Workers and remove the temporary secret directory with `rm -rf "$mapi_argon_secrets"`. The probe cannot itself measure total isolate peak or prove that hosting will remain within limits.

## Required upstream and transaction design before integration

A service-binding response containing a boolean must never directly authorize a user. Splitting the synchronous `authAttemptService.verify` call changes its consistency boundary. The authoritative object must:

1. In one transaction, validate the bound flow, attempt, challenge, user and project state; capture the credential row ID and an immutable version or digest of the exact encoded hash, the current password policy/verifier configuration, the user/account status and an unpredictable short-lived, single-use verification nonce. The owner remains responsible for rate limits and dummy verification behavior. Release the transaction before any service call.
2. Send the normalized input or have the pinned `UserPassword.Verify` perform normalization in the verifier. Bind the authenticated response to project, attempt, challenge, credential ID/version, policy version and nonce; do not log credentials, hash, request or result. Ensure the Worker is private, secrets rotate, request size and cost are bounded, deadlines/cancellation are respected, and global/per-project admission limits prevent unbounded isolated instances. Treat timeout, verifier saturation and malformed responses as operational errors, not wrong passwords or failed-attempt increments.
3. On return, open a new authoritative transaction and re-read and compare every captured value, including current account status and the exact credential and policy version. Revalidate expiry, challenge state, attempt state, nonce and the caller's session/flow binding. Consume the nonce once; reject stale, replayed or mismatched results. A password change, account disablement, policy change, attempt expiry or challenge replacement between steps must prevent success, even if the old password verified.
4. Only after those checks, commit the upstream challenge result, factor and transactional audit record together. Wrong-password failure accounting and its audit must follow upstream semantics; infrastructure failures must not count as a bad password. Any rehash returned by a verifier must be conditionally applied to the same still-current credential and policy, with pinned `ErrRehashFailed` behavior, and never overwrite a newly changed password. Session and handoff creation remain on the owner and retain their existing atomic boundaries.
5. Add integration tests for credential change, user disablement, challenge replacement, expiry, policy change, verifier timeout, failed audit, replay and concurrent completion races, plus Unicode normalization, rehash and native parity. Verify fail-closed behavior across owner eviction, retries, relocation and recovery. Measure the owner without Argon2 linked or executed, the verifier's **total isolate memory** under burst and sustained load, service-binding queueing and end-to-end sign-in before adopting this design.

The current adapter makes no such fenced assertion and does not implement the above changes. Project-specific hash algorithms, cost limits and rehash policies also need parity before a production boundary could be considered.
