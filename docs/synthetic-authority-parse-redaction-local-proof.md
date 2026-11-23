# Synthetic archive authority parse-error redaction

The unmounted synthetic authority reads a stored JSON job head before
checking its canonical structure. A corrupted or administratively modified
head can cause a native JSON parser exception whose message may include the
stored bytes. `SyntheticArchiveAuthority.read` now replaces that parse error
with the fixed `Invalid authority job` error; it does not forward the original
exception or attach it as a cause. The existing stored-sealing parser already
uses a fixed error. This does not authenticate the authority's data, prevent
privileged rollback, establish an independent authority, or integrate archive
restore.

`node scripts/test-synthetic-archive-authority.mjs` passed in disposable local
workerd after scoped approval for its loopback listener. Its fault fixture
replaces a synthetic job head with a malformed private marker and checks both
the direct `read` path and the stored-sealing validation in verifier `create`.
For each path a test-only method inspects the original error inside the
Durable Object, requiring the fixed message, an absent cause and a stack that
does not contain the marker. The test also exercises
the authority's transactional CAS, policy registration, corrupt-state rejection,
lost acknowledgements, isolation, and restart. The first run exited before
assertions because the sandbox denied `127.0.0.1` listening with `EPERM`; the
approved local-only run exited 0. After the stronger in-object error checks
were added, the final approved run completed as session 71299 with exit 0.
No Woven or AWS resource was accessed.

The test-only in-object inspection and HTTP wrapper do not prove that all
platform logs, downstream consumers, or other provider methods redact arbitrary
hostile objects. This is not the interrupted combined archive test, a real
recovery service-binding restore, independent custody, or a hosted rehearsal.
