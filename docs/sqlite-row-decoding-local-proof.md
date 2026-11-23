# SQLite host response row checks

The `cloudflarewasm` driver receives a materialized JSON response from the
synchronous host. The previous `rows.Next` indexed each cell and destination
without checking row width or whether a cell was empty. A malformed host
response could panic or leave an incorrectly shaped row; an integer decoding
error could include the malformed value in an error string.

The existing `rows.Next` implementation is now in `rows.go`. It checks row and
destination widths, validates the JSON syntax without first copying cell
contents, decodes a complete row into a temporary slice and publishes it to
`database/sql` only on success. Malformed responses produce a sticky error
that reports a column index without the cell value. Valid host-generated
integer, blob, real, text and null values retain the existing representation;
whitespace around an encoded value is tolerated. The decoder rejects unknown,
duplicate and ambiguous tags, arrays, booleans and noncanonical base64. A
linear pass checks blob alphabet, padding and tail bits before allocating the
decoded value; CPU and memory for large blobs have not been measured.

The focused Go 1.26.9 command passed for short and long rows, an empty cell,
malformed JSON, invalid integer and blob values, a late integer overflow and
late invalid blob, malformed and ambiguous tags, and supported canonical blob
lengths. Valid null, empty text/blob, exact integer and REAL values passed:

```sh
env GO111MODULE=off GOWORK=off GOTOOLCHAIN=local GOCACHE=/private/tmp/mapi-phase1-rows-go-cache \
  /Users/asmith/go/pkg/mod/golang.org/toolchain@v0.0.1-go1.26.9.darwin-arm64/bin/go test -count=1 \
  upstream/overlay/apps/api/internal/cloudflarewasm/rows.go \
  upstream/overlay/apps/api/internal/cloudflarewasm/rows_test.go
```

A separate `GOOS=wasip1 GOARCH=wasm` compile of those two files together with
the actual `driver_wasip1.go` and `bridge_wasip1.go` also passed.

The distinct local `node scripts/test-rows-host-workerd.mjs` test builds a
reactor from fresh copies of the actual overlay driver, bridge and rows files,
then runs it in disposable workerd with synthetic host responses. It exercises
short/long rows, invalid blob/integer tags, ambiguous tags, an array, followed
by a valid query on the same database handle. It performs no SQLite statements,
cursor tests, SQL-limit probes, exact-size or nonfinite tests, migration or
archive actions. Two initial attempts failed Miniflare options validation
before startup; a third failed with sandbox `EPERM` opening a loopback listener.
After scoped approval for the local listener the corrected test passed. It
used Go 1.26.9, the installed Miniflare/workerd and the local Go cache. The
scratch copies were checked against their recorded hashes after build:

| Artifact | SHA-256 |
| --- | --- |
| `rows.go` | `b21fe0e6811dc2558586e54ce6974f36245ec3303dea24b5317ee2a93c4507a9` |
| `driver_wasip1.go` | `a841bb2b205c4b839dc92c31ead2c8329e4491912846f7d9621ef2864db95b2f` |
| `bridge_wasip1.go` | `c818c395aa509a391955890d38f19048ed9dbde39598dcdcec26bd87fd3edd22` |
| smoke main | `4225045ac46c76e29bfd38dbac372cddac5f2da54e9f1102aed87a09570eb46f` |
| reactor Wasm | `a2f52395551ae2b6db3a488f0c5a98746a279e7cbebb18db27259c5096ae6c2d` |
| `worker/wasi.js` | `db00a5f6c361bb4cf80132c0122179f9459a9fd4e7491912e0064bdfa242f80b` |
| generated Worker | `90f8c645914772cd9b408e12ae247f118a200381451c90d13ceb250645451209` |

This is a host-response injection test, not a real SQLite bridge or hosted
test. It does not establish bounded response materialization, large-BLOB CPU
or memory, exact-size, cursor or nonfinite-value contracts, or the full Phase 1
SQLite gate. The earlier interrupted tests were not rerun.

## Focused real SQLite round trip

The distinct `node scripts/test-rows-real-sqlite-workerd.mjs` builds a Go
reactor from a fresh `git archive` of the pinned Nextgen commit and the current
MaPi overlay, then calls the actual Go `database/sql` driver through the
current `worker/sql.js` host into an isolated local SQLite Durable Object. The
fixture checks NULL versus non-NULL, empty text and BLOB, Unicode text, binary
data, a signed integer above 2^53 and ordinary finite REAL values. It verifies
a duplicate-key error has the bridge's extended code 2067 and reads the table
successfully afterward on the same database handle. This is a small synthetic
table, not the pinned application statement suite, project isolation, a
platform limit or a performance test.

The first invocation completed with exit 1 before assertions because the
sandbox denied Miniflare's loopback listener (`EPERM`). A scoped approval for
the local listener was granted and the same command completed with exit 0.
No external or hosted service was used. It did not run the earlier interrupted
exact-size, nonfinite REAL, cursor/concurrency, SQL-limit, migration, archive,
or hosted-evidence actions.

| Input or artifact | SHA-256 |
| --- | --- |
| Nextgen commit | `b0b74cd4a198428ea9b82910c217259ffc62b65c` |
| Pinned source tar archive | `cb2946fcd275059e3a7c5de9dbf786a57dcd797ade27bf75a57f960040945e18` |
| Go smoke entry | `b7d19684cddbfed2811c107f00cd7f041e1033744610d4f40c85c4ddf91c8f6c` |
| `rows.go` | `b21fe0e6811dc2558586e54ce6974f36245ec3303dea24b5317ee2a93c4507a9` |
| `driver_wasip1.go` | `a841bb2b205c4b839dc92c31ead2c8329e4491912846f7d9621ef2864db95b2f` |
| `bridge_wasip1.go` | `c818c395aa509a391955890d38f19048ed9dbde39598dcdcec26bd87fd3edd22` |
| Reactor Wasm | `961e86efc313cc174e38547d99facd8c155f966c5e845a917e36d0ba8a98663c` |
| `worker/wasi.js` | `db00a5f6c361bb4cf80132c0122179f9459a9fd4e7491912e0064bdfa242f80b` |
| `worker/sql.js` | `43fb3a38a9fb3bc21aa3c67df21ff9df8e97d200612e0f9ff6da2ade9f5c3f49` |
| Generated test Worker | `83925e6150fc6bf8c109a3aa6e4b5c9d486650d3cdc5643c781edc9d8dc2f6ff` |

The test checks the three compiled overlay files before and after the build
against the working source and rechecks the two Worker host files after the
run. The recorded tar is the unmodified pinned source archive, not a hash of
the whole overlay or dependency cache. The result does not establish large
result memory, Worker CPU, exhaustion behavior, full statement and migration
parity, or hosted behavior, and does not close the SQLite Phase 1 gate.

## Release of consumed rows

The Go driver now clears a successfully decoded raw row from the response
backing array before advancing, and drops the remaining response on `Close`.
Previously a still-reachable result could retain raw JSON for rows already
consumed, or retain all unread rows after close. The decoded blob remains
valid after closing. The focused native test in `rows_test.go` passed with
Go 1.26.9, and its test binary also compiled for `wasip1/wasm`:

```sh
GOCACHE=/private/tmp/mapi-row-release-go-cache GOPROXY=off \
  /Users/asmith/go/pkg/mod/golang.org/toolchain@v0.0.1-go1.26.9.darwin-arm64/bin/go \
  test -count=1 rows.go rows_test.go
GOCACHE=/private/tmp/mapi-row-release-go-cache GOPROXY=off GOOS=wasip1 GOARCH=wasm \
  /Users/asmith/go/pkg/mod/golang.org/toolchain@v0.0.1-go1.26.9.darwin-arm64/bin/go \
  test -c -o /private/tmp/mapi-rows-release-test.wasm rows.go rows_test.go
```

Run those commands from `upstream/overlay/apps/api/internal/cloudflarewasm`.
This is a reference-lifetime improvement, not a bounded-result design: the
host and Go driver still materialize the complete response before iteration.
No memory or Workerd measurement was made after this change; the Workerd
results and `rows.go` hash above describe the earlier version only.
