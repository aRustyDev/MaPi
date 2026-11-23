# Private relocation parse errors

The private relocation chunk path handles project rows, credentials and audit
content. Native JSON parsing and base64/UTF-8 decoders can include their input
in exception messages. `worker/relocation-chunks.js` now replaces failures
from chunk and checkpoint JSON parsing and fragment decoding with fixed errors
without forwarding the original exception or attaching a cause. Validation
still rejects malformed inputs; no control route or checkpoint protocol was
changed. This does not prove that all SQL, storage, RPC or downstream logging
errors are redacted.

`node scripts/test-relocation-parse-redaction.mjs` passed with synthetic
read-only storage doubles. It sends malformed, digest-matching import content,
a bad digest, and malformed saved export content, table and cursor
checkpoints through the actual exported functions. It checks fixed messages,
the absence of a synthetic private marker in the error stack, no cause, and
no attempted writes. The malformed import and bad digest fail before a
storage transaction. These mocks do not establish real owner or fence behavior.

`node scripts/test-relocation-fragment-redaction.mjs` passed in a disposable
local workerd SQLite Durable Object. It calls the actual `beginChunkImport`
and `importChunk` functions with small synthetic malformed fragment base64,
JSON, nested text/base64, blob/base64 and UTF-8. It checks fixed messages and
no marker in the in-object stack, verifies zero rows, fragment records and
checkpoint advancement after the failures, then imports and identically
replays a valid fragment once. The first sandboxed attempt exited before any
assertion because the local loopback listener received `EPERM`. The approved
local-only run passed, and the final run after adding the blob case passed.

The final tested SHA-256 values are:

- `worker/relocation-chunks.js`: `db5bea3af1b26c6fb91784ab9f7852c8af6e33d471df507cb058815a3afac507`.
- `scripts/test-relocation-parse-redaction.mjs`: `8b45f6196b8c195fc97f534e10b23aa3afeb05e16f1b6adf2c18e29e31356eba`.
- `scripts/test-relocation-fragment-redaction.mjs`: `8051251813e207aacb7bf3e553e2800bdb2de9a2a03ee445d7c7f3091a57607d`.

These small synthetic tests are not the previously interrupted full-history,
real-owner, platform exact-size, nonfinite, cursor/concurrency, SQL-limit or
hosted actions. They do not establish full migration integrity, original
project compatibility, durable writer drain, real-owner recovery or hosted
behavior. No Woven or AWS resource was changed.
