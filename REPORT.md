# Prototype results

**Go for the scoped prototype.** On November 18, 2026, pinned Nextgen passed native SQLite parity in workerd and completed the hosted password, handoff, session read, and revocation flow in Cloudflare staging. The hosted Worker used its SQLite Durable Object for all backend state. This validates one synthetic project at prototype load.

## Behavior verified locally

- The same HTTP harness ran against the pinned Nextgen binary and the Worker. Status codes, error codes, response field sets, and grouped mutation audit counts matched. The suite covered password rejection, incomplete attempts, expiry, project mismatch, and immediate session revocation.
- Only one of ten concurrent exchanges consumed the same handoff. Injecting a failure at the audit write left the session and audit counts unchanged, and the original handoff remained usable.
- A Durable Object reset and a full workerd restart preserved active and revoked session state. The fixture initialized once.
- The WASI reactor preserved an exact 64-bit SQLite value through commit and rollback. It used the upstream Argon2id verifier at `t=3`, `m=64 MiB`, and `p=4`. Collecting Go’s scratch memory between proofs brought the probe from 158.5 MiB to 94.5 MiB of Wasm linear memory.

## Hosted verification

The [gated staging Worker](https://mapi-nextgen-poc-staging.developer-90f.workers.dev) ran version `017714f6-bc81-4a1c-a03c-f8f579a2b28d` in the aRustyDev account. The hosted suite verified the ten-way exchange and ran 20 additional password journeys at concurrency four. The unauthenticated staging gate returned HTTP 404. None of the 92 captured staging trace events reported an exception or platform limit error.

The initial deployment trapped in Go when the hosted scheduler saw a zero monotonic clock at startup. A positive monotonic base resolved it. The successful run retained the upstream Argon2 settings.

## Measurements

| Measurement | Result |
| --- | ---: |
| Native SQLite sign-in, single local sample | 44 ms |
| Local workerd sign-in, first sample after probe | 527 ms |
| Worker upload size, uncompressed | 38.6 MiB |
| Cloudflare deployment startup validation | 92 ms |
| First hosted journey after the code update | 3.95 s |
| Warm hosted sign-in, single sample | 1.66 s |
| Hosted journey latency at concurrency four, median / p95 | 4.58 s / 5.46 s |
| Hosted Durable Object CPU, p95 / max across 39 sampled events | 1.20 s / 1.85 s |
| Hosted peak Wasm linear memory observed after the burst | 94.75 MiB |

Sign-in timings run from attempt creation through session exchange. Journey timings also include a session read and revocation. The first hosted journey used a cold Go reactor and an existing SQLite fixture. The CPU sample includes the final two-hash runtime probe. Linear memory measures the reactor’s Wasm pages. Cloudflare’s total isolate memory was outside this measurement.

Reproduce the latency and memory samples with the hosted invocation in [the README](README.md). Collect `cpuTime` from `wrangler tail --env staging --format=json` during that run and filter events to `executionModel: durableObject` for the CPU sample.

## Application prototype results

The first-party application was deployed to [isolated staging](https://mapi-nextgen-app-staging.developer-90f.workers.dev) on November 18, 2026. Version `333add4a-7606-4ae6-a51f-074260703a98` uses a separate SQLite-backed Durable Object initialized from the pinned upstream migrations. The runtime uses only the Durable Object binding for backend state. The browser receives Nextgen's session cookie and the Go reactor performs the authentication, handoff exchange, session reads, revocation, and audit writes.

The HTTP and Chromium tests passed against staging. A fresh local store passed failures at all seven bootstrap audit writes, successful retry, user creation rollback and retry, duplicate-user rejection, invalid and missing CSRF tokens, local eviction, and session-cookie replay after logout. The local recovery test minted a handoff, invalidated it through the recovery operation, and verified exchange failed. The original native SQLite parity and Worker atomicity suite also passed with the expanded Go reactor. Local failed-login testing produced 30 rejections followed by five throttle responses in one minute.

An additive migration to schema version 2 and a rollback to compatible version `5fa9347e-3c47-41e8-9bd0-98d3a9ab88d1` preserved an active session and a revoked session on staging. A separate recovery Worker was restored to a Cloudflare bookmark. A post-bookmark user was absent after restore, and recovery invalidation rejected both a previously active cookie and a previously revoked cookie. Local workerd reported that its storage backend does not implement point-in-time recovery, so the restore itself was verified on Cloudflare.

| Application measurement | Result |
| --- | ---: |
| Worker upload, uncompressed | 50,518.77 KiB |
| Startup validation, measured deploy | 165 ms |
| Cold reactor sign-in, one sample after deploy | 1,245 ms |
| Warm sign-in at concurrency four, median / p95 | 2,154 / 2,271 ms |
| Full journey at concurrency four, median / p95 | 2,490 / 2,609 ms |
| Durable Object CPU, p95 / maximum across 15 captured events | 1,790 / 1,790 ms |
| Observed Wasm linear memory after the run | 104,333,312 bytes |

The load sample used version `8461c132-704b-4590-a7f4-071f4660748a` and contained 20 journeys with the upstream Argon2id cost. Thirty-four captured trace events reported `ok` and no exceptions. Wasm linear memory measures allocated Wasm pages rather than total isolate memory. The cold sample followed a code deployment, and a status check confirmed that the Go reactor had not yet initialized. The final deployment uploaded 50,519.40 KiB and validated startup in 114 ms. See the application commands in [the README](README.md) for reproduction.

The clean registry install reports ten moderate advisories in the pinned testing and CLI dependency tree, including a transitive `minimatch` advisory. `npm audit` reported no automatic fix within the pinned dependency versions. These packages are development tools and are not imported by the application Worker.

## Woven account migration

On November 18, 2026, the application, API proof of concept, and recovery rehearsal Workers moved to account `4d90c2d31b480584f8f878d2f62848ab`. The application is at [Woven staging](https://mapi-nextgen-app-staging.woven-4d9.workers.dev/login). The source application database contained one project, 20 users, five sessions, and 782 audit records at transfer. The recovery database contained one project, three users, and 45 audit records. The API proof-of-concept database contained three projects, two users, one session, and 214 audit records. Project origins and primary deployments were updated through Nextgen after copying.

The previously issued application test account signed in successfully in Woven, and logout and revoked-cookie replay passed. The Woven application HTTP and Chromium suites and the API proof-of-concept parity and 20-journey concurrency suite passed. Browser cookies are scoped to the old hostname, so users need to sign in at the Woven URL. The earlier measurements in this report describe the prior account, where they were collected.

After verification and operator approval, the three original Worker scripts and their Durable Object namespaces were deleted from the prior account. Cloudflare's account inventory confirmed that the three Workers and three corresponding namespaces remain present in Woven.
