# Audit snapshot metadata diagnostics

These local-only diagnostics explore one part of a bounded audit snapshot. They are not a deployable snapshot, and no production files or Woven deployments were changed by this experiment. The temporary source tree is `/private/tmp/mapi-management-build-c4k7gq/nextgen`, prepared from the pinned Nextgen source and MaPi overlay for the audit codec investigation.

## Result

- In the disposable tree, `apps/api/internal/storage/events/list_each_metadata.go` implements a metadata-only range merge. Its synthetic test compares its results and next cursors to the pinned `events.ListEach` for duplicate ranges, ordering ties, both directions, empty and exact-final pages, and propagated errors. The enhanced test `TestListEachMetadataExpectedAndParity` passed in session 80655; the earlier `TestListEachMetadataMatchesFullMerge` passed in session 89846. These tests use in-memory reference readers and do not prove SQL, authorization, or bounded payload transfer.
- `apps/api/internal/storage/dialect/sqlite/event_snapshot_metadata_diagnostic.go` adds an **unmounted** SQLite projection of event ID and creation timestamp. It invokes the pinned SQL compiler and `pagination.Page` and accepts only the ordering keys used by the public event service. The distinct native SQLite test `TestAuditSnapshotMetadataSQLiteParity` compares it with the real pinned SQLite `ListEvents` on five synthetic stored rows, including tied timestamps, ascending and descending two-row pages, and matching opaque cursors through the final page. Session 32416 passed (`0.314s`). These are sub-boundary values and do not test platform size limits.
- The first SQLite diagnostic attempt, session 61353, failed to compile: its new projection compared a `database.Column[domain.EventField]` directly to `domain.EventField`. The disposable source was corrected to compare `col.Field()` before the successful run. This was a completed compiler failure, not an aborted action.

The SQLite command, run from `/private/tmp/mapi-management-build-c4k7gq/nextgen/apps/api`, was:

```sh
env -i PATH=/usr/bin:/bin GOENV=off GOWORK=off \
  GOPROXY=file:///Users/asmith/go/pkg/mod/cache/download \
  GOSUMDB=sum.golang.org GOTOOLCHAIN=local \
  GOCACHE=/private/tmp/mapi-management-build-c4k7gq/gocache \
  GOMODCACHE=/private/tmp/mapi-management-build-c4k7gq/gomod-verified \
  /Users/asmith/go/pkg/mod/golang.org/toolchain@v0.0.1-go1.26.9.darwin-arm64/bin/go \
  test -count=1 -tags sqlite_integration \
  -run '^TestAuditSnapshotMetadataSQLiteParity$' ./internal/storage/dialect/sqlite
```

The synthetic merge command used the same environment and toolchain, replacing the last two lines with:

```sh
test -count=1 -run '^TestListEachMetadataExpectedAndParity$' ./internal/storage/events
```

## Open requirements

The projection does not execute `scanEvent` on full lookahead and non-winning range rows, unlike the pinned service, and may therefore skip conversion errors. Identity strings and page counts alone do not establish a byte bound. The experiment has not established equivalent errors, authorization or claim visibility, transaction and route-generation fencing, retention and revocation interleavings, cleanup, bounded typed fragmentation, integrity, response staging, per-row working set, or generated wire behavior. The current service still materializes full events and its original full-page encoder remains in use. The earlier interrupted normalization observation remains open. No size, startup, runtime, or Phase 1 gate is claimed by these results.

## Validation boundary

For the ordinary range path, upstream `ListEvents` scans the complete fetched result, including the ordered-page lookahead row, before `pagination.Page` trims it. `ListEach` performs that read for each unique range before merging. `scanEvent` calls `database/sql.Rows.Scan` in column order: it converts timestamps to `int64`, nullable fields to `sql.NullString`, and other fields including payload and metadata to strings, then constructs the domain event. It does not apply the event JSON encoder to discarded rows. A metadata-only reader can miss a conversion error in a lookahead or non-winning row.

A bounded implementation must validate each row upstream would scan in the same range, row, and column order, including those discarded later. It must reproduce the actual driver and `database/sql` conversions and first-error behavior, not simply check SQLite storage classes. The existing Cloudflare Go driver receives a materialized JSON result before `Rows.Next`; invoking that scanner unchanged does not bound the query's memory. SQLite byte-fragment projections can bound individual transfers, but large variable-length keys also require a bounded ordering and cursor strategy. Neither the conversion validator nor that strategy has been implemented or tested in this experiment.

Separately, source review indicates `EventService.fetchEvents` builds one project filter and one ID filter per selected event. A 100-match page therefore appears to require 101 bound values, against Cloudflare's documented 100-parameter limit. This is a source-derived hypothesis, not a measured failure; no interrupted SQL-limit test was rerun. Any batching replacement needs to preserve authorization, ordering, retention and error behavior rather than silently dropping or truncating events. [Durable Object SQL limits](https://developers.cloudflare.com/durable-objects/platform/limits/#sql-storage-limits)

## Row-scan diagnostics

The disposable tree also contains an unmounted diagnostic row validator in `apps/api/internal/storage/dialect/sqlite/event_snapshot_validation_diagnostic.go`. It examines the columns in `scanEvent` order and reads a TEXT or BLOB numeric destination in SQL byte fragments of at most 64 KiB. It records only diagnostic failure location/reason; it does not reproduce the original full error text, prove Workerd's driver and text decoding behavior, validate every upstream scan value or row in an integrated service, or bind any reads to an authorized fenced transaction. Its parse and transfer behavior is not a deployed policy for invalid SQLite TEXT.

Three distinct native SQLite tests passed using the same offline environment and toolchain shown above, replacing the `-run` argument:

- `^TestEventRowValidationLookaheadAndRangePrecedence$`, session 82837 (`0.276s`): the real pinned scanner reported an `occurred_at` conversion failure on an ordered lookahead and a losing range, with the tested row/column precedence, using finite out-of-range REAL values.
- `^TestDiagnosticFragmentValidatorAgainstSQLiteScan$`, session 61045 (`0.316s`): the prototype and original scanner agreed on the `occurred_at` failure location in those two small native SQLite cases. Their complete errors were not compared.
- `^TestDiagnosticSQLiteFragmentedValidTimestamp$`, session 71625 (`0.281s`): a 131,073-byte valid ASCII-zero SQLite BLOB timestamp succeeded in the real scanner and prototype; the prototype used three SQL fragment queries. This is a sub-boundary example, not an exact platform-size test or a general memory measurement.

The range budget in `ScanEach` applies per unique range, so even metadata accumulation and sorting can grow with range count. Selection, all lookahead/losing-row conversion behavior, a bounded cursor, inaccessible durable spools and integrity, complete application-level response validation before headers, restart and cleanup, authorization/fence/revocation/retention races, actual Workerd memory and CPU, and full public-wire parity all remain unverified. A source review suggests `fetchEvents` may use one project bind plus one bind for each selected ID, potentially exceeding Cloudflare's 100-parameter limit for 100 IDs. This is an unmeasured hypothesis; the user accepted that potential limitation for now, and neither page behavior nor the earlier interrupted SQL-limit test was changed.

## Bounded handle merge diagnostic

An unmounted reducer retains at most `limit + 1` opaque numeric handles and the earliest scan cut, while the caller continues visiting all ranges. It computes the pinned `ScanEach` and `ListEach` final page/next-position decisions from those handles. The source and the other diagnostics above are retained without generated upstream files in `experiments/audit-snapshot/nextgen-overlay/`; their README explains the disposable-only scope.

The following command used the same offline environment, toolchain and working directory as the SQLite command above:

```sh
env -i PATH=/usr/bin:/bin GOENV=off GOWORK=off \
  GOPROXY=file:///Users/asmith/go/pkg/mod/cache/download \
  GOSUMDB=sum.golang.org GOTOOLCHAIN=local \
  GOCACHE=/private/tmp/mapi-management-build-c4k7gq/gocache \
  GOMODCACHE=/private/tmp/mapi-management-build-c4k7gq/gomod-verified \
  /Users/asmith/go/pkg/mod/golang.org/toolchain@v0.0.1-go1.26.9.darwin-arm64/bin/go \
  test -count=1 \
  -run '^TestDiagnosticBoundedMerge(AgainstPinned|ComparatorFailureAndEquality)$' \
  ./internal/storage/events
```

Session 89696 passed (`0.197s`). The first test compared 250 deterministic, small, unique-key synthetic cases with the actual pinned Go `ScanEach` and `ListEach` functions, including result IDs and opaque page cursors. The second verified propagation of a comparison error and rejection of one observed equality between distinct handles. The reducer cannot detect every equality involving discarded handles. A source-derived possibility is that distinct SQLite TEXT and BLOB IDs scan to equal Go strings; the pinned unstable sort may choose different tied records. That case is unmeasured and no equal-key parity is claimed. The comparator still needs an actual byte-bounded spool implementation with Go-equivalent conversions. The result does not prove SQL ordering, aggregate range or CPU bounds, authorization, fence, retention, complete errors, memory or Workerd behavior.
