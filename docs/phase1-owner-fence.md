# Phase 1 owner route and fence progress

The registry supplies an origin, project ID, object name and generation to owner calls. The owner checks that tuple at Go SQL and transaction callbacks and JavaScript throttle mutations. Reserved, importing and staged destinations reject business requests, including after eviction. A frozen or retired source rejects old tuples. Existing active routes are backfilled to generation 1.

Authenticated private RPCs now reserve a move, arm and freeze the actual source, reserve and prepare a fresh destination, and transfer bounded chunks. The source provides a frozen project manifest; the destination checks its schema, ownership, origin, recovery epoch and foreign keys. The registry itself compares bounded typed digest pages from both owners, atomically persists each page’s count, digest and cursors with its checkpoint, and checks owner attestations before committing the new generation. The authenticated coordinator evidence RPC reads the retained journal in pages, including after a lost acknowledgement or a later move. The registry records completion only after it independently confirms that the destination is active and the source retired. `RelocationCoordinator.advance` is a private Durable Object RPC, with progress held in the owners and registry rather than coordinator memory. It has no public HTTP route. Calls can be retried after eviction; a subsequent move uses a fresh owner and higher generation. Used move IDs, owner names and completed move records are retained.

The `MAPI_FENCE_WRITERS_DRAINED=1` setting is an operator assertion, not a platform proof. Before arming an existing singleton, independently demonstrate that every writer has adopted the fence-aware build and old instances and in-flight calls have drained. A new move first records a durable intent while the route is active, then arms and freezes the source and requires its matching attestation before the registry records the moving state. Until freeze commits, already-held direct calls can still write; after it commits, fence-aware calls reject even while the registry still reports the route active. Snapshotting begins only after the freeze and route transition. A failed pre-freeze check can retain the intent while the route stays active, blocking competing maintenance until the same move is repaired and retried. Legacy moves without the intent need separate reconciliation. Control tokens and bindings must remain private. The local tests cannot establish hosted deployment adoption or prove that every possible out-of-band writer is fenced.

Cloudflare's current [Durable Object code-update documentation](https://developers.cloudflare.com/durable-objects/deployments/durable-objects-code-updates/) makes the drain requirement more specific: an active object can continue accepting requests and storage writes on old code during a deferred update. The default maximum delay is 300 seconds, but an explicit strategy can change it. A new Worker version being deployed to 100% is therefore not proof that the existing owner has adopted it. Deployment changes also [take time to propagate](https://developers.cloudflare.com/workers/versions-and-deployments/), and a version override can select a version present in the deployment even at 0% traffic. Before asserting drain, inventory every owner and caller deployment and its update strategy, exclude old selectable versions and out-of-band writers, independently establish propagation and adoption of the reviewed fence-aware build for the actual owner, and account for in-flight calls. Neither a fixed five-minute sleep nor a point-in-time 100% deployment response alone proves those conditions. A deliberate immediate reset can interrupt requests; rehearse and reconcile retries before using any update strategy. These are required checks, not evidence that the current singleton has passed them.

## Commit authority and writer inventory

The local writer inventory follows these entry points to their persistence
boundary in the bounded Go/Wasm candidate.

| Writer path | Persistence boundary |
| --- | --- |
| User and project admin, management, flow releases, OAuth clients and keys | Owner RPC checks the route, then the Go SQL host checks authority in the statement transaction or Go transaction callback. |
| Flow, SSO challenge, issuer and token paths, login, handoff exchange, session creation and revocation | Routed owner RPCs call the same Go SQL host. Throttle is a separate synchronous JavaScript transaction on the owner. |
| Application audit and Go request-time cleanup | The Go host uses the same check for direct statements and explicit transaction callbacks. A failed in-transaction audit write rolls back with its business mutation. |
| Project provisioning and first activation | Owner checks the pending reservation and object identity. Registry acknowledges the pending fence before active routing. |
| Move, import, schema migration, recovery staging and reconciliation | Separate maintenance entry points check their control authority, route, intent and durable progress. The routine active-owner guard is scoped to business writes. |
| Background and external writers | Candidate source review found no scheduled owner handler. Old scripts, other bindings, outstanding RPCs, and out-of-band PITR require deployment evidence. |

Routine protected Go SQL statements, explicit Go transactions and JavaScript
throttle writes now recheck authority immediately before commit. The active
generation or the pending/recovery authority must still match. SQLite metadata
checks use case-insensitive identifier identity on the control tables. A
disposable owner test injected a throttle-table trigger that changed the
generation. The previous code committed the throttle and generation changes.
With the check, both roll back, the original request authority remains valid,
and a subsequent login succeeds. A native SQLite test also rolls back business,
audit and authority changes in the same transaction.

The local held-call pre-freeze, owner, production-tagged owner and relocation
storage checks passed. The separate real-owner relocation driver still
expects only the older import and reconcile phases. Current coordinator
history verification can return another phase, and the live registry refuses
new cutovers until it has independent archive proof. The full real-owner
cutover is therefore pending. The fail-closed production path remains active.

A read-only Woven inspection on November 24 found 56 token-visible Workers
using the paginated List Workers endpoint, 31 namespaces, and settings for all
56 listed scripts. One direct binding matched the configured staging owner
namespace and no listed service binding targeted that Worker. The configured
owner's active deployment listed one version at 100%. Its version metadata
was dated November 19 and the deployment response did not report its update
strategy. The separate script-search endpoint returned 56 rows without the
pagination metadata required by the benchmark verifier. These observations
establish the visible inventory at collection time. Adoption by the actual
object, old selectable versions, in-flight work, and out-of-band callers
remain unverified. No Woven resource was changed.

### Read-only adoption follow-up

The active configured Woven owner still selected one version at 100%. The
same version was active before and after the read-only check. Cloudflare's
immutable-version module response returned its JavaScript entrypoint and one
Wasm module. Their SHA-256 digests begin `7a50610e0c8a` and `254f17e7dcb2`.
The reviewed #121 bundle begins `7ad9e647418b` and `a92046490a63`.
Both deployed modules differ from the candidate.

The binding's complete cursor traversal returned one stored Durable Object.
Seven bounded daily GraphQL queries on that object attributed 63 requests to
the currently deployed version and two to a different version. The five most
recent daily windows returned zero groups. Stored invocation logs returned
HTTP 403 for the available identity. These aggregates establish historical
execution of the old version. Zero groups leave current in-flight drain
unverified. No probe invoked the owner and no Woven deployment was changed.

The legacy owner has not adopted the reviewed candidate. Adoption and a
recorded in-flight drain remain prerequisites for move authorization. See
[Cloudflare’s version module API](https://developers.cloudflare.com/api/resources/workers/subresources/beta/subresources/workers/subresources/versions/methods/get/)
and [Durable Object code updates](https://developers.cloudflare.com/durable-objects/deployments/durable-objects-code-updates/).

## Isolated Woven upgrade rehearsal

On November 25, 2026, an isolated owner started with the byte-identical
JavaScript and Go/Wasm downloaded from the configured legacy owner's
immutable version. A fresh SQLite namespace was provisioned with a
synthetic schema-v2 project and user. A password sign-in verified the
legacy Go/Wasm path before deployment changed.

A temporary legacy entrypoint kept both legacy modules intact and added an
authenticated RPC to hold real legacy Go user writes before execution.
Both requests were observed in the same running object. Admission closed
before the candidate deployment. After the deployment API listed the
byte-identical #121 Worker at 100%, both old requests were still held.
Their releases occurred after that observation. Following an isolated
rollback, the durable SQLite journal showed two committed entries, both
users could sign in, and there were no active admitted operations.
Deployment request timestamps were unavailable in one API response, so
causal ordering comes from the active-version observation followed by
release. A separate repeat reached the new owner constructor during
release and did not establish both terminal outcomes. A deployment
percentage or a deferred update window alone cannot establish drain.

The direct #121 upgrade rejected the unchanged legacy schema with
`Legacy owner schema requires authorized adoption`. Inspection on the
rolled-back synthetic object identified `mapi_project_origin` as the only
missing table among the four required by that constructor. The rehearsal
checked that the old ledger was terminal, the database was schema v2, and
the project and configured origin matched the synthetic fixture. A
private rehearsal RPC then created and populated only that metadata table
in one transaction.

The exact #121 bundle was activated again. Its candidate-only fence RPC
succeeded at generation 1, the object and project IDs were preserved, and
the old hold RPC was unavailable. A generation-2 write to the generation-1
owner rejected. Four synthetic users could sign in, including both held
legacy writes and a new #121 write. The seed and new user each had one
creation audit event, and the stale-generation user could not sign in.
No relocation or drained-writers flag was enabled.

The configured Woven owner's active deployment ID stayed the same. Both
rehearsals used generated Worker names, isolated bindings, and synthetic
data. The prepared result establishes an upgrade path for that fixture.
The existing owner still requires a reviewed origin-metadata adoption
procedure and its own independently attested writer drain before moves
can be authorized. See [Durable Object code updates](https://developers.cloudflare.com/durable-objects/deployments/durable-objects-code-updates/).

## Recovery

Recovery remains deliberately incomplete. The registry can close a project route, prevent relocation, arm and freeze its owner, and anchor an exact timestamp-clock high-water independently when that clock exists. It refuses recovery during an unfinalized cutover. A per-object recovery epoch map uses canonical lowercase object IDs and guards every listed object, including previously targeted projects after the current target changes. The registry validates every listed entry against its independent anchor and retains a ledger to reject omitted previously deployed object entries on restart; unrelated projects continue. Deployment must retain and verify the complete map on every owner build: a direct RPC to an owner cannot consult the registry synchronously if an operator omits that owner from its environment. The legacy restore and recover RPCs are disabled for all owners, including unfenced objects and objects without a clock table: a scheduled restore must never race a move reservation or erase a fence. There is no production restore/reactivation coordinator, and out-of-band PITR could bypass the code.

Earlier experimental scoped revision allocation takes maxima from individual tables. Those maxima can go backwards when rows are deleted, so scanning a frozen object is not an acknowledged high-water proof. A revision-only durable clock records per-scope high-water marks as part of the corresponding owner write. Once the registry has reserved recovery, the owner is frozen, and the aggregate is anchored, `captureRecoveryScopes` copies every scope and exact int64 value into the independent registry. Each call processes at most 64 rows and a 124 KiB encoded page; indexed lookups materialize one scope row at a time. Recovery identifiers are limited to 128 UTF-8 bytes and the complete RPC response is checked against 128 KiB. A shared validator checks scope kind, arity, project ownership and exact Go `json.Marshal` encoding for recovery and relocation, including HTML and Unicode line-separator escapes. Equivalent noncanonical JSON keys are rejected. The cursor, count and hash chain commit atomically with the rows. An absent, malformed or incomplete clock fails closed. History deleted before clock adoption cannot be reconstructed by this capture.

Recovery scope keys larger than 62 KiB and records that cannot fit the encoded page limit are rejected; these are implementation limits, not SQLite platform limits. The local test exercises 65 scope keys of approximately 61 KiB each and confirms one-row SQL materialization and the RPC envelope bound. It does not measure hosted resource use or prove behavior at all platform limits. The known scope-kind allowlist must be updated and reviewed when the pinned upstream writer graph changes.

`stageRecoveryScopes` is a private RPC gated by the fresh per-object epoch configuration, the drained-writers assertion and `MAPI_RECOVERY_STAGING_ENABLED`. It validates restored scopes in bounded pages, installs a frozen fence at the next generation, and merges each anchored scope with the restored value using the greater int64. A matching hash chain and row count are required at the final checkpoint, and the registry retains the anchors. The owner keeps its old local epoch and the registry keeps its recovering route, so this step cannot reopen traffic. A rejected final page can be retried after its evidence is repaired because its transaction rolls back. If corrupted evidence was committed in an earlier staged page, later digest verification fails closed; no automated stage reset is available. An audited reset/restart procedure must be designed and proven before enabling real recovery. Restored snapshots without both reviewed revision-clock tables also fail closed.

A local-only `advanceRecoveryInvalidation` proof runs after scope staging and checks the frozen owner, recovery epoch and independently anchored scope digest before each Go transaction. It removes at most 64 session checks, session-token rows or attempt challenge rows per call, handles one session at a time through the Go session service, cleans orphan session tokens, revokes one remaining stored credential per transaction through the Go token service, and deletes every pre-recovery authentication attempt after its challenges are removed. This includes verified attempts that have not created a handoff. Each mutation batch emits an audit event in the same transaction; completion emits one recovery audit event. Indexed SQL lookups materialize one ID at a time; IDs above 8 KiB or 64 KiB when JSON-encoded fail closed. It requires both `MAPI_LOCAL_TEST=1` and the separate invalidation enable flag and does not schedule a restore or reopen the route. Local workerd tests cover interruption, lost acknowledgement, audit-failure rollback, stale credentials, orphan tokens and an independent project. This is not an approved production executor: pre-restore in-flight code, no-TokenID credentials, issuer grants and codes, keys, relying parties and other credentials still require an explicit recovery policy and proof before any reopen. Typed legacy no-TokenID credentials remain valid after token rows are removed, and offline JWT verification does not consult owner revocation. See `docs/recovery-credential-policy.md`. The completed invalidation checkpoint rejects a different recovery ID; a future recovery era requires an independently fenced archive/finalization transition that does not yet exist. Its Go export changes the Worker artifact, so hosted size, startup and runtime evidence must be remeasured for any candidate containing it.

The staging tests simulate a restored database locally; they do not invoke PITR. A complete protocol still needs durable restore scheduling and retry state, independently verified deployment of the fresh epoch to every writer and old-instance drain, post-restore identity and full schema reconciliation, bounded session and handoff invalidation, generation and era reconciliation, a registry-controlled reopen, and independent-registry recovery. The old Go recovery function loops over all sessions in one transaction and remains disabled. The new bounded path is local-only and has not been measured at production scale. Real Cloudflare PITR and isolation against out-of-band restore require hosted evidence before any actual recovery.

Local verification:

```sh
node scripts/test-registry-generation.mjs
node scripts/test-registry-move.mjs
node scripts/test-relocation-coordinator.mjs
node scripts/test-real-relocation.mjs
node scripts/test-recovery-epoch-guard.mjs
node scripts/test-recovery-batch-proof.mjs
node scripts/test-owner-fence.mjs
node scripts/test-owner-route.mjs
node scripts/test-app-owner-fence.mjs
node scripts/test-phase1-owner-fence.mjs
node scripts/test-flow-proxy.mjs
node scripts/test-oauth-ingress.mjs
node scripts/test-management-proxy.mjs
```

These tests require npm dependencies and loopback networking; real application tests require `npm run build` and `npm run baseline`, and the Phase 1 owner variant requires `npm run build:phase1-owner`. Workerd logs expected errors for deliberately rejected calls and evictions. The real Go rehearsal transfers a small synthetic project across local objects and exercises frozen-source and importing-destination eviction, interrupted chunking and reconciliation, registry cutover, activation and retirement, a stale caller, and concurrent traffic on another project. It is not the representative large-data import, hosted Woven rehearsal, writer-adoption proof, or authorization for an actual move. See `docs/relocation-proof.md` for transfer scope and outstanding limits.

The relocation manifest currently validates all revision scopes synchronously before transfer. Its hosted CPU and memory behavior on a large project has not been measured; the bounded recovery pagination tests do not establish that result.

The registry now validates reconciliation-page shape before recording matching owner replies: count is 0–64, completion is boolean, digest is a lowercase SHA-256 string, and cursors contain the bridge's non-null text, finite real, exact signed 64-bit integer or canonical base64 blob values. A nonempty page must advance its cursor; an empty completed page may retain its input cursor. On November 23, `node scripts/test-real-relocation.mjs` passed in disposable local workerd. It injected matching malformed replies into both real-owner wrappers, including bad counts, missing progress, malformed digests and integer/blob cursor encodings. For an already-created checkpoint, rejection left the checkpoint, evidence count and frozen/staged owner states unchanged, and a subsequent genuine page advanced once. In-process validator assertions also exercised retained empty cursors, a 64-row page, integer extrema and canonical padded blobs. This test contains expected errors for fault injection and eviction. A malformed first page can still create an empty initial checkpoint; it does not record page evidence or advance it. These checks do not bound RPC envelope size, independently establish that correctly shaped owner responses are truthful, or validate hosted behavior. Existing reconciliation journals need separate provenance; this change does not retroactively revalidate them. The listed `node scripts/test-recovery-batch-proof.mjs` has a separately recorded provisioning failure and is not claimed as passing by this run.

An independent review found that the initial repeated-group base64 regex overflows V8's stack on a valid 8,388,608-character value. The replacement checks the alphabet and canonical pad bits iteratively without allocating a decoded copy. The same local test passed with that valid length and a corrupted character near the end, and also rejects final newlines in integer, digest and blob encodings. The iteration is linear; the surrounding RPC and JSON cursor serialization still materialize values and remain unbounded by this change.

Before a new cutover, the registry now requires both matching owner transfer attestations to carry a 64-character lowercase SHA-256 digest, the form produced by the chunk exporter. Previously any identical nonempty values could pass. The authenticated proof lookup and the transactional compare-and-swap each enforce this; neither independently proves that a well-formed digest reflects the data. `node scripts/test-registry-move.mjs` passes local cases for identical malformed values, unchanged raw route/move rows and other-project routing, a valid retry, owner-proof rejection and acceptance, and the maximum safe generation. `node scripts/test-relocation-coordinator.mjs` and `node scripts/test-real-relocation.mjs` also passed using genuine chunk hashes; their interruption and rejection logs are expected. These local tests do not validate hosted state.

This check applies to new cutovers. It does not revalidate a route already committed under older code: the low-level committed retry remains idempotent even if its stored digest is malformed. The public retry still requires its reconciliation or finalized checkpoint; the local test confirms a legacy committed row without either is refused and not rewritten. A legacy row that already has those checkpoints is not retroactively checked by this change and needs separate evidence and reconciliation. No automatic repair or real move is authorized by these tests.
