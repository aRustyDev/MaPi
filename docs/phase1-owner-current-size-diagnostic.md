# Phase 1 owner: local size diagnostic

An isolated copy of the implementation checkout built the flow, issuer and management owner and measured a local Wrangler dry run. It did not deploy or contact a hosted service. The build does not mount the audit event reader, so it is not a complete Phase 1 candidate.

The copy was made under `/private/tmp/mapi-runtime-diagnostic-SC8GzM`; its `node_modules` and pinned Nextgen checkout were symlinked to the implementation checkout. The existing generated baseline was copied, not regenerated. Source and dependencies were not fully frozen or hashed before and after the run. The working source was dirty, and the unverified baseline exporter/sequence change remains open. These facts limit provenance and prevent treating this as a final release artifact.

With Node 26.9.0 and Go 1.26.9, `GOCACHE=/private/tmp/mapi-runtime-diagnostic-SC8GzM/go-cache GOPROXY=off GOTOOLCHAIN=go1.26.9 npm run build:phase1-owner` completed successfully. The local Wrangler command was:

```sh
WRANGLER_SEND_METRICS=false WRANGLER_LOG_PATH=/private/tmp/mapi-runtime-diagnostic-SC8GzM/wrangler.log \
  node node_modules/wrangler/bin/wrangler.js deploy --config wrangler.phase1-local.jsonc \
  --dry-run --outdir /private/tmp/mapi-runtime-diagnostic-SC8GzM/bundle
```

Wrangler 4.165.0 reported **55,169.28 KiB uncompressed**, **11,085.35 KiB gzip**, and one static asset. The uncompressed total is 1,150.72 KiB below the 55 MiB (56,320 KiB) ceiling. The generated Wasm is 56,101,879 bytes, SHA-256 `8b1fa0a483656221261523778e746fd4aa40001ad5e7675d43443b3b7e964e21`; bundled JavaScript SHA-256 is `797f56b7c4286d6020e9deeece6b79a9ce7d0bd6078f8e2ca26352121b30f390`. The copied `owner-fence.js` and Go row decoder matched the current checkout at `56422cae9627a6ab3885a21c806822e5ea5279a3d1c60f3d412d86f8ee373256` and `b21fe0e6811dc2558586e54ce6974f36245ec3303dea24b5317ee2a93c4507a9` respectively when checked; the copied baseline SHA-256 was `c91d739a66d18c77f837cc334d8e7242aaaaabe6499387703e5ddf067d5ffb98`.

The dry run does not establish platform startup validation, cold start, hosted load or errors, peak isolate memory, audit behavior, independent recovery, or cutover safety. The direct registry archive gate remains unenforced. The earlier interrupted hosted, provenance, benchmark, exact-size and other listed actions were not run or substituted. No Woven deployment or original checkout was modified.

## November 23 follow-up: build after retirement and row-decoder changes

A fresh disposable copy initially failed `npm run build:phase1-owner`: the build script expected an exact old import line after `retireOwnerFence` was added to the application. The script now checks the imports required by its injected control hook rather than requiring an exact full list. A second offline build with Go 1.26.9 succeeded. The local Wrangler 4.165.0 dry run of `wrangler.phase1-local.jsonc` reported **55,170.69 KiB uncompressed** and **11,085.60 KiB gzip**, under the 55 MiB limit by 1,149.31 KiB. The Wasm SHA-256 was `b67b6e6341c2598917575a486d61dc91e7b6f8b1f6a7c4fcfdc96c68146939e2` (56,102,313 bytes), and bundled JavaScript SHA-256 was `b6d1f49bd97532486394909d8de850c3777460beacb360fe17ea21c9ded6d0cc`.

The build copied a dirty implementation tree to `/private/tmp/mapi-owner-progress23-E08zca`, used a copied baseline and symlinked cached Nextgen and Node dependencies, and did not mount the audit route. The copied `app.js`, `owner-fence.js`, Go `rows.go`, and build script matched the implementation checkout when compared after the build. It is diagnostic, not frozen-candidate provenance, hosted startup, load, memory, limit-error, or relocation evidence. No existing Woven deployment was changed.

The same local dry-run bundle passed `node scripts/test-current-owner-routing-miniflare.mjs` in that disposable copy. In local Workerd with synthetic credentials and two in-memory SQLite-backed owners, it checked concurrent secondary provisioning, separate logins for overlapping user emails, and rejection of the other project's session and password. A second run added each project's actual Go-backed management user query and get, rejecting a foreign user ID and foreign project token. A test-only local wrapper obtained synthetic project tokens through the owner's existing private control RPC; the deployed entry has no such HTTP token endpoint. The initial harness attempt followed redirects and failed its 303 assertion; the passing runs used manual redirect handling. This checks local routing and real Go login and management handlers, not browser-to-RP journeys, timed management load, relocation, restart, assets, CPU, isolate memory or hosted behavior.

A later local `node scripts/test-current-owner-routing-miniflare.mjs --load` run used the same bundle, which predates the subsequent chunk-import envelope fix. Both projects completed 20 legacy password-login and session-read journeys in five four-journey waves. Including the session read, local p95s were 2,177.13 and 2,177.53 ms without management, and 2,208.46 and 2,208.65 ms with 40 sequential-per-project management get/query operations interleaved across the waves. Aggregate completion was 3.69 and 3.66 journeys/s respectively. This is a local diagnostic with a different journey and timing endpoint from the hosted browser-to-RP gate; it does not establish cold start, Go-backed operator writes, platform CPU or memory, limit errors, hosted latency, isolation under a move, or candidate acceptance. The existing candidate-specific latency exceptions do not apply to this artifact.

## Follow-up after chunk-envelope fix

An offline build in `/private/tmp/mapi-owner-progress26-oPQU0c` included `worker/relocation-chunks.js` SHA-256 `8f30191903d60bc6d01bd4f4afc1d62653950e956b9db3f745db4af091d9527a`. The same dry-run configuration reported 55,170.68 KiB uncompressed and 11,085.59 KiB gzip. Bundled JavaScript SHA-256 was `9ab027c7915ca28c354cc1f9b4af807f2e54a6a2357040b5775e5451ac212cc6`; the Wasm hash remained `b67b6e6341c2598917575a486d61dc91e7b6f8b1f6a7c4fcfdc96c68146939e2`.

The local two-project diagnostic and both 20-journey waves passed again. Login-plus-session p95s were 2,157.16 and 2,157.46 ms without management, and 2,191.17 and 2,191.32 ms with 40 interleaved management reads; aggregate completion was 3.74 and 3.70 journeys/s. Its scope and the limitations above are unchanged. This build predates the later case-insensitive control-table validation fix and is not final-candidate or hosted evidence.
