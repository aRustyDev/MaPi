# Recovery invalidation delete cardinality

The recovery invalidation batch selects one check or token ID within the project and, where applicable, the owning session or attempt. Its four bounded-delete call sites then delete by the project and ID primary key. Each successful deletion must affect exactly one logical row. A zero-row or multirow result now fails the batch rather than recording misleading progress. The caller must return the error from the enclosing transaction; the host rolls back the transaction when the Go callback fails.

The Cloudflare SQL bridge obtains its affected-row value from SQLite `changes()`, rather than the storage billing counter, and the Go driver returns that value through `RowsAffected`. The helper is shared by the WASI batch and the focused native tests in `recovery_delete_test.go`. With the pinned Nextgen API module dependencies, run:

```sh
GOWORK=off GOTOOLCHAIN=go1.26.9 go test -count=1 -v recovery_delete.go recovery_delete_test.go
```

The tests use real SQLite transactions to check the 64-row bound, project and owner isolation, zero- and multirow errors, and rollback of an earlier deletion when a later deletion is ignored. They exercise the helper in isolation; they do not establish end-to-end recovery provisioning, workerd transaction behavior, or safe reopening. Recovery remains disabled.
