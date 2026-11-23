# Audit shadow guard: local Workerd check

A subsequent local run added a reader callback that inserts and deletes a row
before returning a frame. The updated guard rejected it and left the marker
empty and lease active. The normal and authorization-write cases also passed.
The three TEMP fixture creations again failed with `SQLITE_AUTH` before the
guards ran. This run used `shadow-lifecycle.mjs` SHA-256
`24da09b7c548e6fc9298b6f48405c52c74c4a5bbe6700eddbd7101e24a6ad7dc`;
the other module hashes were unchanged from the earlier run below. This is a
small, unmounted helper check, not an authenticated owner or hosted test.

`node scripts/test-audit-shadow-guards-workerd.mjs` passed against disposable local Workerd SQLite. It uses the pinned event DDL and indexes, synthetic owner fence and recovery era, and a trusted test authorization callback; it is not the application handler or a deployed owner. The normal begin, reader acquisition and release path succeeded. A callback that inserted and deleted a row was rejected, leaving both the marker and reader table empty. This locally exercises `total_changes()` and transactional rollback for that case.

The script attempted to create a TEMP trigger on events, a TEMP trigger on the reader table, and a TEMP table shadow. All three statements failed with `SQLITE_AUTH` before the guards ran, so the run provides no Workerd assertion that those guards reject hostile TEMP objects. Separate native tests exercise those cases. The observed local denial does not prove that every supported deployment configuration prohibits such objects.

The passing run used SHA-256 `fa6b0e54d8c048ce3592d27712dc06439fb5be6ba0fc8b8459a5f6d85ea412ed` for `shadow-lifecycle.mjs`, `d2f9eb42eef817e61749ccb274ffd9586ab542fc7af45b3b3b6f293b2aa2a1ad` for `shadow-sql.mjs`, `dd11a3a24efcc813a3e1a1ddfe704ae9e52e2441ab1df7e598e5c92a5d60fa7d` for `owner-fence.js`, and `a3306b3d6be1614e8171a25ef92ce91b058d0a455db3e945b8cdf668f0cb7fc0` for `audit-source-capture.js`. An initial attempt failed to start due to a missing local module; it was corrected before this pass.

The prototype remains unmounted. This result does not establish bearer authorization, a bounded complete snapshot, full audit response fidelity, host resource bounds, recovery or hosted behavior. No Woven deployment, AWS resource, real project, pending handler diagnostic, or interrupted transfer test was touched.
