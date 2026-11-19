# Isolated Woven OIDC staging

The experimental Worker is `mapi-nextgen-oidc-isolated-staging` in account
`4d90c2d31b480584f8f878d2f62848ab`. Initial version
`c9bac9b3-abce-4f52-b570-bcebeb6b979d` was built from commit `2c9e779` with
an empty SQLite baseline and its own Durable Object namespaces. The current
version `7caf7302-b9cd-4c91-a5fa-f3c05672bf52` was built from commit `d8be610`.
It is an
isolated test deployment, not the existing Woven application or a pilot release.
Public OIDC discovery is disabled pending the selected strict-PKCE profile and
its conformance gates.

The `d8be610` deployment was built from a clean Git archive with an offline
lockfile install and the pinned source and toolchain. Wrangler reported
**54,404.93 KiB** uncompressed upload and **106 ms** startup validation. One
synthetic active and one revoked session in each project retained their state
across the deployment; the active test sessions were then revoked. An
independent RP completed one login per project and code replay was rejected.
The observed first sign-in times were **5.62 s** and **4.09 s**, with
**106,430,464 bytes** of reported Wasm linear memory. These are single smoke
journeys, not p95, total isolate memory, or a fresh load-gate measurement.
The post-deployment simultaneous burst completed 20 measured journeys per
project at concurrency four, alongside 40 successful operator-status reads.
Warm sign-in p95 was **4.58 s** and **5.34 s**, respectively, above the 3.5 s
gate; all 42 code-replay checks were rejected. Both objects reported
**106,430,464 bytes** of Wasm linear memory. These are not total isolate-memory
measurements. Cloudflare's 14:35 UTC metrics bucket, read at 14:39 UTC, showed
sampled maximum memory of **137,503,089** and **137,699,325 bytes**, summed
CPU time of **16.09 s** and **18.49 s**, and zero sampled CPU or memory limit
errors. These CPU totals cover the entire five-minute bucket, including
management reads and other activity, not only the measured journeys. Metrics
can arrive later and the
sampled maximum is not a guaranteed peak. The earlier memory-limit errors and
the current latency failure leave the MVP runtime gate open.

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
Cloudflare's Durable Object periodic analytics later reported aggregate CPU and
sampled isolate memory. In the 05:45 UTC window the primary object recorded
**16 memory-limit errors**, zero CPU-limit errors, and a **231,310,823-byte**
sampled isolate-memory maximum. The 05:55 window reported zero CPU or memory
limit errors and sampled maxima of **137,510,422** and **137,509,884 bytes** for
the two project objects; aggregate CPU in that window was **13.06 s** and
**13.04 s**, respectively. These samples include more than Wasm linear memory
and are not guaranteed peaks. The earlier memory errors mean the hosted
no-limit-errors gate has not passed.

The second isolated origin is `mapi-nextgen-oidc-isolated-secondary`, version
`88e750d8-703c-41e2-bd58-18710bc93de1`, a small Worker that forwards through a
service binding to the same authoritative owner. A distinct project was
initialized at that origin and completed an independent OIDC browser journey.
Simultaneous 20-journey bursts at concurrency four per project completed with
sign-in p95 **3.93 s** and **3.96 s**, respectively, and with 21 rejected code
replays per project. Each object reported **106,168,320 bytes** of Wasm linear
memory. Both sign-in measurements miss the 3.5 s target; this does not establish
total isolate memory.

The hosted two-project browser isolation test passed issuer, audience and
signature checks, foreign bearer and cookie rejection, distinct and same-ID
foreign client-secret rejection, and independent logout. The test provisions
synthetic users and clients that remain in the isolated project databases.

The owner-side RPC optimization in version `3a097ad0-815b-4fba-8360-07beb55127c1`
preserved active and revoked sessions in both projects across deployment. A
subsequent simultaneous 20-journey burst per project measured sign-in p95 of
**5.29 s** and **3.60 s**. Both remain above the target. The second project's
final Wasm linear-memory reading was **106,168,320 bytes**; the primary's final
reading was **38,797,312 bytes**, which may reflect an object restart or eviction
and does not establish its peak. Cloudflare reported a **54,396.37 KiB** upload
and **126 ms** startup validation for this version.

The current public-asset optimization keeps the login JavaScript out of the
project-object queue. In a subsequent simultaneous 20-journey burst per project,
sign-in p95 was **3.65 s** for the primary and **3.34 s** for the secondary;
the primary still missed the 3.5 s target. Both final Wasm linear-memory
readings were **106,168,320 bytes**. Cloudflare reported **54,396.37 KiB** upload
and **86 ms** startup validation. These are single-run observations; sampled
isolate-memory and aggregate CPU metrics are described above.

After the single-call login admission change, a fresh simultaneous burst
measured **3.90 s** and **3.76 s** sign-in p95, respectively. Both projects
completed all journeys and replay checks and reported **106,168,320 bytes** of
Wasm linear memory afterward. Cloudflare reported **54,396.55 KiB** upload and
**91 ms** startup validation. The latency gate remains open.

To repeat the hosted RP test, set `MAPI_URL`, `MAPI_OPERATOR_TOKEN`, and
`MAPI_TEST_USER_FILE` to the isolated deployment and its private synthetic test
user, then run `MAPI_TEST_BURST=1 npm run test:hosted-oidc`. The test creates a
temporary local HTTPS relying party and another synthetic client. Keep its
credentials and temporary files private. Run in a fresh throttle window.

The selected mandatory-S256 policy does not pass the official Basic OP profile;
see [OIDF conformance](oidf-conformance.md). FAPI, recovery at multi-project
scale, the rest of Nextgen
parity and the full hosted performance and security gates remain open.
