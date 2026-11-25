# Bounded SQLite results: design and 65-byte feasibility experiment

MaPi uses a bounded result contract on the pinned Go/Wasm owner. The
hosted runtime measurements are tracked in #4. The separate experiment in
`experiments/sql-result-spill/` remains unmounted.

## Application SQL contract

| Boundary | Limit |
| --- | --- |
| SQLite result columns and names | 100 columns and 128 KiB of UTF-8 column names per result |
| SELECT | 4,096 rows and 4 MiB of logical payload per row |
| Mutation with RETURNING | 64 candidate rows sharing 4 MiB of logical payload, divided equally across the candidates |
| Go snapshot | 8 MiB of framed bytes per result and 24 MiB of outstanding framed bytes per reactor |
| Go/Wasm frame | 32 KiB of reusable transfer space |

A result with more than 4,096 rows or 8 MiB of framed data returns an error.
Use a paginated query when the result would exceed either read limit. The
metadata probe preserves original column names and duplicates. An outer
co-routine reads and encodes the caller's ordered result once. SQL operators
inside the caller's query can require their own working memory.

RETURNING accepts simple column projections on finite INSERT/REPLACE VALUES
lists, the pinned single-row aggregate password insert, and DELETE or UPDATE
of an ordinary rowid table. Before an update or delete, the same synchronous
transaction captures at most 65 candidate rowids. Sixty-five means rejection
before mutation. Admitted statements can affect only the captured identities.
The SQL projection checks the selected row's payload before SQLite appends its
result. The statement transaction rolls back if either the SQL byte guard or
the transfer fails, including when an enclosing Go transaction handles that
error. SQLite's normal trigger, write-counter and rollback semantics apply.

The SQL representation distinguishes exact decimal INTEGER, IEEE-754 REAL,
tagged byte sequences for UTF-8 TEXT and BLOB, and NULL. This preserves signed
int64 extrema and both REAL infinities without depending on JavaScript numeric
type inference. TEXT must be valid UTF-8. The 4 MiB limit leaves space for tags
and record headers under Workerd's SQLite row limit. Go consumes frames from the
owned snapshot after the SQLite transaction ends, releasing chunks on scan
and the remaining snapshot on Close or failure. Application reads require
the framed ABI.

The bridge test covers a dense 4 MiB BLOB returned across 100 columns after
rollback and commit. It also proves rejection at the candidate-row, per-row,
and aggregate snapshot limits. The direct 8,388,530-byte sparse regression
is retained as a diagnostic of the earlier SQL codec. Applications use the
4 MiB result contract.

## Goal and constraints

A result must preserve SQLite storage classes, exact signed 64-bit integers,
REAL values, BLOB bytes, TEXT bytes under a defined invalid-UTF-8 policy,
column names and order, duplicates, statement errors, row order, and transaction
visibility. A write with `RETURNING` must execute once and retain trigger and
audit behavior. Results already returned by `QueryContext` must remain readable
after rollback, including rows that existed only inside the aborted transaction.
A stopped or cancelled consumer must not leave a live write cursor undrained.

For an unrestricted compatibility contract, complete escaped Go snapshots
require scalable backing. SQLite-side type encodings can exceed a valid
SQLite row's size. The
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
explicitly approved compatibility limit. MaPi now chooses the bounded application contract above.

## Alternative for unrestricted SQL

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
8,388,530-byte reserved-tag BLOB with 65 separated nonzero bytes as the prior
regression. In each run it verifies byte-exact readback through `execute` and
rolls back business and audit state. Direct SQLite also returns that row.
The experiment's table enforces `typeof(value)='blob'`; it checks the
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

## Synchronous multi-row staging investigation

The same local experiment now compares a fixed, mixed-type multi-row
`DELETE ... RETURNING` with direct SQLite. Its six-column projection includes
`typeof(v)` and decimal int64 conversion explicitly. Nine rows cover signed
int64 extrema, colliding numeric TEXT, nonempty and empty BLOB, empty TEXT,
NULL, a finite REAL and positive infinity. A nested delete removes one other
row, leaving eight top-level RETURNING rows and nine audit effects. In all
cases the test drains the source cursor synchronously into owner SQLite before
its first spill await, then copies each staged row to the separate sealed spill.
The original row order is checked on spill readback; values and selected
connection-state expressions are compared to the direct statement by row ID.
Commit and rollback runs retain the result after the owner transaction ends.
These are fixed small fixtures; the test keeps their rows in JS arrays.

A `WITHOUT ROWID` staging table avoids changing the observed
`last_insert_rowid()`, but its row inserts change `changes()`. Updating exactly
one staging row per returned row restored `changes()` in this fixed example,
including the nested-trigger case. The inserts and repair nevertheless increased
`total_changes()` by 18 for nine returned rows and 16 for eight; rollback did
not undo that counter. This is an observable incompatibility and the repair
is not a general solution.

A second variant creates one `CREATE TABLE AS SELECT` table per returned row.
For these small local cases it preserved the tested `changes()`,
`last_insert_rowid()` and `total_changes()` values, and its tables were dropped
before commit or disappeared on rollback. However, the tables were visible in
`sqlite_schema` while staging, and their number grew with result count. Schema
side effects, SQLite's own accumulated RETURNING output, synchronous work,
quota, prepared statements, namespace authority, concurrent requests,
cleanup/restart, and memory for arbitrary result sizes remain unproved. The
local staging tables contain plaintext synthetic data and are not a secure
production spill store. A
local attempt to read `PRAGMA schema_version` returned `SQLITE_AUTH`; no schema
cookie preservation is claimed. Neither variant is mounted in the bridge.

On the separate 100-column 65-byte BLOB fixture, a direct DELETE also returned
the BLOB and `typeof(value)` when that type expression **replaced** one of the
fixture's known NULL columns. All remaining projected cells and BLOB bytes
matched. This is not a 100-column type channel: it omits the replaced column,
which could hold a value in a general query, and it does not establish how to
represent all per-cell types without increasing a maximum-size row.

## Typed-frame consumer prototype

`npm run test:sqlite-typedrows-prototype` runs an unmounted Go
`database/sql/driver.Rows` consumer in `experiments/sql-result-spill/typedrows`.
`npm run test:sqlite-typedrows-wasi` compiles and runs the same tests using Go
1.26.9 `wasip1/wasm` in Node's WASI host. The latter is not a Workerd or real
MaPi owner test. Both use synthetic frame sources that assert, rather than
establish, their type and snapshot authority.

The proposed frame includes row and column ordinals, storage class, byte
offset, total length and final marker. Integers and REAL values use eight
big-endian bytes; TEXT and BLOB retain their byte sequences and remain distinct
when empty. The consumer checks ordering, consistent type/length, frame and
row limits, zero progress, scalar sizes, integer precision, NaN, and the row
count supplied from a purported authenticated seal. It rejects malformed,
truncated, extra and replayed rows without publishing a partial destination
row. It consumes at most one row before returning and does not prefetch a
10,000-row synthetic source. The test covers duplicate names, signed int64
extrema, positive and negative infinity, negative zero, invalid UTF-8 bytes,
empty values, reused source buffers, and an 8,388,530-byte BLOB with the
65-byte pattern in a 100-column synthetic row. A `database/sql` test uses a
fake driver, not the application driver or an actual SQLite transaction.

Frame, cell, row, column and metadata bounds are supplied by the caller only
for this prototype; they are not approved production limits. The consumer can
hold a complete row, and decoding TEXT can temporarily copy a value. Its source
may allocate before yielding a frame. No isolate peak, SQLite internal memory,
cancellation, concurrent `Close`, spill authority or real source is measured.
A supplied type or row count is not proof: the source must authenticate the
seal and each frame's complete context, and must produce a consistent snapshot
and exact SQLite types before this consumer could be integrated.

`npm run test:sqlite-typedrows-workerd` builds this consumer into a test-only
Go 1.26.9 WASI reactor and runs a disposable local Workerd SQLite Durable Object.
The producer executes one `DELETE ... RETURNING` with three SQL output columns:
a known small integer ID, `typeof(v)`, and a value expression that converts
integers to exact decimal before framing. It synchronously supplies the resulting
two logical cells to Go in JSON/base64 frames. The fixed fixture includes ten
rows with dynamic NULL, integer, REAL, TEXT and BLOB values, int64 extrema,
positive infinity, empty values and the 8,388,530-byte BLOB pattern. Go
`database/sql` scans and checks all rows before the source transaction ends.
A nested-delete variant emits nine rows while recording ten delete effects.
Commit and rollback both pass; deliberately corrupt, truncated and extra
streams fail and drain the cursor before rolling back business and audit rows.
An early Go `Rows.Close` also drains the source before rollback.
The test compares the owner schema before and after; the transport itself
creates no staging tables. Its largest JSON frame was 43,778 bytes and the
largest observed Wasm boundary sample was 592 pages. These are local samples,
not total isolate or SQLite peak memory.

This is a restricted proof: the producer consumes an extra SQL type column,
the expected row count is a fixture constant rather than an authenticated
seal, the near-limit BLOB is a three-column result, and Go consumes rows
before transaction completion.
It does not establish a general type channel, escaped `Rows` after rollback,
secure spill, real application integration, or a bound on SQLite's own
multi-row RETURNING accumulation.

## Further proof for an unrestricted transport

- Resolve the general DML type-channel blocker at the 100-column and maximum
  row boundaries, with mixed NULL, BLOB, TEXT, int64 extrema and REAL,
  duplicate and long names, and nested/ignored triggers. Retain the passing
  65-nonzero-byte Go/Wasm regression when changing the bridge.
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
