# Hydra Phase 0 evidence and issuer comparison

The isolated November 25, 2026 spike passed its hosted functional gates with Hydra OSS v26.2.0 and a real PostgreSQL service. The evidence supports continuing the Hydra investigation and a proposed go decision. It does not establish production readiness or a measured engineering-time saving. [Proposed decision](hydra-adoption-decision.md) · [Tracking issue #136](https://github.com/aRustyDev/MaPi/issues/136)

## Configuration and provenance

Hydra was pinned at `0b84568fffccf151dc5e6c7955fdfb738555bf4b`, built with Go 1.26.9 for `GOOS=js GOARCH=wasm` and Binaryen 133, with Workers compatibility date `2026-11-25`. The final hosted handler version was `d00af66e-e08e-463f-a4af-b900e6b88be9` and its private caller version was `98f858d8-9b60-4f67-b54c-575cd9abec24`. The exact uncompressed upload was 64,274.37 KiB, with 13,110.22 KiB gzip and 116 ms platform startup validation. Resource names, account and binding identifiers, addresses, and credentials are omitted.

The private Hydra Worker used Hyperdrive to a dedicated Neon PostgreSQL database, with issuer-state caching disabled and separate runtime and migration roles. Nextgen handled login and session validation. The build adapts Hydra's handler and transaction seams, adds a receipt in the token transaction, and bridges pgx through request-scoped JavaScript sockets. A Durable Object fence tracks attempts and cleanup, and reconciles against Postgres before releasing or revoking a grant. [Reproducer and build inputs](../experiments/hydra-phase0/README.md)

## Hosted functional evidence

An independent relying party completed official Nextgen login, Hydra authorization, S256 code exchange, signed ID-token verification, and refresh. Authorization-code replay was rejected. The tested Postgres paths covered commit, forced rollback, cancellation, and two concurrent uses of the same refresh token with one winner.

| Schedule | Recorded result |
| --- | --- |
| Revocation before admission | Denied without registering a mint attempt. |
| Revocation after admission, before commit | The forced rollback left no committed receipt and reconciliation recorded cancellation. A separate client abort was cleaned up without token release. |
| Revocation after commit, before release | A committed receipt existed. The response returned token-free `invalid_grant`, scoped cleanup removed the affected tokens, and an adjacent grant remained usable. |
| Release before revocation | Tokens were returned. After real Nextgen logout and fence closure, refresh and the live protected-resource check denied the session. |
| Restart or lost commit acknowledgment | A Durable Object abort and an injected lost acknowledgment were reconciled from the committed receipt without releasing credentials. |
| Lost cleanup acknowledgment | The alarm retried scoped cleanup and an adjacent grant continued to rotate. Fence closure was injected before real logout in this schedule. |
| Early alarm | Cleanup waited for a pending attempt to settle and completed without releasing tokens. An initial assertion requiring a second alarm failed; the corrected assertion passed on a fresh grant. |
| Stock Kratos after commit | A local Kratos v1.3.1 session was revoked while Hydra and Postgres were hosted. The driver explicitly closed the fence; the losing refresh returned no tokens and cleanup completed. |

The matrix used real hosted Nextgen sessions, with grants created by a native Hydra fixture and linked through a private test endpoint. The separate browser journey used hosted authorization and browser-bound grant linking. Fault injection was enabled for the spike. The temporary Nextgen fixture stores a raw session cookie in a private Durable Object, deletes it on logout, and schedules deletion after 30 minutes. A production session adapter must replace this fixture. Kratos-originated fence propagation is unproven and tracked in [#129](https://github.com/aRustyDev/MaPi/issues/129).

## Runtime and unresolved observations

Three fresh-isolate discovery requests took 1,309, 2,144, and 1,771 ms from the client, with platform invocation wall times of 733, 1,160, and 961 ms. Three no-database cold-minus-warm controls were 1,034, 514, and 626 ms. These small samples include dispatch or network effects and do not establish latency percentiles. A single browser journey took 13,191 ms on the final redeployment. Across 67 instrumented samples, Wasm linear memory was 45,613,056–47,448,064 bytes, excluding other isolate memory. The 62.77 MiB upload exceeds the project's 55 MiB uncompressed per-Worker gate in [#49](https://github.com/aRustyDev/MaPi/issues/49). The same exact candidate and full deployment graph need qualification.

Successful instrumented calls recorded Worker-to-Hyperdrive synchronization cycles of 6 for one discovery, 10 for one client-credentials token, 31 each for 11 code exchanges, and 27 each for four refreshes. Isolated Neon statement counts for three code exchanges and three refreshes were 18 and 14 executions each. Hyperdrive sampled query latency averaged 2 ms for a short discovery window. These are different measures. Exact Hyperdrive-to-Neon physical wire round trips remain unknown.

Several RPC events were labeled canceled despite correlated successful caller responses. Some future alarm events were canceled without handler logs. The platform causes remain unresolved. The historical 20-second timeout did not recur and retained evidence narrows its location without identifying its cause. Subsequent recovery and matrix checks passed, with no load-test claim. No provider-side wire capture was available.

## Remaining work against the same MVP

| Area | Existing MaPi issuer | Hydra path |
| --- | --- | --- |
| Protocol core | Code exchange, S256, signing and JWKS have native, workerd and hosted smoke evidence. Userinfo, refresh, revocation and logout have local proofs. | Actual hosted Hydra code exchange and refresh passed. Complete MaPi discovery, claims, userinfo, signed access-token profile, JWKS rollover and logout. |
| Sessions and isolation | Two-project hosted smoke passed. Repeat full independent-RP journeys and immediate revocation on the final candidate. | Replace the raw-cookie fixture, wire authoritative Nextgen validation and fence, and prove two-project issuer, key, client and data isolation. |
| OIDC conformance | The local Basic OP exploration passed 2 of 35 attempted modules. Mandatory S256 conflicts with common suite requests. Resolve the qualification profile and rerun the agreed suite. | Select and run the same applicable qualification route. Mandatory S256 and Basic OP profile claims still need resolution. |
| Runtime and recovery | Qualify the exact candidate against #49, key rollover, recovery, operational safeguards and pilot sign-off. | Reduce and measure the complete Worker composition against the same gates, repeat the race matrix and recovery, and rehearse credential-aware cutover and rollback. |
| Maintenance | Own MaPi's issuer extension and protocol updates. | Own Hydra version and security updates, patch rebases, the Go/Wasm and Postgres bridge, and their regression qualification. |

The current issuer's sign-off gates remain open in [#50](https://github.com/aRustyDev/MaPi/issues/50). Hydra work is decomposed in [#128](https://github.com/aRustyDev/MaPi/issues/128). The functional evidence has moderate confidence for the recorded schedules, low confidence for capacity and cold-start generalization, and no quantified confidence in comparative delivery estimates. A proposed recommendation and explicit ownership needs are recorded in [the decision draft](hydra-adoption-decision.md).

## Reproducer verification

The pinned build and local Durable Object fence probe passed from the publication checkout. A disposable local PostgreSQL/workerd run passed discovery and synthetic token issuance after the probe's missing `session-fence.mjs` module was added. An earlier run returned HTTP 500 on discovery and a later run exceeded the original 30-second local probe timeout. These local startup failures remain unexplained. The probe timeout is extended to 120 seconds for the published fixture, and hosted readiness and capacity remain release qualifications.
