# Experimental audit shadow scope entailment

This record concerns the unmounted experimental Go shadow reader. It does not
replace the earlier reader proof, whose results describe its earlier source.
The reader avoids adding a second project predicate only when its Go filter
contains an exact equality to the trusted project ID as a necessary conjunct.
Other forms retain the independent trusted-project predicate.

On 2026-11-23, `TestDiagnosticShadowScopeEntailment` passed against a fresh
archive of Nextgen commit `b0b74cd4a198428ea9b82910c217259ffc62b65c`, with
the current MaPi overlay and the experimental reader and test copied into the
archived tree. The selected test checks direct and nested AND equality, nil,
different project and column, OR, NOT, OR within AND, keyset flags, tuple
equality and a non-string value. It is an AST-only test; it executes no SQL.

The command, run from the archived tree's `apps/api`, was:

```sh
env -i PATH=/usr/bin:/bin GOENV=off GOWORK=off \
  GOPROXY=file:///Users/asmith/go/pkg/mod/cache/download \
  GOSUMDB=sum.golang.org GOTOOLCHAIN=local \
  GOCACHE=/private/tmp/mapi-management-build-c4k7gq/gocache \
  GOMODCACHE=/private/tmp/mapi-management-build-c4k7gq/gomod-verified \
  /Users/asmith/go/pkg/mod/golang.org/toolchain@v0.0.1-go1.26.9.darwin-arm64/bin/go \
  test -count=1 -tags sqlite_integration \
  -run '^TestDiagnosticShadowScopeEntailment$' ./internal/storage/dialect/sqlite
```

The process exited 0 with `ok github.com/zitadel/nextgen/internal/storage/dialect/sqlite 0.448s`; clang emitted a `confstr()` warning. SHA-256 of the executed reader was `3952aac771172db2519faaa1fa45778d7918018647087c7ef72278eb150c3028`, and of the test was `5b4e2f3edbc95711d4a12c96165c6aabd96eda092200d5296936c7c85c6bfad5`. The source archive SHA-256 was `cb2946fcd275059e3a7c5de9dbf786a57dcd797ade27bf75a57f960040945e18`.

The test does not establish SQL equality, collation or affinity behavior, actual
parameter counts, authorization, a bounded snapshot, or handler integration.
For filter forms the proof does not recognize, the separate project predicate
still adds a parameter. The earlier potential 101-parameter page limit remains
unmeasured; this record does not extend the accepted limitation to other cases.
No hosted or production deployment was changed.
