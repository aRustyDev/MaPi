# Synthetic archive read-result boundary

The unmounted synthetic archive now snapshots each bounded inventory page's object keys, truncated flag and cursor once before validating it. Exceptions from those result accessors are replaced with a fixed inventory error. Stream result `done` and `value` accessors are similarly guarded, completion must be a boolean, and byte count is taken from the intrinsic typed-array length rather than a possibly shadowed `length` property. The latter prevents a modified adapter result from making a nonempty buffer appear empty to the reader. Failed stream reads still cancel the reader without waiting.

The distinct local command `node scripts/test-archive-result-accessors.mjs` passed using an in-memory bucket and KMS double. It covered throwing stream completion/value accessors, malformed completion, a shadowed byte-array length, throwing inventory object/flag/key/cursor accessors, reader cancellation, and a successful retry and seal. Each synthetic exception contained a marker; the test required the fixed error with no marker in its stack or cause. The first test invocation failed because the test reused one fake stream across two separate selector reads, leaving its second read empty. The harness was corrected to create a fresh stream per get; the final command passed.

A subsequent change checks that each selector key has exactly the expected prefix length plus 16 characters before deriving its suffix, across the legacy and both bounded inventory paths. The accessor test passed with a synthetic oversized key, as did the bounded-sealing and read-only-authority checks below. This prevents an extra oversized substring allocation; it does not bound memory already allocated by an adapter or establish Cloudflare R2 key limits.

The following existing Node checks also passed after the change:

```sh
node scripts/test-archive-parse-redaction.mjs
node scripts/test-synthetic-archive-bounded-sealing.mjs
node scripts/test-synthetic-archive-readonly-authority.mjs
```

These are small local tests, not the previously interrupted combined workerd archive test, scale fixture, hosted run, real importer or AWS integration. They do not establish complete redaction for arbitrary hostile objects or downstream callbacks and logs, R2 behavior, independent key custody, independently authenticated source commitments, immutable storage, full recovery integration, or authorization to activate a destination. In particular, destination callback errors remain uncertain until the caller reconciles durable target state. No Woven or AWS resource was changed.
