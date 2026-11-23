# Owner control-table identifier case: source review and native lookup

Status: **application behavior has not been tested and no fix has been applied**. The user chose to accept this potential limitation for now. No Woven resource was accessed.

The `NextgenApplication` constructor and `#detectFence` in `worker/app.js` query `sqlite_schema` using binary comparisons for lowercase control-table names. SQLite resolves ordinary identifiers case-insensitively. The constructor can therefore miss a table stored as `MAPI_OWNER_FENCE`, and the metadata lookup in `#detectFence` can omit the same table. `allowLogin` invokes that detector and checks the owner fence only when its in-memory fence flag is armed. This source review indicates a possible frozen-fence bypass for such a schema; it does **not** prove an application mutation occurred, or that this schema exists in Woven.

A distinct in-memory native SQLite fixture created `MAPI_OWNER_FENCE` with a `frozen` row. The same lowercase metadata-name predicate used in the detector returned zero rows, while `SELECT state FROM mapi_owner_fence` resolved the table and returned `frozen`. The command exited 0 after checking both observations. This establishes only SQLite name-lookup behavior, not the actual app's constructor, throttle path, transaction, Workerd behavior, or deployed schema.

No changes to the app, owner data, deployment, or test fixtures were made. The previously interrupted registry/cutover, real-owner, and route-boundary actions were not rerun or used to establish this result.
