# SQLite bridge contract matrix

The upstream pin is Nextgen v0.7.0 at `b0b74cd4a198428ea9b82910c217259ffc62b65c`.
The native oracle was run in the pinned build checkout with the MaPi overlay
and audit patch applied. From its `apps/api` directory:

```sh
GOWORK=off GOTOOLCHAIN=go1.26.9 go test -count=1 -tags sqlite_integration \
  ./internal/storage/stmttest ./internal/storage/dialect/sqlite \
  ./internal/storage/dialect/sqlite/migration
```

All three native packages passed. Run `npm run build` and
`npm run baseline`, then `npm run test:sqlite-bridge` from MaPi. The
bridge harness initializes a disposable workerd object with the generated
pinned baseline and invokes real `sqlite.NewCloudflarePool` statements
through the Go/Wasm bridge.

| Pinned coverage | Native | Workerd |
| --- | --- | --- |
| Pinned `stmttest` functions | Passed | 283 of 285 passed in the latest run; the other two are the native lock schedules below |
| `TestProjectCRUD`, create/get/update/delete | Passed | Adapted bridge assertions passed |
| Migration SQL Up/Down/Up for all 39 versions, including seeded `TestSearchTextBackfill` and `TestSearchEntriesBackfill` assertions | Passed | Original pinned statements pass through the bridge with the migration 33 rewrite described below |
| `TestMigrationsRoundTrip` schema snapshots | Passed for columns, foreign keys and indexes | Adapted snapshots also compare `CHECK` expression tokens; per-version Down checks passed with upstream-known default deltas and final schema matched native baseline |
| Native SQLite connection and locking tests | Passed | Two native multi-connection schedules cannot run faithfully in the synchronous WASI runner; the separate owner-call observable result passed as described below |

Run the original `stmttest` functions, without changing their assertions, in
disposable workerd objects with:

```sh
GOCACHE=/private/tmp/mapi-phase1-go-cache node scripts/test-upstream-sqlite-wasi.mjs
```

The runner archives the pinned source, applies the overlay and audit patch,
and supplies test-only WASI open/seed/nullability adapters. Each function
runs in its own object. The JSON result includes the test logs and simulated
timer-poll count. In recent runs five passes used simulated WASI timer waits:
workerd cannot block in a synchronous host import, so those passes do not
establish real scheduling or elapsed-time behavior. The original native
connection-lock tests cannot be interpreted as workerd failures or passes.

The runner now requires an exact top-level Go `RUN` and `PASS` marker as well
as exit code zero for the selected suite, concurrent-owner, and bulk tests.
`node scripts/test-upstream-sqlite-test-result.mjs` checks that absent, skipped,
similarly named, failing, and nonzero-exit results do not count as passing.
These are local result-classification tests; the owner-concurrency run with the
new check was aborted before dispatch and has not been rerun. Earlier reported
results above used the preceding runner and are not newly verified by this
change.

IDP, application and policy revisions, JSON schemas, flow definitions,
password history, origin insertion, users, teams, projects and event cursor
ordering derive ordered
timestamps inside the mutation transaction. A durable per-scope high-water
survives deletion of retained rows, while a separate aggregate records the
maximum for diagnostics and recovery coordination. The aggregate is never an
allocation floor, so a future timestamp in one scope does not shift another.
Both tables initialize atomically; missing or malformed halves fail closed.
Bootstrap scans retained rows but cannot reconstruct values deleted before
deployment. Project creation order is scoped to one database, not independent
project objects. The local clocks can still rewind under PITR: the registry's
aggregate anchor cannot reconstruct per-scope values. Guarded legacy
restore/recover is disabled pending independent per-scope capture and
reconciliation; out-of-band PITR and old-code draining require operational
controls. Run bootstrap, scope isolation, rollback, retry, returned timestamp,
overflow, deletion and malformed-schema tests with `MAPI_REVISION_CONTRACT=1
MAPI_FREEZE_TEST_CLOCK=1 MAPI_STMTTEST_FILTER='^TestMaPiRevision|^TestMaPiScopedWriters|^TestMaPiPasswordClock'`
followed by the command above.

The frozen-clock `TestMaPiUserStaleGuardAndDeactivation` and
`TestMaPiEventCursorDeletionAndRollback` cover stale user writes, direct and
team deactivation, retained-event deletion, sink-cursor bootstrap, rollback
and overflow. The concurrent-owner test issues two user patches using the
same expected version and accepts exactly one. A separate local synthetic
10,000-user team deactivation took 3,119 ms wall time including the owner RPC
and Go test startup; it verified all rows and scope records and encountered
no SQL bind-limit error. Run it with `MAPI_BULK_DEACTIVATION=1
MAPI_BULK_USER_COUNT=10000 MAPI_STMTTEST_FILTER=^TestMaPiBulkSeed$` followed
by the command above. This is not a hosted CPU, memory, or limit measurement,
and it does not include a representative 100,000-event fixture.

The host's wall clock is `Date.now()` at millisecond precision. An unchanged
one-nanosecond SSO-expiry assertion sometimes failed on the previous code; a
separate frozen-clock test reproduced it with no simulated timer polls. The
WASI build now applies a conservative one-millisecond margin only to
`AuthAttempt.IsExpired`: attempts may expire up to one millisecond early.
The native behavior, token and session expiry, and generic wall-time reads
are unchanged. With a frozen platform clock the margin cannot bound staleness
beyond the clock's granularity. Run the frozen-clock boundary and original
SSO test with `MAPI_EXPIRY_CONTRACT=1 MAPI_FREEZE_TEST_CLOCK=1
MAPI_STMTTEST_FILTER='^TestMaPiAuthAttemptExpiryPrecision$|^TestAuthAttemptStatements_SSOState$'`
followed by the command above. The test checks 1 ns, just under, exactly at,
and just over 1 ms, a five-minute TTL, nil TTL, and an uninitialized attempt.

The two unsupported native lock schedules are
`TestIDPConnectionStatements_LockSerializesRevisions` and
`TestUserPasswordStatements_SetWaitsForConcurrentSet`. Their workerd
observable equivalent passed with concurrent independent calls to one
disposable SQLite owner, using the real Go transaction and statement methods.
Both calls commit, the second IDP revision reads the first, the newest
revision is the second, and password history retains both writes and the
initial hash with the last writer current. Run this separately with
`MAPI_OWNER_CONCURRENCY=1 MAPI_STMTTEST_FILTER=^TestMaPiOwnerSeed$` followed
by the command above. This does not simulate a deliberately held native lock.

Before the scoped revision change, an explicitly experimental scratch-only global logical clock gave 283/285,
but changes expiry-sensitive clock reads and has no recovery high-water
fence. It is not enabled in the application and is not a passing product
result. A production revision allocator needs stamping inside the serialized
mutation, bootstrap above relevant persisted stamps, rollback-safe allocation,
relocation transfer, and a fenced independent-registry high-water reconciliation
before reopening after PITR. These properties are not yet proven.

The WASI compiler replaces substring LIKE patterns with equivalent literal
`instr`/`substr` expressions to avoid workerd's 50-byte pattern limit. A
workerd differential test checks short inputs against the original pinned
LIKE expression, including case, wildcards, Unicode and NUL, and checks long
literal patterns. Run it with `MAPI_MATCH_CONTRACT=1
MAPI_STMTTEST_FILTER=TestMaPiSubstringAgainstPinnedLIKE` followed by the
command above. The native compiler remains unchanged. The workerd
`CheckAuthzProjects` implementation issues bounded per-project checks within
one transaction instead of one statement with more than 100 binds; the
original `TestSearchAcrossProjectsStatements` passes through it. The
application sets SQLite's case-sensitive LIKE pragma to match native SQLite.

The bridge-specific harness additionally checks persisted signed 64-bit
extrema and nanosecond timestamps, typed null/real/text/blob values, numbered
parameter reuse, affected rows, nested transactions, panic and constraint
rollback, retry, the 100-parameter boundary, and rejection of an unsupported
write with `RETURNING` before it can mutate data.

The pinned migration 33 backfill has six UNION ALL arms in one compound query.
Workerd rejects the original statement with `too many terms in compound
SELECT`. The SQLite bridge nests the arms in two three-arm subqueries and checks the
upstream seeded backfill rows before and after Down/Up. The live application
initializes from an already-migrated baseline, so applying migration 33 to an
existing live database still requires a production migration entry point.
The test injects a failure during migration 29 Down and checks the data and
version ledger roll back before retry. Each Down is compared to its pre-Up
table columns, foreign keys and indexes, allowing the upstream-known default
differences for `user_passwords.changed_at` at 13,
`user_passwords.updated_at` at 14, `projects.preview_origins` at 19 and
`user_attributes.team_id` at 26. After all 39 migrations the same metadata
matches the reconstructed native baseline. A separate inventory compares stored
view and trigger definitions after each Down and against the final native
baseline. The pinned native baseline and each captured workerd Up/Down snapshot
contain zero application views or triggers, excluding test and runtime internal
objects; this is an absence check, not execution or behavior coverage of view
or trigger definitions. The local native snapshot test uses synthetic objects
to check detection of altered and removed definitions. The snapshot also compares conservatively tokenized `CHECK`
expressions after each Down and against the final native baseline; the latter
contains 100 expressions across 41 of 54 application tables. This recognizes
quoted strings and nested parentheses without treating whitespace inside a
string as insignificant. It compares expression tokens, not general SQL
semantic equivalence, placement, conflict clauses, or actual constraint
enforcement. `node scripts/test-sqlite-bridge-schema.mjs` tests the snapshot
on local native SQLite, and the expanded `npm run test:sqlite-bridge` passed
all 39 pinned migration rounds in disposable workerd.

An earlier snapshot comparison collapsed whitespace throughout explicit index
definitions, including inside string literals. It could therefore miss a
changed partial-index predicate or expression. The index definition is now
compared as tokens that retain literal whitespace. The shared tokenizer also
preserves non-ASCII characters in unquoted identifiers and treats a carriage
return inside a `--` comment as part of that comment. Real local SQLite
regressions distinguish both index and `CHECK` expressions involving a
non-breaking-space identifier, as well as comment and literal changes.
`node scripts/test-sqlite-bridge-schema.mjs` and a fresh
`npm run test:sqlite-bridge` passed, including all 39 migration rounds. The
token comparison is conservative; it does not establish full SQLite lexical
or semantic equivalence, constraint enforcement, or index behavior under
query execution. Earlier results used the less precise comparison.

The snapshot now also compares each generated column's expression. SQLite's
`table_xinfo` reports whether a column is virtual or stored but does not
include the expression, so the earlier snapshot could miss a changed computed
value. The comparator binds each expression to its column name and fails if a
reported generated column cannot be found. Native SQLite tests cover nested
functions, multiple columns, swapped expressions, quoted names and literals;
`node scripts/test-sqlite-bridge-schema.mjs` passes. The local workerd
`npm run test:sqlite-bridge` suite also passes all 39 migration rounds with
the expanded snapshot. As with other schema token checks, this compares stored
syntax rather than proving arbitrary semantic equivalence or hosted behavior.

The snapshot also compares tokenized column and table definitions containing
top-level `REFERENCES`, in declaration order, and rejects a mismatch between
their count and `foreign_key_list` constraint groups. Multiple inline
references in one column definition are counted separately. SQLite's `foreign_key_list`
does not report deferrability: otherwise identical snapshots could overlook
the difference between an immediate foreign key and one checked at commit.
The focused native test demonstrates that the deferred form permits inserting
a child before its parent within a transaction while the immediate form
rejects the child. It covers inline and composite table constraints, quoted
identifiers, explicit immediate and deferred clauses, comments, quoted
text that is not a foreign-key declaration, and missing metadata. Run
`node scripts/test-sqlite-bridge-schema.mjs`. A separate narrowly scoped
`node scripts/test-sqlite-migration-snapshot.mjs` passed all 39 pinned
Up/Down/Up rounds, seeded backfills and rollback in disposable local workerd.
It checks the generated migration fixture against the pinned source, reads the
existing baseline, and invokes only the migration endpoint; it does not run
the broader Go bridge or other boundary tests. The definition comparison is
deliberately conservative: it may distinguish semantically equivalent syntax
and is not a general SQLite parser or proof of workerd foreign-key enforcement.
The local native behavioral check does not establish hosted behavior.

The schema snapshot now also records `PRAGMA table_list`'s `wr` and `strict`
flags, and fails closed if table metadata is missing, duplicated, malformed,
or disagrees with `table_xinfo` on the column count. Previously an ordinary,
`WITHOUT ROWID`, and `STRICT` table could have identical recorded snapshots.
`node scripts/test-sqlite-bridge-schema.mjs` uses real native SQLite to show
that `WITHOUT ROWID` removes the rowid and that `STRICT` rejects a text value
for an integer column; it also exercises the metadata failure cases. The
migration-only `node scripts/test-sqlite-migration-snapshot.mjs` passed all
39 pinned Up/Down/Up rounds, seeded backfills and rollback in disposable local
workerd with this comparison. It invokes only the migration endpoint; it does
not prove hosted behavior or general SQL schema equivalence.

The snapshot also uses a null-prototype table map. A real native SQLite test
confirmed the former normal-object map silently omitted a table named
`__proto__` when serialized; the regression now verifies that both
`__proto__` and `constructor` are own entries in the serialized snapshot.
The migration-only workerd/native comparison passed again after this change.
The pinned migrations themselves do not create these identifiers, so the
workerd run establishes compatibility with the new map rather than directly
testing an adversarial table name inside workerd.

The internal-name filter now checks the literal, ASCII-case-insensitive
`sqlite_` prefix. Its previous `LIKE 'sqlite_%'` pattern treated the underscore
as a wildcard, omitting legal user tables, views and triggers such as
`sqliteXrecord`. A native SQLite regression verifies these names remain in the
snapshot, that an index with the same prefix is retained, and that actual
`sqlite_sequence` remains excluded. The focused schema test and migration-only
39-round native/workerd comparison passed after the correction. The pinned
schema does not contain these adversarial names, so this is not a workerd test
of those names or a hosted result.

## Local workerd SQL limits and wide results

Run `npm run test:sql-limits` with loopback networking available. The test
uses the actual `worker/sql.js` bridge against a disposable SQLite Durable
Object. The prior two-column value/type encoding failed on 51 or more result
columns even though local workerd accepted 100. Wide results now use one
tagged value per output column, leaving BLOBs binary. Narrow results retain
the original path. Local workerd verifies 100-column SELECT and INSERT
RETURNING with both signed 64-bit extrema, integer-like text, NULL, REAL,
BLOB, embedded NUL, non-BMP Unicode, malformed JSON-like text and duplicate
column names. An insert trigger proves wide RETURNING executes once. A
51-column result also round-trips an 8,000,000-byte BLOB and an
8,000,000-byte text value. Prefixing wide text adds one SQL byte, so a text
value exactly at the underlying SQLite maximum could be rejected; no exact
hosted maximum-width text result has been established. The change does not
establish bounded memory for arbitrarily large multirow results.

The local test measures SQL UTF-8 bytes after both numbered-bind and result
rewrites: a 100,000-byte SELECT and a 100,000-byte write with RETURNING pass,
while the respective 100,001-byte rewritten statements are rejected. The
rejected write is run after a business insert in one transaction and leaves
neither that row nor an audit row. An oversized BLOB insertion is also tested
after business and audit inserts in a single transaction; neither earlier
insert survives. The input statement can be smaller than
100,000 bytes when the bridge adds casts or projection wrappers. A direct
100-column table passes and 101 columns fail; 50-byte LIKE and GLOB patterns
pass and 51-byte patterns fail locally. A 1 MB and 8,000,000-byte BLOB write
pass, whereas the local `zeroblob` insertion at 8,388,638 bytes fails. These
are local workerd results for the specific test schema, not a portable claim
about all table-row overhead or hosted limits.

The local SQL-limit probe also exercises `WITH ... INSERT ... RETURNING` with
the minimum signed 64-bit value. It observes one bridge SQL execution, one
business row and one trigger-created audit row; an injected enclosing
transaction failure rolls back both rows before the successful retry. This
case does not cover exact-size results, bounded result materialization or
hosted behavior.

Cloudflare currently documents 32 SQL function arguments for Durable Object
storage, but this local workerd accepted a 33-argument `printf`; it also
accepted 127 and rejected 128 during an exploratory probe. Do not infer the
hosted limit from the local result. Test the pinned application's reachable
functions against the documented hosted limits before claiming platform
parity. See [Cloudflare Durable Objects SQL limits](https://developers.cloudflare.com/durable-objects/platform/limits/#sql-storage-limits).

After the wide-result change, the original pinned `stmttest` workerd suite was
rerun without the experimental logical clock. It again reported 283/285: the
same two native held-lock schedules failed, with no changed test outcomes
versus the saved prior run. Five passing functions used simulated timer polls.
`npm run test:sql-bind` and `npm run test:sqlite-bridge` also passed. This is
local evidence, not a hosted limit or locking-equivalence claim.

### SQL query safety and remaining result-boundary work

The query-mode lexer now ignores comments and quoted tokens when deciding
whether a statement has `RETURNING`, rejects additional SQL statements before
execution, and parses the main verb after CTE definitions. Tests cover keyword
prefixes in Unicode identifiers and ASCII-only SQLite keyword folding. A
zero-row metadata probe preserves placeholders and duplicate column names
without stepping a source row. A materialized result CTE prevents SQLite from
re-evaluating volatile source expressions; tests cover mixed random values and
rejected writes leaving both business and audit rows unchanged.

These correctness fixes do **not** establish bounded production result
materialization. The current bridge still buffers the entire result as JS
objects, JSON, Wasm memory and Go values. The materialized CTE can itself
reject a valid platform value: a local direct SELECT returned 8,388,608 bytes
of TEXT, while a 51-column materialized CTE containing that value failed with
`SQLITE_TOOBIG`. Wide text tagging can also add a byte. These are open
compatibility issues; no low application result limit has been introduced.

`GOCACHE=/private/tmp/mapi-phase1-go-cache node scripts/test-cursor-prototype.mjs`
runs an **isolated, non-production** Go 1.26.9/WASI and workerd feasibility
probe. Within one synchronous owner transaction, Go receives an 8,000,000-byte
BLOB in 245 frames (maximum JSON frame 43,746 bytes) and consumes 10,000
INSERT RETURNING rows. Handles are scoped to a transaction and stale handles,
including those from a prior generation, are rejected. An injected Go error
is followed by draining the cursor and transaction rollback: no returned
inserts survive. An undrained write cursor caused an internal workerd error in
an exploratory probe, and a cursor from an already-rolled-back transaction
could still expose rolled-back rows. A write cursor must therefore never be
made available after its transaction, and failure paths must drain or otherwise
prove safe finalization before rollback.

The probe also found `CREATE TEMP TABLE` rejected locally with `SQLITE_AUTH`.
A regular private staging table could be written while draining a RETURNING
cursor: the 8,000,000-byte value became 245 32-KiB rows, and a forced rollback
removed both source and staging rows. Such a table would persist sensitive
intermediates and consume storage until cleanup; fencing, failures, eviction,
quota, access restrictions, restart cleanup and retention must be designed
and tested before production use. The prototype does not provide a general
SQL parser, typed frames, or the database/sql driver ABI.

A separate local SELECT experiment uses a non-flattened coroutine and paired
value/type rows. It produced the full 8,388,608-byte text and exact signed
int64 in a 51-column result. With 10,000 randomly chosen integer/text values,
the returned type and value matched on every row; the local query plan showed a
coroutine. The design still depends on ordering of paired rows, does not yet
prove all SELECT forms or bounded SQLite-internal state, and does not solve
100-column RETURNING. It is not enabled in production. Safe integration must
preserve the Go driver's `Rows.Close`, transaction and rollback semantics,
validate every frame and handle against its owner transaction, and verify
large text/BLOBs and mixed types without increasing platform-valid row sizes.

The isolated prototype also explores vertical SELECT frames `(slot, type,
value)`, checking that slots arrive in order and failing on disagreement. A
100-column query returned full-size text and exact int64s in local workerd;
a Go `database/sql` driver consumed staged 32 KiB fragments, distinguished
empty text from empty BLOB, and verified REAL, embedded NUL, non-BMP Unicode,
and both signed extrema. The maximum response frame was 43,755 bytes. A
live SELECT cursor consumed after its opening transaction saw a later inserted
row; staging before commit instead returned the original 1, 2, 3 after row 4
was inserted, and cleanup removed its staging rows. Staging can incur an
unbounded amount of persistent storage and write I/O for unbounded query
results; it avoids an application-chosen low cap but remains subject to the
platform quota. The local test does not establish hosted quota or lifetime
semantics. The staged Go prototype uses fixed SQL and a test-only driver; it
still needs real query parsing, original column metadata, all supported
SQLite value types and errors, durable cleanup after crash, route and recovery
fences, actual owner/driver integration, and independent review. In particular,
wide RETURNING still needs a lossless type channel without a live cursor after
commit; the staging probe by itself only tested a BLOB and a small integer.

For the exact-width RETURNING edge, an earlier local prototype found that a
100-column `INSERT ... RETURNING value, NULL, ...` accepts 8,388,538 bytes of
TEXT, while the earlier one-byte tag failed at that size; the same tagged
statement tops out one byte lower. Both probes roll back and leave no rows.
An AFTER-trigger side channel separately captured types without adding bytes
to the RETURNING row, but an existing same-table trigger that inserts a nested
row generated side-channel records for both the nested and original rows,
whereas RETURNING emitted only the original. Pairing those records would
silently assign incorrect types. Trigger ordering, nested effects, generated
columns, and exact signed integer handling therefore remain unresolved; this
side-channel experiment is not enabled in the bridge.

The isolated test also writes five staged fragments, waits for a successful
response, resets the object with `ctx.abort()`, and verifies its next
constructor finds and removes all five. The reset error is intentional in the
test. This demonstrates local restart cleanup mechanics only; production must
also prove cleanup respects owner generation and recovery fences and cannot
remove another live invocation's data. See the [Durable Object state API](https://developers.cloudflare.com/durable-objects/api/state/).

A production-shaped SELECT staging implementation exists only under
`/private/tmp/mapi-sql-production`; it has not been integrated. It passes the
existing local Go bridge assertions and a 100-column exact-text test, but
fails when `*sql.Rows` escapes a rolled-back `cloudflarewasm.Transaction`:
the spool rolls back, and an explicit stale-handle guard reports an error.
The existing eager bridge retains that result. The focused regression
`MAPI_ESCAPED_ROWS_CONTRACT=1 MAPI_STMTTEST_FILTER='^TestMaPiRowsRemainReadableAfterRollback$' node scripts/test-upstream-sqlite-wasi.mjs`
passes against the existing bridge and includes a value from an uncommitted
row, which cannot be recreated by rerunning after rollback. Local queued KV
writes initiated inside the synchronous transaction roll back as well. The
pinned service statement interfaces expose domain results, not `*sql.Rows`,
and the inspected direct MaPi handler paths consume rows within their calls;
this source trace is not a proof that a generic driver contract may change.

A local table reproducing the pinned `json_schemas` column and primary-key
shape was also tested with the six columns in
`deleteByIDJSONSchemaStmt`. An 8,388,602-byte valid JSON string was returned
by the original DELETE, while the earlier bridge's narrow paired value/`typeof`
projection failed with `SQLITE_TOOBIG`; both probes rolled back cleanly. This
replicates the SQL and table shape, not the foreign key, the handler's request
limits, or hosted behavior. The pinned application therefore contains the
relevant DELETE statement, but an end-to-end request carrying that exact value
has not been demonstrated. The prototype tests also show that matching a
trigger sidecar by row identity is insufficient: a nested update to the same
row yields two different type records for one returned row.

`npm run test:sql-returning-exact` now passes the pinned-shape boundary using
compact RETURNING encoding. The test proves that the direct DELETE returns
the full 8,388,602-byte value, verifies rollback, and separately commits the
bridge delete with exactly one audit effect. `npm run test:sql-returning-exact-int64`
and `npm run test:sql-returning-exact-real` pass variants with the maximum
signed 64-bit integer and a REAL. `npm run test:sql-returning-exact-many`
passes a synthetic result with five zero integers. Integers are represented
as minimally sized signed BLOBs and colliding BLOBs are escaped; REALs and
TEXT remain unchanged. `npm run test:sql-limits` passed signed-width boundary
values, BLOB widths and escape-prefix collisions, embedded-NUL text, REAL
edge values and 2,048 deterministic binary64 inputs. A separate disposable
experiment passed 10,000 binary64 inputs. These checks do not prove all
possible values or eliminate every record-size overhead.

`npm run test:sql-returning-exact-blob` now passes the 8,388,630-byte BLOB
that previously failed. The bridge removes marker occurrences in SQLite to
decide whether a marker-prefixed BLOB could be an escaped short value; it
escapes only when the remainder has a reserved integer width. The decoder
applies the same byte-level rule. Focused Workerd tests cover BLOB widths,
embedded NUL, repeated and interspersed markers, and 512 arbitrary-byte
samples. `npm run test:sql-returning-exact-blob-repeat-safe` also passes an
8,000,001-byte repeated-marker BLOB through rollback and committed delete.
The direct and bridge deletes are rolled back, then a separate
bridge delete commits with one audit effect. Maximum-size tagged and nested
TEXT tests pass with TEXT unchanged, including comparison with the earlier
bridge. The marker check can copy a large BLOB in SQLite and scan it in JS;
these tests do not establish CPU or total isolate-memory limits.

`npm run test:sql-returning-exact-blob-repeat` and the corresponding
`-tail` through `-tail6` commands pass their marker-run cases. The
`-tail8`, `-tail8-zero` and `-tail8-ff` commands pass an 8,388,629-byte BLOB
ending in eight varied, zero or FF bytes; the `-tail11` control also passes.

`-tail8-wide66` now passes an 8,388,566-byte BLOB and 65 NULL columns.
`-tail8-wide100`, `-tail8-wide100-zero` and `-tail8-wide100-ff` pass an
8,388,530-byte BLOB and 99 NULL columns. The corresponding `-wide100-long`,
`-wide100-long-zero` and `-wide100-long-ff` checks also pass with longer
identifiers. The `-wide100-very-long` variants pass with another 80 bytes
in each identifier, including zero and FF suffixes and the BLOB in a long
named column. For wide results a compact scalar subquery uses short local
aliases and a unified tag in the existing escape grammar; a nested alias
avoids repeating longer identifiers. The matching decoder is selected with
the rewrite. The shared compact rewrite is tried when the per-column rewrite exceeds the
statement-size limit; prior codecs remain available if still needed. Local Workerd checks
test 100,000 UTF-8 bytes and rejection at 100,001 without a trigger effect.

The local suite also exercises 66-column multi-row UPDATE and DELETE with
columns named like the local aliases and with very long identifiers, all 256
suffix byte values, deterministic signed integers and width boundaries,
tag-shaped and nested data, rollback and trigger counts. Separately,
`npm run test:wide-int64-differential` drives the production compact codec
directly through a native SQLite adapter and compares 100,011 signed values against independent
BigInt expectations. This is selected local evidence, not a proof for all SQL. The SQL marker check
and result reconstruction can scan or allocate large values; the wide tag can
itself reach 592,145 bytes. Hosted CPU and total isolate memory are unverified.

`npm run test:sql-returning-exact-blob-repeat-tail8-wide100-extreme` and
its `-ff`, `-zero`, `-last` and `-terse-marker` variants pass an
8,388,530-byte BLOB with 99 NULL columns whose identifiers are extended by
512 bytes. When the per-column compact rewrite exceeds the SQL-size limit, the
bridge tries a shared correlated `NOT MATERIALIZED` CTE using the compact
codec before the older and distinct-marker fallbacks. The terse-marker value no
longer needs escaping in the shared codec. The shared rewrite also passed
plain and recursive caller CTE variants, colliding CTE and trigger-table names,
bound UPSERT, multi-row UPDATE and DELETE, same-row AFTER trigger semantics,
rollback and audit counts, mixed values, and the 100,000/100,001-byte SQL
boundary in local Workerd. `npm run test:shared-int64-differential` compares
100,011 signed values through the shared rewrite against a native BigInt
oracle; `npm run test:terse-int64-differential` exercises the production terse
codec directly rather than its selection. `NOT MATERIALIZED` is a SQLite
planner hint; these cases do not prove every query shape or bound hosted CPU
and isolate memory.

`npm run test:sql-returning-exact-blob-repeat-tail8-wide100-extreme-interspersed`
now passes the previously failing 8,388,530-byte BLOB with an inserted byte
and seven suffix bytes. For marker-prefixed BLOBs with at most eight bytes
outside the marker runs, the compact codec selects an ASCII sentinel absent
from those bytes and replaces each marker with the sentinel. The decoder
expands the sentinel and retains the other bytes. Local Workerd tests cover
all 256 inserted byte values, one through eight interspersed bytes at varying
positions, sentinel exhaustion through eight candidates, tag-like source
values, nested marker prefixes, rollback and trigger effects. The shared
encoder can scan and copy large BLOBs multiple times; neither CPU nor total
isolate memory is bounded by these local tests.

`npm run test:sql-returning-exact-blob-repeat-tail8-wide100-extreme-sparse-header`
now passes the formerly failing reserved-tag value. For a source beginning with
the reserved tag after marker and optional `Q` runs, the codec checks whether
the span after the tag is zero-filled, preserves its final 64 bytes verbatim,
and encodes the zero count. Local Workerd tests cover nested prefixes, all 256
tail byte values, 63/64/65/127-byte zero-span boundaries, rollback and trigger
effects. This is a specific compressible shape, not a general solution; SQL
may copy or compare large values and hosted CPU and isolate memory are unverified.

`npm run test:sql-returning-exact-blob-repeat-tail8-wide100-extreme-sparse-header-nonzero`
is a **failing regression**: a near-limit reserved-tag BLOB with a nonzero byte
inside the zero-filled span requires an escape prefix that exceeds SQLite's
result-size limit. Direct DELETE succeeds and both attempts roll back business
and audit changes. Other data shapes and wide SELECT materialization may also
exceed the limit. General exact-size compatibility remains an open Phase 1 gate.

The checks for this change ran in a disposable checkout with a copied pinned
upstream tree and dependencies symlinked to the original checkout's installed
Wrangler 4.165.0 and matching workerd. Empty Git metadata directories were
recreated in the copy. They are local evidence; hosted limits remain unverified.

The observed rollback incompatibility is specific to the tested synchronous
single-object staging approach. Re-execution after rollback cannot reproduce
an uncommitted row, and same-object SQL and queued KV writes both roll back.
Keeping all escaped results in JS or Wasm would reintroduce unbounded memory.
A different architecture, such as an independently durable synchronous result
store or redesigned asynchronous owner transaction protocol, may be possible;
this is not a proof about every architecture. Prohibiting escaped rows,
introducing a lower result cap, or rejecting databases with triggers would
change compatibility and is not enabled.

Cloudflare's [SQLite storage API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)
documents that cursor numeric results can lose 64-bit integer precision and
that SQL transaction statements such as `SAVEPOINT` cannot be issued through
`sql.exec`. The documented cursor API exposes column names and counters, not a
per-cell SQLite type channel. These facts explain why reading an unchanged
near-limit RETURNING row directly is not a general exact-int64 solution.

An additional **scratch-only** experiment in `/private/tmp/mapi-async-spool`
uses WebAssembly Promise Integration to suspend real Go/WASI host calls, run
an asynchronous owner SQLite transaction, and copy remaining result frames
to a separate Durable Object before rollback. The local Go `database/sql`
check preserved an uncommitted 8,000,000-byte BLOB and text after rollback
while the owner row remained absent. The scratch spill encrypts each frame
with an owner-held AES-GCM key and authenticates a synthetic project, owner,
generation, handle and sequence; changing that context failed decryption.
Injected spill denial, lost acknowledgement, object reset, and a simulated
quota error returned explicit failure, rolled back the owner row, and left no
spill entries after cleanup. Five sequential local proof runs took 930–1,340 ms
each, with 247 spill calls, 10,682,472 encoded bytes, a maximum 43,755-byte
frame, and 792 Wasm pages in the final sample. These figures are not hosted
sign-in measurements; total isolate memory and CPU were not captured.

Separate scratch queue and fence experiments in
`/private/tmp/mapi-async-fence-proof` and `/private/tmp/mapi-async-goqueue`
serialize owner operations with immutable per-invocation authority. In local
tests, a freeze waited for a suspended write; a second project completed
while the first waited; stale project authority was rejected; and rollback
left both business and audit tables unchanged. A process restart during a
suspended write left an unreadable orphan lease that was later removed. A
local spill alarm expired overlapping leases in deadline order and caused
resumed writes to fail closed. A synthetic transactional idempotency ledger
prevented duplicate business and audit rows when a cancelled or interrupted
request was retried. These mechanisms are test scaffolding, not the real
owner: the Go spill and the separate alarm/fence proof have not been combined,
and the full pinned statement suite through the asynchronous scratch bridge reported 283/285, with the same two held-lock failures and five simulated-timer passes. The separate uncommitted escaped-row regression passed 1/1.

Production integration would have to change every synchronous `#call` and
`#withRoute` caller to propagate asynchronous completion and avoid restoring
shared authority early, serialize each owner reactor together with freeze and
recovery controls, and revalidate the generation after each suspension. It
also needs per-project private bindings and keys, scoped authenticated spill
leases, renewable expiry and alarms, durable orphan cleanup, request
idempotency with relocation/recovery semantics, handling of ambiguous client
disconnects and spill acknowledgement, quota and cost bounds, and a new
hosted runtime benchmark. The local tests do not prove arbitrary Go scheduler
behavior, total isolate memory, actual platform quota exhaustion, full
management behavior, hosted JSPI availability, or the current SQL cursor
contract. None of this experimental async code is deployed or enabled.

Additional local scratch checks ran 200 distinct SELECT/scan operations from
eight Go goroutines in one async reactor, and exercised a reused reactor in
one project while another project completed independently. These are bounded
scenarios, not a proof of every possible scheduler interleaving. In separate
synthetic cancellation checks, a client disconnect did not cancel a
suspended write; after it committed, a same-key/same-digest retry returned the
recorded result without a second business or audit row, and a different digest
was rejected. After a process stop before commit, retrying the same key
committed one business row and one audit row. The idempotency ledger in those
checks is not integrated with the real application or its relocation manifest.

The async spill experiment handles SELECT only; DML `RETURNING` falls back to the existing bridge and therefore does not fix the exact-size `SQLITE_TOOBIG` regression. A separate local staging experiment also changed connection-local SQLite state while iterating: a multi-row query containing `changes()` and `last_insert_rowid()` returned different values after spool inserts, and those functions remained changed after opening the result. Its local staged handle also failed to preserve an uncommitted row after rollback. A bounded production design must preserve these observable semantics, not just transfer rows in small frames. The volatile-expression checks run so far cover only a narrow materialized `randomblob` case; they do not prove general single evaluation. See `phase1-status.md` for the remaining gates.

A later local workerd probe showed why an escaped live cursor alone is insufficient: after consuming one of three uncommitted rows and rolling back, subsequent iteration returned only one of the remaining two rows without an error. A separate small two-object experiment kept frames outside the owner database and retained all three rows after rollback without changing owner connection state. It does not establish secure spill storage, resource bounds, cancellation, fencing, Go integration or hosted behavior; neither experiment is mounted in the application.

A separate local workerd `RETURNING` experiment tried pairing nested BEFORE and AFTER trigger events to capture metadata. A pre-existing BEFORE trigger using `RAISE(IGNORE)` left an unmatched frame and caused metadata to be missed for a subsequent returned row. The experiment is a negative result; trigger-pairing is not a supported bridge fix.
