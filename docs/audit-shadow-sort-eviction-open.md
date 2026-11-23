# Shadow sort eviction: evidence open

A disposable local Workerd test was prepared to abort a synthetic shadow object after committing a leased spool checkpoint, reacquire its stub, check a new instance boot marker and persisted state, then resume and freeze it. The tool action to run `node experiments/audit-snapshot/shadow-sort-eviction-workerd-test.mjs` was **aborted before dispatch**. It provided no process handle, result, or explanation. The test was not rerun or substituted, so it establishes no eviction, restart, durability, fencing or Workerd behavior. Its source SHA-256 at preparation was `4d37297802593f4be39d3576546fb2826cb86c4512d9a33cbc6d0918a4b8709f`.

This unmounted synthetic test uses a trusted authorization double and does not test a production owner, the pending handler or transfer work, actual snapshot publication, independently authenticated checkpoint state, hosted behavior, Woven or AWS.

The user chose to leave this evidence open while other Phase 1 work continues. This choice does not accept eviction behavior as verified.
