# Synthetic event codec comparison

A disposable source tree generated two Go packages from the Nextgen pin `b0b74cd4a198428ea9b82910c217259ffc62b65c` and the same local 27-type MaPi read-only event catalog: one with the full public Ogen configuration, and one filtered to the `GET /events` and `GET /events/{event_id}` operations. The filtered package's generated event union is used by a separate diagnostic serializer. Nothing in this comparison is mounted in the current owner or deployed.

In that disposable tree, this native in-memory test completed with exit code 0:

```sh
env -i PATH=/usr/bin:/bin GOENV=off GOWORK=off \
  GOPROXY=file:///Users/asmith/go/pkg/mod/cache/download \
  GOSUMDB=sum.golang.org GOTOOLCHAIN=local \
  GOCACHE=/private/tmp/mapi-management-build-c4k7gq/gocache \
  GOMODCACHE=/private/tmp/mapi-management-build-c4k7gq/gomod-verified \
  /Users/asmith/go/pkg/mod/golang.org/toolchain@v0.0.1-go1.26.9.darwin-arm64/bin/go \
  test -count=1 -run '^Test(MaPi|InMemory)' ./cmd/mapi-event-serializer-diagnostic
```

The working directory was `/private/tmp/mapi-management-build-c4k7gq/nextgen/apps/api`. The test compared the full and filtered generated event codecs against the existing MaPi event cases, including all 27 catalogued types, with byte-identical encoded output and matching validation success or failure. It also compared the diagnostic codec with the original `MarshalWire` → generated union → original-payload guard → validation sequence for synthetic empty, unknown-field, duplicate-key, unpaired-surrogate, invalid-byte, malformed JSON, unknown-type and signed-int64-extreme payloads. Two synthetic project IDs were exercised as event data; this was not an authorization or isolation test. The malformed inputs were Go byte slices only, not SQLite TEXT.

An additional action intended to observe whether marshaling can hide malformed original bytes from a **wire-only** guard was aborted before dispatch. That observation did not run and has not been inferred. The diagnostic serializer accepts the original stored payload bytes separately because the existing upstream guard compares `events.NormalizeJSON(e.Payload)`, not merely the marshaled event. Its private transport must preserve and authenticate those bytes and the original event type across the same authorized snapshot.

This result is limited to native in-memory codec cases. It does not establish all event variants or arbitrary payload parity, request decoding, error/status/header parity, real Go authorization, project isolation, revocation or freeze behavior, bounded transfer, a complete serializer Worker, hosted startup/load, or a deployable owner. Unknown or malformed data must not be silently dropped. The full worker size, independent recovery and Phase 1 gates remain separate.
