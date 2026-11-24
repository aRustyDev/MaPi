# Shadow sort eviction: local diagnostic

A new `node experiments/audit-snapshot/shadow-sort-eviction-workerd-test.mjs` run passed in disposable local Workerd. It aborts a synthetic shadow object after committing a leased spool checkpoint, reacquires its stub, checks a new instance boot marker and persisted state, then resumes and freezes it. The test source SHA-256 was `4d37297802593f4be39d3576546fb2826cb86c4512d9a33cbc6d0918a4b8709f`; the lifecycle module was `94b821c7a95d971d764f0d7292d982248174f8aad94d9a602499758ed263fd0c`. This is a separate completed run, not a result from the earlier action aborted before dispatch.

This unmounted synthetic test uses a trusted authorization double and does not test a production owner, the pending handler or transfer work, actual snapshot publication, independently authenticated checkpoint state, hosted behavior, Woven or AWS.

This verifies only the synthetic local eviction and fenced-resume case described above. It does not close the production audit snapshot or independent checkpoint gates.
