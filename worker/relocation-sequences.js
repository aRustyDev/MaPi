import { execute } from './sql.js';

// The reviewed schema has at most one sequence row. Do not materialize an
// unbounded or malformed sqlite_sequence before checking that invariant.
// SQLite performs the length/type tests; only bounded values cross into JS.
export function readRelocationSequences(storage) {
  const result = execute(storage, { statement: `SELECT
    CASE WHEN typeof(name) = 'text' AND length(CAST(name AS BLOB)) <= 32 THEN name END,
    CASE WHEN typeof(seq) = 'integer' THEN seq END
    FROM sqlite_sequence LIMIT 2`, args: [], query: true });
  if (result.rows.length > 1) throw Error('Unreviewed SQLite sequence');
  for (const [name, value] of result.rows) {
    if (name !== 'goose_db_version' || !value || typeof value.integer !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value.integer) || BigInt(value.integer) > 9223372036854775807n) throw Error('Unreviewed SQLite sequence');
  }
  return result.rows;
}
