# Synthetic archive to staged importer: local proof

This is a disposable local workerd experiment. It does not deploy a Worker, access Woven, or invoke AWS KMS. The two projects contain only synthetic `users` and `events` fixture tables; the `events` rows stand in for audit data. The fake KMS supplies a fixed test key, and Miniflare provides local R2. The target has no route or activation operation and is not an independent recovery authority.

Run from the implementation checkout:

```sh
node scripts/test-synthetic-archive-staged.mjs
node scripts/test-synthetic-archive-combined.mjs
```

Both commands passed on 2026-11-23 with loopback access for local Wrangler/workerd. The combined test was rerun successfully after the shared selector-listing helper was changed to enforce sequential ordering across pages. Each command creates and removes its own temporary local persistence directory. The first test uses the actual `beginChunkImport` and `importChunk` functions in a separate SQLite Durable Object per fixture project. It checks an abort after the importer commits, identical retry without another insertion, rejection of a conflicting or out-of-order chunk, corrupted checkpoint rejection, exact staged row reconciliation, and concurrent isolation of the two fixtures. Synthetic insert triggers count actual inserted rows. A deliberately modified staged user makes final reconciliation fail.

The second test mints a fake-KMS-backed data key, writes and seals the two-chunk archive to local R2, and performs bounded full-history verification before restoring with a completed verifier head into the actual chunk importer. The authority is a mutable in-memory mock, not an independent or durable authority. Its test-only reset after a deliberately induced mismatch is not an operational reconciliation procedure. The destination checkpoint binds the exact verifier head digest.

A changed head on a fresh destination fails before its import begins. In a separate mid-dispatch test the first importer transaction commits before the mock authority head changes; restore detects the change, reports failure, and leaves the destination staged with an incomplete checkpoint and no activation route. The test then resets the mock solely to continue the experiment. After the second importer commit, an injected abort leaves the importer at chunk 2 while the archive checkpoint remains at chunk 1. A repeated call reads only the unacknowledged chunk 1 selector once, does not reread acknowledged chunk 0, and does not insert committed rows twice. A concurrent second synthetic project pauses after its configured one-chunk bound and completes in another call. Both projects' synthetic user and audit rows reconcile exactly.

The bounded completed-head path skips the initial full scan and final selector listings during restore. That shortcut assumes the authority's completed head is terminal and nonrollback, and that the entire archive and selector namespace is write-closed, non-deletable and non-rollback from verification through every restore step. Neither condition is independently established by local R2 or the mock authority; they are mandatory open operational gates. Per-chunk authentication still runs during restore. The 2-chunk fixture tests step behavior rather than large-scale performance.

The importer atomically commits business rows, its per-index digest, and its importer cursor. The wrapper advances its separate archive checkpoint and expected fixture rows in a subsequent transaction; a crash between transactions is recovered by replaying the one importer-committed chunk. The fixture compares actual and expected table row sets and counts before marking the destination staged. This is an exact fixture comparison, not an independently anchored production per-table digest.

This proof does not cover a real Nextgen schema or Go handler, oversized or fragmented rows, representative data volume, real-project relocation or cutover, independently administered recovery, or production storage retention and immutability. The separate live AWS KMS/local-R2 experiment uses a different disposable target and does not exercise the completed-head path and does not establish this combined test's guarantees with live KMS. These gaps remain open.
