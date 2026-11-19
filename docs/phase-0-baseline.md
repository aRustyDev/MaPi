# Phase 0 baseline — November 19, 2026

The clean-source baseline is MaPi `12555ef02d60d5ee76f328319dc988db75fc6833` and ZITADEL Nextgen v0.7.0 `b0b74cd4a198428ea9b82910c217259ffc62b65c`. This report describes a synthetic prototype, not a full-parity or production release. The [parity inventory](parity-inventory.md) records the other shipped surfaces and their remaining tests.

## Build and local results

The detached MaPi checkout used Node **26.9.0**, npm **11.19.1**, Go **1.26.9** (selected by the build), Wrangler **4.165.0**, and the committed npm lockfile. `npm ci --offline --no-audit --no-fund`, `npm run build`, and `npm run baseline` passed. The baseline generator replayed the pinned migrations, checked reconstructed schema and rows, checked foreign keys, and verified that projects, users, passwords and sessions were empty. Its generated baseline version is **1**; the application can apply its additive migration to version 2.

The pinned native v0.7.0 binary's Go build metadata reported the Nextgen commit above and `vcs.modified=false`. One synthetic fixture passed the existing shared password, handoff, session and revocation harness against native Nextgen and local workerd. In workerd, injected audit failure rolled back the exchange and its audit/session changes, the handoff remained usable, only one concurrent exchange succeeded, and active and revoked sessions survived object eviction and a full workerd restart. Cross-project rejection also passed. Expected errors from the injected failure are not test failures.

The [real-project recovery test](real-project-recovery-proof.md) passed locally, including audit failure and retry, acknowledged restart and reconciliation, and rejection of restored active and revoked sessions and a pending handoff. Its restore simulates selected rows; it is not Cloudflare point-in-time restore. The independent [recovery-era model](recovery-era-proof.md) describes additional limits.

## Isolated Woven results

Two new Workers in Woven account `4d90c2d31b480584f8f878d2f62848ab` used fresh Durable Object namespaces. The empty-baseline application `mapi-phase0-app-20261119-1815` initially deployed as version `f5639270-b077-4c94-89d8-112ac144fb9f`; its status before provisioning reported `ready=false` and **schema version 2**. The fixture Worker `mapi-phase0-poc-20261119-1815`, version `d49ee51a-ea6e-4531-94c4-159834ce13a9`, passed `test:worker` with the same exported synthetic fixture as native and local workerd, including shared parity, concurrent exchange and 20 additional journeys. The fresh application passed `test:app`. The existing Woven application, issuer and namespaces were not changed.

In the isolated application, a compatible rollback to the initial clean version retained an active session and kept a revoked session rejected. A temporary operator-authenticated test instrument exposed audit counts and handoff mint/exchange only for the rehearsal. A timed Cloudflare point-in-time restore returned the project from four users and 82 audit events to the bookmark's three users and 80 events. Recovery retained three users, advanced the recovery epoch, and produced 83 events including one additional `mapi.recovery.completed` event. After reopening, the previously active and revoked cookies were rejected and the bookmarked pending handoff returned HTTP 400 **31,409 ms after mint**, within the pinned one-minute lifetime. The maintenance deployment was `2002730b-5418-45c0-a427-bbe6a556c614` and the reopened instrumented deployment was `06d13599-f1f4-4f4e-bc80-465bd5c6ed19`. This is a synthetic single-object rehearsal, not proof of the separate multi-project fencing protocol in the local experiment.

After the rehearsal, clean committed-source code was redeployed as version `f9849c4e-8cac-4979-b297-4911c94bbcf4` with the new recovery epoch retained. Status reported `ready=true`, `recoveryReady=true`, and schema version 2; the temporary proof endpoint returned 404. The [hosted recovery instructions](phase-0-hosted-recovery.md) and test-only scripts record the procedure and the exact temporary instrumentation.

## Reproduction

Use a new working directory and a private environment with Node 24 or newer, npm, Go toolchain downloads, loopback networking, and Cloudflare credentials with access to the intended isolated account. The build pins Go 1.26.9 and fetches the exact Nextgen commit. Do not copy fixture, key, cookie, token, or secret files into tracked paths.

```sh
git clone --no-local /path/to/mapi /tmp/mapi-phase0-checkout
cd /tmp/mapi-phase0-checkout
git checkout --detach 12555ef02d60d5ee76f328319dc988db75fc6833
git status --short --branch
npm ci
npm run build
npm run baseline
npm run test:baseline
npm run test:worker
npm run prepare:app-local
node scripts/build-real-recovery-proof.mjs
node scripts/test-real-recovery-proof.mjs
```

`test:baseline` generates one private fixture, exports its pre-test state, and runs the native checks. `test:worker` uses that same exported fixture and the recorded native result. In this run the fixture was originally generated and native-tested in a clean Git archive of the same MaPi commit, then copied privately into the detached checkout; native parity was also replayed there against that same pre-test fixture. The local recovery proof uses a separate synthetic application database. Generated files under `.mapi/`, `.dev.vars.*`, and `worker/generated/` must remain private.

The hosted rehearsal scripts were added after the baseline commit. Copy `scripts/phase0-config.mjs`, `scripts/phase0-instrument.mjs`, `scripts/phase0-instrument.patch`, `scripts/phase0-hosted-recovery.mjs` and `scripts/phase0-timed-recovery.sh` from this worktree into the detached checkout after its clean build, then follow the [hosted recovery instructions](phase-0-hosted-recovery.md). They generate a new named configuration and temporarily instrument only that isolated checkout. Use new names and fresh storage for every independent run.

For the inventory, use a clean Nextgen checkout at the pin and run from the MaPi working tree containing the inventory changes:

```sh
git clone https://github.com/zitadel/nextgen.git /tmp/mapi-phase0-nextgen
git -C /tmp/mapi-phase0-nextgen checkout --detach b0b74cd4a198428ea9b82910c217259ffc62b65c
MAPI_NEXTGEN_SOURCE=/tmp/mapi-phase0-nextgen npm run inventory:check
```

The original check passed for **107 OpenAPI operations and 14 Go adapter mounts** in a working tree that included a separately staged release-build proof. The inventory committed with this report excludes that uncommitted proof and was checked again against the same pinned upstream; it identifies the `buildRelease` comparison as a gap. The inventory identifies untested behavior for each surface and treats the MaPi issuer as an extension.
