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
