# Synthetic archive error boundaries: local check

The unmounted synthetic archive API previously allowed a native JSON parser error to reach its caller. Node 26.9.0 included a complete short synthetic payload in that error. `sourceChunk` and the canonical archive-record decoder now turn parse and UTF-8 decode failures into fixed messages. Existing identity, canonicality, checksum and authentication errors remain distinct.

The archive's read-only bucket operations, stream reader construction and reads, and authority reads now return fixed availability errors when an external implementation throws. Cancellation remains `Archive operation canceled`. The destination adapter receives decrypted project data: its `load` failure now returns a fixed unavailable message; failures from `begin`, `apply`, or `finish` return `Archive destination outcome uncertain; reconciliation required` without attaching the original exception or its stack as a cause. A failed mutating callback may have committed, so the caller must reload and reconcile the durable private destination before retry or publication. These changes do not authorize or perform route activation. The existing synthetic KMS key generation and recovery entry points separately catch provider failures and report generic errors; this focused test does not establish redaction throughout the AWS SDK, its logging, or other providers.

In the isolated implementation checkout, the following completed with exit status 0:

```sh
node scripts/test-archive-parse-redaction.mjs
node scripts/test-synthetic-archive-readonly-authority.mjs
node scripts/test-synthetic-archive-bounded-sealing.mjs
```

The focused test's initial run before the fix exited 1 and demonstrated that a malformed synthetic source chunk's parser error contained its marker. After the fix it tests malformed source and selector JSON, malformed selector UTF-8, throwing bucket get/list/reader operations, a throwing authority read, and destination read plus all three destination write failures. The mock destination commits its checkpoint before throwing for each write phase, and a retry completes with exactly one chunk application. An in-flight aborted read is still classified as cancellation. All data, keys and destination state are synthetic and in memory; the second and third commands use their existing local test fixtures. No Woven or AWS resources were used, and none of these commands is the interrupted combined Workerd archive test or the interrupted scale fixture.

These checks do not prove that every possible exception from arbitrary caller-supplied JavaScript objects, serialization hooks, generated accessors, another worker, the real importer, or platform runtime is sanitized. In particular, stream-result `done`/`value` properties and bucket-list result properties are accessed outside the read-error wrapper; hostile custom accessors may throw unsanitized messages. They do not establish archive availability, durable or independent authority, trusted source commitments, writer closure, full-scale recovery, Workerd behavior, or safe activation. Existing integrations that classify raw destination exception messages must adopt the new conservative uncertainty contract; they have not been validated here. Authentication and authorization must remain private and separately enforced.
