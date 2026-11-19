# Private split-password contention experiment

This local-only measurement compares the **existing unmounted split-verifier experiment** with the same pinned Nextgen `VerifyProof` running inline in the project Durable Object. Both use the pinned default Argon2id profile, including 64 MiB memory, three iterations and four lanes. The split path uses the private separate Go/WASI verifier and the experimental project-wide SQLite mutation-generation fence described in [the split integration proof](upstream-split-password-proof.md). No production route or deployed Worker is changed.

After generating the synthetic fixture, run from MaPi with Node, Go 1.26.9, repository dependencies and loopback access:

```sh
node scripts/fixture.mjs
node scripts/test-split-latency.mjs
```

The command builds both reactors from a pinned source archive and runs local workerd. With `MAPI_TEST_PREBUILT=1` it reuses the ignored artifacts; `MAPI_LATENCY_ROUNDS` can be an integer from 1 through 10. Each round creates a fresh project object and prepares four distinct password challenges for the same synthetic user. It then sends four verification requests concurrently. Split requests retry a stale snapshot up to eight times, performing the real Argon2 verification again each time; other errors fail the test. After timing has stopped, all four attempts must create readable sessions, reject handoff replay and have exactly four successful password-check audits. The inline and split modes use separate objects and the same prehashed fixture. Test credentials, hashes, tokens and cookies are not printed.

On November 19, 2026, three runs of two batches each produced:

| Local measurement | Inline owner | Split verifier |
| --- | ---: | ---: |
| Four-verification batch wall time | 1.03–1.07 s | 2.50–2.68 s |
| Stale retries per eight verifications | 0 | 12 |
| Observed owner Wasm linear memory | 105,381,888 bytes | 38,273,024 bytes |

Each split batch retried six verifications after other successful checks advanced the global mutation generation. All eventual verifications, sessions, handoff replay checks and audit assertions passed. The separate verifier's memory is not included in the owner figure. This small local sample shows the present fence can trade owner memory for substantial duplicate hash work and worse contention; it does **not** establish Cloudflare-hosted throughput, CPU, peak isolate memory, cost or end-to-end sign-in p95. Request setup, identifier steps, session exchange and RP work are outside the timed interval. Local process scheduling and connection handling can differ from staging.

Do not remove or weaken the fence on this evidence. Before any integration, measure a design that safely avoids unrelated mutations invalidating a password snapshot, while covering every relevant writer, policy and credential change, ABA, session and challenge state, schema changes, recovery and relocation. Alternatively, demonstrate admission or retry behavior that meets the real workload budget without overloading the verifier. The existing split proof's unsupported hash policies, step-up, rehash, restore-era, authorization, throttling and hosted-capacity gaps also remain open.
