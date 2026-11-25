# MaPi Workers + Wasm implementation plan

The [deployment diagram](../../diagrams/mapi-workers-wasm/deployment.html) and [Worker call map](../../diagrams/mapi-workers-wasm/worker-calls.html) describe the target. Start with Hydra alone on an isolated Woven staging deployment. Keep the existing Nextgen login and session authority for the first hosted journey. Use a disposable stock Kratos fixture to repeat the decisive revocation case without requiring a Kratos Worker port.

**Phase 0 is a one-engineer-week, go/no-go spike.** Both gates must pass. The pinned Hydra Wasm must execute real Postgres transactions on hosted Workers. The refresh/revocation race must pass with deterministic ordering, restart recovery, and grant-scoped cleanup. A failed or unverified gate keeps MaPi’s existing issuer on the MVP path. Phase 0 informs the port decision. The later phases have their own release gates.

## Baseline

- The existing issuer has completed browser sign-in against an independent RP, rejected authorization-code replay, and demonstrated hosted two-project isolation. The outstanding runtime and conformance work remains the comparison baseline. [Hosted staging evidence](../hosted-staging.md)
- The current Go/Wasm host is synchronous and has no socket I/O. The earlier local async smoke demonstrated that a Go export can suspend and resume around host calls in workerd. Hosted Hydra, Hyperdrive, and Postgres still need to be exercised together. [WASI host](../../worker/wasi.js#L1)
- Nextgen currently holds refresh rotation and its commit callback in one transaction. The Hydra split puts OAuth state in Postgres and the proposed MaPi fence in Durable Object SQLite. The spike must establish the release ordering across those stores. [Existing refresh transaction](../../upstream/overlay/apps/api/internal/mapioauth/refresh_token.go#L84) · [Refresh race design](../../diagrams/mapi-workers-wasm/refresh-revocation-race.html)

## Phase 0 · Hydra-only spike

### Gate 1 · Run the real Hydra token handler against hosted Postgres

1. Pin the Hydra source and edition, Go toolchain, and Worker compatibility date. Select one disposable Neon database through Hyperdrive, or use an existing isolated Supabase database. Use separate migration and runtime credentials. Run the pinned Hydra migrations outside the request Worker.
2. Put the Hydra request handlers in a private Wasm Worker with a hosted test issuer behind MaPi ingress. Adapt Postgres calls through the Worker host. Keep every operation in a SQL transaction on one connection through completion, and disable query caching for issuer state.
3. Register one confidential client. Use the existing Nextgen login and session validation through a server-side login and consent adapter. Store the trusted issuer, grant, and session binding. Exercise Hydra’s authorization-code and refresh handlers with an independent relying party and S256 PKCE.
4. Measure cold startup, bundle size, CPU, memory, request latency, and database round trips. Retain the hosted deployment and build identifiers in the evidence report.

**Pass** when the deployed Worker runs the pinned Hydra token code against real Postgres, an independent relying party completes login and refresh, and hosted tests demonstrate commit, rollback, cancellation, and concurrent requests. Authorization-code replay must fail. With refresh grace disabled for the spike, two simultaneous uses of the same refresh token must produce one winning rotation. Aim to have Hydra’s actual token handler talking to Postgres on hosted Workers by the end of day two.

**No-go** if the results stop at local workerd, a SQL client smoke test, a mocked Hydra handler, or an unverified transaction boundary. Record a measured runtime blocker if hosted execution cannot finish within the timebox.

[Hyperdrive connection lifecycle](https://developers.cloudflare.com/hyperdrive/concepts/connection-lifecycle/) · [Query caching](https://developers.cloudflare.com/hyperdrive/concepts/query-caching/) · [Existing hosted RP harness](../../scripts/test-hosted-oidc.mjs)

### Gate 2 · Order refresh release against session revocation

Follow the [refresh race sequence](../../diagrams/mapi-workers-wasm/refresh-revocation-race.html) and [state ownership](../../diagrams/mapi-workers-wasm/kratos-session-revocation.html).

1. **Admit the mint.** After Hydra validates the client and resolves the grant, MaPi verifies the bound session. The per-session Durable Object checks its open fence and registers a unique attempt at the current epoch. Derive the tenant, issuer, and session from verified grant metadata.
2. **Mint in Postgres.** Rotate the grant and write the attempt receipt in the same transaction. A rolled-back rotation leaves no committed receipt. Buffer the complete token response and keep raw token material out of durable job state and logs.
3. **Order release and revocation.** The final Durable Object transaction checks the registered attempt and epoch before authorizing release. A MaPi-initiated revocation closes the fence, advances its epoch, and persists the cleanup job in one SQLite transaction. If that wins, Hydra may still commit in Postgres, but the response is discarded and the client receives token-free `invalid_grant`. If release wins, the response may reach the client and the next live check rejects the revoked session. MaPi denies on an unavailable live check.
4. **Reconcile and retry.** Keep unresolved attempts pending until Postgres confirms a commit or confirms a durable cancellation that prevents a late commit. Schedule and re-arm cleanup from the durable record with backoff. Retry under the same job and grant IDs. Mark the job complete only after all earlier mint attempts are settled and Hydra confirms scoped grant revocation. Prove a narrow operation at the pinned edition. Ory documents consent-ID revocation for Hydra Enterprise. A broader subject-wide revoke would violate the isolation gate.

Run the matrix with explicit barriers at the relevant transaction and release boundaries. Record the returned HTTP fields, Durable Object state, and Postgres receipt or cancellation state for each schedule.

| Schedule | Pass condition |
|---|---|
| Revocation before admission | The fence denies the attempt and Postgres has no mint for it. |
| Revocation after admission, before Postgres commit | The final release gate denies. Prove rollback/cancellation or account for a committed mint in cleanup. |
| Revocation after Postgres commit, before release | The receipt exists. Release returns token-free `invalid_grant`. Cleanup invalidates the committed grant. |
| Release before revocation | Tokens may reach the client. Subsequent live access and refresh fail once the fence is closed. |
| Lost commit acknowledgment or restarted Worker / Durable Object | Recover the attempt from durable state. Ambiguous outcomes remain pending and the same mint is not replayed. |
| Cleanup failure, early alarm, or lost cleanup acknowledgment | Recover or re-arm the job. Retry idempotently until older attempts settle and scoped cleanup is confirmed. |
| Same subject and client, different session grant | The second session’s grant still works after cleanup. |

**Pass** when the full race matrix passes for hosted Hydra with the Nextgen session authority, at least the post-commit/pre-release case is repeated with a real stock Kratos session, and scoped cleanup and adjacent-grant isolation are verified. Record hosted and fixture evidence separately.

**No-go** if a losing mint releases credentials, retirement relies on a missing receipt, an orphaned job stays pending without a recovery path, cleanup cannot target the affected grant, or the required hosted outcomes are still unverified.

[Durable Object SQLite](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/) · [Durable Object alarms](https://developers.cloudflare.com/durable-objects/api/alarms/) · [Ory consent-ID revocation](https://changelog.ory.com/announcements/revoke-token-chains-by-consent-request-id)

### Week-one decision

Publish a redacted evidence report with the Hydra pin and edition, upstream patch points, deployment identifiers, results by test schedule, and remaining cost to finish the bearer MVP. Compare those findings with the existing issuer’s remaining work. Advance only if both gates pass and the team accepts the cost of keeping the Hydra patch current.

## Phase 1 · Hydra bearer MVP

Complete discovery, claims, userinfo, JWKS and rollover, logout, and token revocation. Add a second project with an independent issuer, keys, data, and clients. Verify the signed access-token requirement in the pinned edition. Set up an issuer cutover and rollback that preserves existing issuer URLs and accounts for already-issued credentials.

**Exit gate** is a deployed two-project independent-RP run, correct issuer and audience isolation, live session revocation, agreed OIDC conformance, and hosted performance and recovery. Resolve the existing mandatory-S256 profile mismatch before advertising Basic OP certification. Offline JWT validation can continue until expiry; MaPi-managed resources use the live session check for immediate revocation. [MVP roadmap](../../.agents/plans/02-mvp/roadmap.md#exit-gate) · [Conformance findings](../oidf-conformance.md) · [Ory access token behavior](https://www.ory.com/docs/oauth2-oidc/jwt-access-token)

## Phase 2 · Kratos and Zitadel login

Port Kratos behind the session interface. Adapt the official Zitadel login and the selected account journeys to the new backend. Keep MaPi responsible for the Hydra login and consent integration.

**Exit gate** is the hosted lifecycle matrix against the deployed Kratos Worker, including expiry, logout, and revocation originating in Kratos. Exercise the official component end to end.

## Phase 3 · Keto, Admin API, and webhooks

Put Keto behind the permission adapter, add scoped administration, and implement signed webhook ingress with an idempotent private Queue consumer. Preserve the adapter boundary for OpenFGA or SpiceDB.

**Exit gate** includes tenant isolation, delegated authorization and revocation, CSRF protection for cookie-authenticated writes, and webhook replay/redelivery. [Worker call map](../../diagrams/mapi-workers-wasm/worker-calls.html)

## Phase 4 · Talos and optional Oathkeeper

Add API key creation and verification using the selected Talos storage edition. Enable Oathkeeper on selected protected routes for API keys and Admin. The baseline uses zero Upstash bindings and zero Workers VPC Networks. Add scoped VPC Services when a fixed private origin is introduced.

**Exit gate** is equivalent allow/deny behavior with IAP on and off. A denied or unavailable IAP decision stops dispatch on enabled routes. Keep the OAuth and webhook entrypoints on their protocol-specific verification paths. [Deployment diagram](../../diagrams/mapi-workers-wasm/deployment.html) · [Talos storage editions](https://github.com/ory/talos)

<details>
<summary>Implementation context and source provenance</summary>

```yaml
{
  "implementation_context": {
    "task_summary": "Validate a Hydra-only Workers and Wasm port with hosted Postgres and deterministic refresh/revocation races before proceeding to later services.",
    "acceptance_criteria": [
      "Both Phase 0 gates pass on the pinned Hydra build with durable state and hosted evidence.",
      "Scoped cleanup preserves a second grant for the same subject and client."
    ],
    "evidence_provenance": {
      "schema_version": 2,
      "head_commit": "841aecaf1f718a234df20e3af9b786f0d794e23d",
      "generated_plan_path": "docs/plans/2026-11-25-gitnexus-plan-hydra-workers-wasm-rollout.md",
      "global_dirty_digest": {
        "algorithm": "sha256",
        "canonicalization": "gitnexus-evidence-provenance-v2 NUL-framed UTF-8 records",
        "value": "0a9c85780067d9afcd0764f307b60891e3cee927ee11eaeb5ec7826d10fd82cd"
      },
      "cited_path_manifest": [
        {
          "path": ".agents/plans/02-mvp/roadmap.md",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:23f5c18aafae455314d6f10b561f6eddb38e307ee46a7de098c83eb8a1df343f",
          "index_digest": "sha256:23f5c18aafae455314d6f10b561f6eddb38e307ee46a7de098c83eb8a1df343f",
          "worktree_digest": "sha256:23f5c18aafae455314d6f10b561f6eddb38e307ee46a7de098c83eb8a1df343f",
          "untracked_digest": "absent"
        },
        {
          "path": "diagrams/mapi-workers-wasm/deployment.html",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:3cba9e4e01f5ab3fac9da698a3588a3977a5e97ffc2825ef698a362a11e9f5fa",
          "index_digest": "sha256:3cba9e4e01f5ab3fac9da698a3588a3977a5e97ffc2825ef698a362a11e9f5fa",
          "worktree_digest": "sha256:3cba9e4e01f5ab3fac9da698a3588a3977a5e97ffc2825ef698a362a11e9f5fa",
          "untracked_digest": "absent"
        },
        {
          "path": "diagrams/mapi-workers-wasm/kratos-session-revocation.html",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:cf8be6067790a40ae973e4dca7bbc70320bac838d2db15a53f18eb475b73a3b9",
          "index_digest": "sha256:cf8be6067790a40ae973e4dca7bbc70320bac838d2db15a53f18eb475b73a3b9",
          "worktree_digest": "sha256:cf8be6067790a40ae973e4dca7bbc70320bac838d2db15a53f18eb475b73a3b9",
          "untracked_digest": "absent"
        },
        {
          "path": "diagrams/mapi-workers-wasm/refresh-revocation-race.html",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:3961f0f48b8f43de79ac381c5cc75c14573c68ec92562e327cf48d57f361b99d",
          "index_digest": "sha256:3961f0f48b8f43de79ac381c5cc75c14573c68ec92562e327cf48d57f361b99d",
          "worktree_digest": "sha256:3961f0f48b8f43de79ac381c5cc75c14573c68ec92562e327cf48d57f361b99d",
          "untracked_digest": "absent"
        },
        {
          "path": "diagrams/mapi-workers-wasm/worker-calls.html",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:b432a0ed30c30b21ca11e133edf65e5384adae2b6c8cee17c8a9804272f2c3fc",
          "index_digest": "sha256:b432a0ed30c30b21ca11e133edf65e5384adae2b6c8cee17c8a9804272f2c3fc",
          "worktree_digest": "sha256:b432a0ed30c30b21ca11e133edf65e5384adae2b6c8cee17c8a9804272f2c3fc",
          "untracked_digest": "absent"
        },
        {
          "path": "docs/hosted-staging.md",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:61add39fb28beba7368e3fa23c21766770ee291324e09a71b51de6b6cac97d71",
          "index_digest": "sha256:61add39fb28beba7368e3fa23c21766770ee291324e09a71b51de6b6cac97d71",
          "worktree_digest": "sha256:61add39fb28beba7368e3fa23c21766770ee291324e09a71b51de6b6cac97d71",
          "untracked_digest": "absent"
        },
        {
          "path": "docs/oidf-conformance.md",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:730c90c86da6d84dd522241c7aade04cc4c2cf606e525b91c35c826a84b5a4ad",
          "index_digest": "sha256:730c90c86da6d84dd522241c7aade04cc4c2cf606e525b91c35c826a84b5a4ad",
          "worktree_digest": "sha256:730c90c86da6d84dd522241c7aade04cc4c2cf606e525b91c35c826a84b5a4ad",
          "untracked_digest": "absent"
        },
        {
          "path": "package.json",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:5e5711c7dd298bfaa66ab92656844bc267545b8b0928bb7c5319624302a7ff93",
          "index_digest": "sha256:5e5711c7dd298bfaa66ab92656844bc267545b8b0928bb7c5319624302a7ff93",
          "worktree_digest": "sha256:5e5711c7dd298bfaa66ab92656844bc267545b8b0928bb7c5319624302a7ff93",
          "untracked_digest": "absent"
        },
        {
          "path": "scripts/test-hosted-oidc.mjs",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:f70eb8c8b2c73ee10f692d96dd38f995396f6839f620bf4954f052f9b11e59ed",
          "index_digest": "sha256:f70eb8c8b2c73ee10f692d96dd38f995396f6839f620bf4954f052f9b11e59ed",
          "worktree_digest": "sha256:f70eb8c8b2c73ee10f692d96dd38f995396f6839f620bf4954f052f9b11e59ed",
          "untracked_digest": "absent"
        },
        {
          "path": "upstream/overlay/apps/api/internal/mapioauth/refresh_token.go",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:05b9b87d6239dadc519825f8e3522f4dd932bcbe7581524a42abf406604a201b",
          "index_digest": "sha256:05b9b87d6239dadc519825f8e3522f4dd932bcbe7581524a42abf406604a201b",
          "worktree_digest": "sha256:05b9b87d6239dadc519825f8e3522f4dd932bcbe7581524a42abf406604a201b",
          "untracked_digest": "absent"
        },
        {
          "path": "worker/app.js",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:96f939e9447e4422bf445bf5d536b61a377d7dc4fe513f92a7e408c152d944ed",
          "index_digest": "sha256:96f939e9447e4422bf445bf5d536b61a377d7dc4fe513f92a7e408c152d944ed",
          "worktree_digest": "sha256:96f939e9447e4422bf445bf5d536b61a377d7dc4fe513f92a7e408c152d944ed",
          "untracked_digest": "absent"
        },
        {
          "path": "worker/wasi.js",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:db00a5f6c361bb4cf80132c0122179f9459a9fd4e7491912e0064bdfa242f80b",
          "index_digest": "sha256:db00a5f6c361bb4cf80132c0122179f9459a9fd4e7491912e0064bdfa242f80b",
          "worktree_digest": "sha256:db00a5f6c361bb4cf80132c0122179f9459a9fd4e7491912e0064bdfa242f80b",
          "untracked_digest": "absent"
        }
      ]
    },
    "files_to_modify": [],
    "tests": [],
    "verification_commands": [
      "npm run test:oauth-composition",
      "npm run test:hosted-oidc",
      "npm run test:oidc-project-isolation"
    ],
    "assumptions": [
      "Start with one isolated hosted Postgres instance and keep Nextgen login on the hosted spike path.",
      "Use a stock Kratos fixture for the post-commit/pre-release case.",
      "GitNexus served as navigation from a different MaPi worktree. The plan uses direct source and the merged diagrams for its constraints."
    ],
    "open_questions": [
      "Which pinned Hydra storage operation can prove scoped revocation and atomically record a mint receipt?",
      "Can the chosen Wasm host preserve transaction ownership and cancellation through hosted Hyperdrive?"
    ],
    "avoid": [
      "Production traffic and credentials in Phase 0.",
      "Claiming a hosted gate from a fixture or local runtime result."
    ]
  }
}
```

</details>
