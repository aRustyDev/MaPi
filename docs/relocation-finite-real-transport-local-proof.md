# Finite REAL transport: local Workerd check

`node scripts/test-relocation-integral-real.mjs` passed in a disposable local
workerd SQLite Durable Object. The source and destination tables used BLOB
affinity, so integer-valued REAL values would not be converted back to REAL by
a REAL-affinity column. Source rows were created in SQLite as finite REAL 1.0
and 1.5. The test read each through the current `worker/sql.js` query bridge,
serialized and parsed its transport value as JSON, and wrote it through that
bridge into the destination table. SQLite `typeof` remained `real` and each
numeric value matched the source.

The initial sandboxed invocation exited before assertions because the local
loopback listener received `EPERM`. The same command passed after scoped
approval for the local-only listener. Test SHA-256 was
`01db28ab798ee1c34c15700fbe1037938722c77b38697ead228906fcaf56534b`;
`worker/sql.js` SHA-256 was
`43fb3a38a9fb3bc21aa3c67df21ff9df8e97d200612e0f9ff6da2ade9f5c3f49`.

This is a small, finite-value transport check in one synthetic object. It does
not run the actual chunk exporter/importer, multiple projects, interruption or
retry; does not validate all finite REAL bit patterns; and is not a platform
row-limit, nonfinite, cursor, SQL-limit, real-owner, history or hosted test.
It does not close the SQLite or relocation gate. No Woven or AWS resources
were accessed, and the previously interrupted actions were not retried.
