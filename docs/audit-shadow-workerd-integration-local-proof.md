# Audit shadow reader and lease: local Workerd integration

The unmounted `experiments/audit-snapshot/shadow-workerd-integration-test.mjs` builds a diagnostic WASI reactor from Nextgen `b0b74cd4a198428ea9b82910c217259ffc62b65c`, the current MaPi overlay and the retained shadow-reader diagnostic. It uses the existing audit tracing patch and excludes the four native-only SQLite files as in the existing WASI build path. The test then runs the reactor with the real `worker/wasi.js` and `worker/sql.js` host against a disposable local Workerd SQLite Durable Object.

Inside that object, the experimental owner fence, recovery era, copy-on-write shadow schema, reader-use lease and detached-frame callback are connected to the actual pinned Go `ListEvents` statements. Two small events for the trusted synthetic project and one event for a different synthetic project are inserted before the snapshot. After the snapshot, one original event is updated, another is deleted and a new event is inserted. The Go reader returns the two original IDs and categories through a detached frame, excludes the new event, and returns no rows for the separately scoped foreign-project list. The test also rejects a mismatched route generation and a released lease, closes the shadow and confirms the returned frame remains readable. All data and credentials are synthetic; the authorization callback is a local `true` double.

`node experiments/audit-snapshot/shadow-workerd-integration-test.mjs` passed in local Workerd after scoped approval for its loopback listener. The first completed build attempt failed before Workerd startup because the fresh tree lacked the ordinary WASI tracing patch and native SQLite exclusions. After correcting those build transformations, the next completed attempt failed before assertions with sandbox `EPERM` on `127.0.0.1`; the approved local-only run exited 0. The test did not call a hosted service, Woven deployment, real owner, or the interrupted bridge-cursor, size, nonfinite, SQL-limit, malformed SQLite TEXT, normalization, or archive actions.

The successful run recorded these hashes:

| Input or artifact | SHA-256 |
| --- | --- |
| Pinned source tar | `cb2946fcd275059e3a7c5de9dbf786a57dcd797ade27bf75a57f960040945e18` |
| Audit tracing patch | `68a693210940adbd8f31bc908d042dd9dba25e81ca708c59e8faac1f361bd06e` |
| Pinned shadow Go reader diagnostic | `faeca639ea449bdb9bd05ef8441ccc3fa81e1e9202ffabec606da5c755c58f97` |
| Workerd Go adapter | `08b575fdc98c77d0348ef6dbf3b3074a992f7c640ca08233c30e7f07be221a8a` |
| WASI diagnostic main | `5d618647d15ab2b4dfcecd87632e43fd1921d8a8e60ab215d4c08edd8f582f85` |
| Reactor Wasm | `fc2f49b42b72ca0645aaa97a9610149420112db3f625d0e5fbc3e381055bff99` |
| Existing baseline file | `c91d739a66d18c77f837cc334d8e7242aaaaabe6499387703e5ddf067d5ffb98` |
| `worker/wasi.js` | `db00a5f6c361bb4cf80132c0122179f9459a9fd4e7491912e0064bdfa242f80b` |
| `worker/sql.js` | `43fb3a38a9fb3bc21aa3c67df21ff9df8e97d200612e0f9ff6da2ade9f5c3f49` |
| `worker/owner-fence.js` | `fcadb9fa6f23c66d382b8988c590eab6d6390564343adea5fea9e70fdd02df06` |
| `worker/audit-source-capture.js` | `a2e77adb1993fc25b7eaa9f3c640c434cc85d18b4f7dca74d2894b1737b6c214` |
| `shadow-sql.mjs` | `741b09db9d01756f42d972c30292f52f3bf141a8a3294b0c9cd048d14b88fd32` |
| `shadow-lifecycle.mjs` | `069358e4dc65e303ac255302cec83c86e6c185539b0cd97535544fb4d087217d` |
| Generated test Worker | `ee5b9c6766045c443288c7068a69a2eba34654d77397f111ac44df267c467856` |

The retained harness's post-run SHA-256 is `32a5e4b5cbec61c06bf929106a5d1e9ca8ebb8f71640c51db6f73d3a65e19fb1`. The script checks its two copied diagnostic Go files after compilation and rechecks the Worker JS module inputs after the run. The existing baseline and complete overlay/dependency cache were not frozen for the run, and the baseline was not regenerated. The table is the existing generated baseline's event DDL and 12 index definitions; this result does not validate the separate interrupted baseline sequence change.

This test connects previously separate components but **does not implement a deployable audit snapshot**. It calls pinned storage statements, not the public Go handler, real user authentication, claim visibility, `EventsSettledBefore`, upstream page selection or the public wire serializer. It checks no concurrent traffic, actual second owner, retention race, request error ordering, additional-bind limit or hosted platform metrics. The Go reader and SQL bridge still materialize full results, and the diagnostic builds an in-memory JSON projection before applying a 128 KiB frame check; the small test does not establish bounded memory for valid large rows. It does not establish stable tie selection, fragment streaming, complete response integrity, authorized publication, independent manifest protection, reader allocator, quota, cleanup/recovery or crash semantics. The tested Wasm is a diagnostic artifact and has no upload, startup or runtime gate measurement. The interrupted normalization observation and other previously recorded Phase 1 gates remain open.
