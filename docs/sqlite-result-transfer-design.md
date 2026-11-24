# Bounded SQLite results: design and 65-byte feasibility experiment

Status: **experimental and unmounted**. The current production bridge still
fails the 65-nonzero-byte exact-size `RETURNING` regression. The experiment in
`experiments/sql-result-spill/` demonstrates a possible transfer boundary for a
known BLOB; it does not supply the general SQLite type channel, bounded total
memory, or production authority required to close Phase 1.

## Goal and constraints

A result must preserve SQLite storage classes, exact signed 64-bit integers,
REAL values, BLOB bytes, TEXT bytes under a defined invalid-UTF-8 policy,
column names and order, duplicates, statement errors, row order, and transaction
visibility. A write with `RETURNING` must execute once and retain trigger and
audit behavior. Results already returned by `QueryContext` must remain readable
after rollback, including rows that existed only inside the aborted transaction.
A stopped or cancelled consumer must not leave a live write cursor undrained.

The bridge currently serializes a complete result across JS, JSON, Wasm and
Go. Its exact-value encodings can exceed a valid SQLite row's size. The
[SQLite storage API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)
exposes no per-cell storage-class metadata on its cursor, and JavaScript numbers
cannot represent all SQLite int64 values. Adding a type column can exceed the
100-column limit or the row-size limit. Reading the original 100 columns
unchanged therefore does not by itself solve typed arbitrary `RETURNING`.

SQLite's [RETURNING processing-order documentation](https://www.sqlite.org/lang_returning.html#processing_order)
says that a DML statement performs its changes on the first step and accumulates
all returned output in memory before emitting a row. Its output order is not
promised to match write order. Consequently, transferring individual rows in
bounded frames cannot by itself bound SQLite-internal memory for arbitrary
multi-row RETURNING. The candidate needs either a supported engine/runtime
primitive, a rigorously equivalent bounded statement transformation, or an
explicitly approved compatibility limit. A limit is not currently authorized.

## Candidate boundary

1. **Acquire a typed, ordered result without growing its SQLite row.** For
   SELECT, evaluate a non-flattened projection once and emit typed vertical
   cells; prove ordering, volatile functions and connection-local state against
   native SQLite. For DML `RETURNING`, an exact general type channel is still
   missing. A platform cursor that supplies storage class and exact integer
   bytes, or a separately proven statement-specific type authority, could
   supply it. Schema affinity alone is insufficient. Nested triggers and
   `RAISE(IGNORE)` invalidate the tested trigger-sidecar pairing approaches.
   Do not infer types from JavaScript number values, rerun a mutation, or
   enable a constrained-schema prototype as a generic fallback.
2. **Frame each typed value.** A private handle identifies owner, project,
   generation, recovery era, transaction and result. Frames contain row and
   column positions, storage class, byte offset, completion, and exact bytes;
   metadata and frames are bounded, ordered, authenticated and checked before
   use. Empty TEXT and BLOB remain distinct. Numeric formats must be canonical
   and checked for overflow; REAL must not pass through JSON's non-finite
   conversion. A Go consumer can assemble at most the current value, not all
   rows. A platform-provided cursor may itself materialize a full row or more;
   that memory must be measured and bounded separately from frame size.
3. **Preserve results across rollback without making spill authoritative.**
   Copy remaining frames to a separate private durable spill authority before
   the owner's transaction ends; owner SQLite and owner KV writes roll back
   with that transaction. The transfer mechanism must first resolve a separate
   blocker: Cloudflare documents that a SQL cursor held across `await` has no
   snapshot-isolation guarantee, and recommends synchronous consumption. A
   general multi-row implementation cannot assume that awaiting a spill RPC
   while a cursor is live preserves its snapshot. Synchronous owner-side staging
   can roll back with the transaction and can alter `changes()` and
   `last_insert_rowid()` while the cursor is consumed; the current prototypes
   do not solve either issue. A supported snapshot/transfer primitive or a
   separately justified design that preserves these observations is required.
   A write cursor must finish or be safely drained on every error before
   rollback. The caller may consume only its own sealed, authenticated handle;
   an incomplete transfer returns an error. Closing a result, cancellation,
   expiry, restart and failed transactions need durable, idempotent cleanup.
   Bound frames and in-flight buffers; total spill storage remains subject to
   explicit quota, lifetime and cost policy.
4. **Integrate with owner authority and Go.** The current `worker/app.js`
   `#call`, `#withRoute`, synchronous transaction hook and the
   `cloudflarewasm` driver must be redesigned together if host calls suspend.
   Serialize each owner's reactor and maintenance operations, carry immutable
   route/recovery authority through every await, and revalidate before commits.
   A separately durable spill is not a source of project state, cutover proof,
   or permission to bypass the independent encrypted-archive gate. A client
   disconnect or lost acknowledgement can leave a commit outcome ambiguous;
   a protected, move/recovery-aware idempotency design must precede retry.

This is an architectural candidate, not a demonstrated atomic multi-object
transaction or a supported cursor-across-await protocol. See Cloudflare's
[cursor snapshot warning](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/#exec). Do not assume a successful remote spill write rolls back with
owner SQLite, that an RPC cancellation cancels an outstanding call, or that
`MATERIALIZED`/a bounded frame makes SQLite's internal work bounded.

## Local feasibility evidence

Run `npm run test:sql-result-spill-experiment` with the installed matching
Wrangler/workerd. The runner creates local disposable SQLite Durable Objects
and a temporary persistence directory; it does not contact Woven or AWS.
It uses a 100-column DELETE with 512-byte-extended identifiers and the same
8,388,530-byte reserved-tag BLOB with 65 separated nonzero bytes as the known
failing fixture. In each run it verifies the existing `execute` fails with
`SQLITE_TOOBIG` and rolls back business and audit state. Direct SQLite returns
that row. The experiment's table enforces `typeof(value)='blob'`; it checks the
other 99 returned values are NULL. This trusted, fixed fixture is not a generic
type-discovery mechanism. A separate rolled-back local DML probe confirms that
direct JavaScript results for integer `9007199254740992` and
`9007199254740993` collide. Converting integers to decimal text also produces
the same JavaScript value as a TEXT cell containing that decimal string. Both
checks illustrate why an independent type channel is necessary for these
representations; they do not prove that no other implementation is possible.
A local three-row DELETE also confirms that all three delete-trigger effects
are visible before the first RETURNING row is consumed, and that the enclosing
rollback removes them. It does not measure SQLite's temporary memory.

In local workerd, separate commit and rollback runs each transferred and
verified all 8,388,530 bytes through 256 encrypted frames of at most 32,768
plaintext bytes. AES-GCM additional data binds synthetic project, owner,
generation, handle, fixed row/column/type, sequence, offset and total. The
experiment chains ciphertext hashes and authenticates a final seal containing
the frame count, total bytes and final hash. Identical frame and seal replays
are accepted; conflicting replays, writes after seal, premature seal,
out-of-order or missing frames, reordered or modified ciphertext, a modified
seal and a changed generation are rejected. The spill object is intentionally
aborted and recreated after writing; its durable frames and seal remain readable. The rollback case
retains the returned bytes while its business and audit effects roll back; the
commit case records one audit effect. An injected failure after the first frame
drains the write cursor, rolls back, and removes the test spill. These results
exercise one fixed BLOB row, not actual Go `database/sql` or the owner handler.

The whole returned BLOB is still materialized by `sql.exec` in the owner and
the test also holds the input copy. The single-row test awaits while its cursor is live; it does not establish a
multi-row snapshot or override Cloudflare's documented cursor limitation. No
total isolate-memory, peak SQLite memory, CPU, hosted limit or concurrent-traffic
measurement is made. The spill object's
RPCs have no production authentication, keys are ephemeral, and the test has no
TTL, protected cleanup, quota reservation or owner-restart recovery. Neither
the seal nor its key has independently protected authority. The fixture does
not establish that a check constraint is a sufficient authority for arbitrary
SQL. `ctx.abort()` is intentional and only
applies to the disposable local spill object. Never deploy this experiment.

## Required next proof before integration

- Resolve the general DML type-channel blocker at the 100-column and maximum
  row boundaries, with mixed NULL, BLOB, TEXT, int64 extrema and REAL,
  duplicate and long names, and nested/ignored triggers. The 65-byte fixture
  must pass through the actual Go driver without a schema-specific type guess.
- Resolve SQLite's documented multi-row RETURNING output accumulation under
  the required memory bound without changing semantics, or explicitly surface
  any proposed limit for separate approval. Establish a supported
  snapshot-preserving path across asynchronous spill and owner rollback, or an alternative that consumes the cursor synchronously
  without unbounded memory or changed SQLite connection state. Then combine
  typed SELECT and DML framing with the real Go/Wasm driver and owner
  transaction/fence paths. Test escaping rows after rollback, `Rows.Close`,
  cancellation, cursor drain, multiple rows, error propagation, volatile SQL,
  `changes()` and `last_insert_rowid()` against native and workerd.
- Implement and verify bounded authenticated spill leases, independently
  checked owner/era authority, key recovery and rotation, replay and immutable
  seals, lost acknowledgements, quota exhaustion, expiry and safe cleanup after
  both owner and spill eviction. Verify no stale-generation access and no
  cross-project leakage; establish business/audit idempotency on retries.
- Rerun the pinned bridge and migrations, representative interrupted import,
  final-candidate hosted size/startup/load, peak and sampled memory, CPU and
  limit-error gates. Do not treat the local frame size as a hosted resource
  measurement or accept the synthetic spill as an independently held archive.
