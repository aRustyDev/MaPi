# Recovery token authority query: local bound

The recovery token guard checks an owner authority formed by joining the project and recovery-era rows. It rejects zero rows and more than one row. The SQL query now uses `LIMIT 2` so that only the rows needed for that decision cross the SQL bridge, even if the underlying tables contain many rows. The guard's zero-, one- and multiple-row decisions remain unchanged.

`node scripts/test-recovery-token-authority-query.mjs` passed against native in-memory SQLite. It executes the query read from the production Go source, checks empty and single-row cases and duplicate ambiguity, and checks that a Cartesian product of 1,000 project rows and 1,000 era rows returns two rows. This bounds returned row count, not SQLite's internal scan or the size or encoding of individual values. It does not exercise the Go guard, workerd bridge, recovery provisioning, hosted behavior, PITR or reopening. Recovery remains disabled.
