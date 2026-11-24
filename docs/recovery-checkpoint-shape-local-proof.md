# Recovery invalidation checkpoint shape

The local Go recovery batch now rejects invalid checkpoint phase, cursor and counter combinations before using the checkpoint or reporting completion. A recorded session or attempt cursor is accepted only in its phase, must satisfy the existing bounded identifier checks, and cannot silently advance to the next phase if its underlying row has disappeared. The existing lookup selects the first eligible project row independently of the cursor and compares it with any pending cursor; a different cursor therefore stops the batch instead of skipping that row. Counts must be nonnegative and recorded handoffs cannot exceed attempts.

From `upstream/overlay/apps/api/cmd/mapi-wasm`, run:

```sh
GOWORK=off GOTOOLCHAIN=go1.26.9 go test -count=1 -v recovery_delete.go recovery_checkpoint.go recovery_checkpoint_test.go
```

The focused native test passed valid phase transitions, malformed or out-of-phase cursors, invalid counts and missing pending work. It validates the shared helper and the source-level branch wiring; it is not a workerd, production handler, point-in-time restore, or complete recovery test.

With the recovery Go files and the local cached Nextgen API `go.mod` and `go.sum` copied into a fresh temporary module, the following command also passed with `GOPROXY=off`:

```sh
GOWORK=off GOPROXY=off GOTOOLCHAIN=go1.26.9 go test -count=1 -v recovery_delete.go recovery_checkpoint.go recovery_checkpoint_sqlite_test.go
```

That separate native SQLite test models session and attempt work, and verifies that rollback retains both row and cursor, a committed deletion clears both, and a retry after a discarded acknowledgement observes the cleared cursor. It does not invoke the actual WASI batch or prove its crash behavior. In source, the deletion and cursor clearing occur in the same `cloudflarewasm.Transaction`; their atomicity depends on the host correctly executing that callback as a synchronous SQLite transaction. Cloudflare documents that a throwing `transactionSync` callback rolls its SQLite transaction back. [SQLite storage API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)

These checks validate checkpoint *shape*, not its authority. A plausible but forged, advanced, or rewound checkpoint, including a `done` checkpoint, may still pass. The project must remain fenced, and recovery requires an independently authenticated, nonrollback authority and reconciliation of restored rows and credentials before any reopen. No such authority or safe reopen is established by this change. The existing Woven deployments, independent-recovery gate, and previously interrupted recovery work were not touched.
