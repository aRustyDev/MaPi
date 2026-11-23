# Audit shadow Go reader: native diagnostic

The unmounted files under `experiments/audit-snapshot/nextgen-overlay/apps/api/internal/storage/dialect/sqlite/` wrap the pinned `eventStatements` reads for a fixed `mapi_shadow_snapshot` view. The wrapper intersects the caller's list and scan filters with a separately supplied project ID and rejects a different project on Get. The project ID is **trusted input**, not authentication. The wrapper's query checks are not a SQL authorization boundary; only trusted pinned statement compiler output may reach its private query adapter. The view and its lifecycle are assumed trusted.

The distinct native Go test `TestDiagnosticShadowEventReaderPinnedStatements` passed in session 96575 (exit 0, `0.331s`). It created a small synthetic view with saved rows and post-snapshot markers, then compared actual Go `ListEvents`, `ScanEvents`, and `GetEventByID` results with the same statements before changing or deleting source rows. It checked list and scan project intersections and a foreign Get rejection, plus one syntactically valid SQLite TEXT value that the upstream timestamp scanner cannot convert. The test uses an unpaged result and does **not** run any previously interrupted bridge-cursor, concurrency, SQL-limit, exact-size, nonfinite, malformed SQLite TEXT, normalization, real-owner, or hosted action. It manually builds the view; it does not use or validate the shadow COW lifecycle.

Run from the previously prepared disposable pinned Nextgen tree's `apps/api`, after copying the two diagnostic files to `internal/storage/dialect/sqlite`:

```sh
env -i PATH=/usr/bin:/bin GOENV=off GOWORK=off \
  GOPROXY=file:///Users/asmith/go/pkg/mod/cache/download \
  GOSUMDB=sum.golang.org GOTOOLCHAIN=local \
  GOCACHE=/private/tmp/mapi-management-build-c4k7gq/gocache \
  GOMODCACHE=/private/tmp/mapi-management-build-c4k7gq/gomod-verified \
  /Users/asmith/go/pkg/mod/golang.org/toolchain@v0.0.1-go1.26.9.darwin-arm64/bin/go \
  test -count=1 -tags sqlite_integration \
  -run '^TestDiagnosticShadowEventReaderPinnedStatements$' ./internal/storage/dialect/sqlite
```

The disposable tree was prepared from Nextgen `b0b74cd4a198428ea9b82910c217259ffc62b65c` plus the MaPi overlay and contains other diagnostic files; it is not a clean fully frozen source or dependency checkout. After the test, the two copied files matched their retained experiment files: reader SHA-256 `faeca639ea449bdb9bd05ef8441ccc3fa81e1e9202ffabec606da5c755c58f97`, test SHA-256 `fad1eb59e2c9dea1bb6aef2f56bf11f777b4d3cf243c723b8b5b90e3b47f0be8`. The tested tree's `event.go` SHA-256 `cfa834779714d4aa0b2b515b1aee2e58b8478a9d8f50c70f0be102c221bf77f7` and `compiler.go` SHA-256 `6888708cc7ca6854b05f401212d4c42cd0031fa93e12a5422aa41f4fbf3bf6f0` matched the current MaPi overlay; `statement.go` SHA-256 `5dc5d55dac3db1a97bf6f4386f03a20438021906af55fc825b63ec46cdffeccd` matched the pinned source. These post-run hashes do not prove that every source, dependency, or generated artifact was frozen during execution.

The implementation calls the existing materializing Go statements and therefore **does not bound memory**. It does not preserve or prove real handler authorization, visibility claims, settled-before ordering, pagination, complete error precedence and lookahead behavior, retention interleavings, lifecycle/fencing, full event-wire behavior, shadow integrity, Workerd, resource limits or hosted behavior. The list adapter adds a duplicate project predicate when the original is already scoped, consuming an additional SQL bind. Source review had suggested a full unindexed page could require 101 binds; the user accepted that *potential, unmeasured* limitation for now. The additional bind in this unmounted reader could make the situation worse and has not been accepted or measured. A production implementation needs to reconcile secure scope enforcement with the platform bind budget; no page limit has been changed. The later-required independent source and recovery authorities remain open. No Woven deployment was touched.
