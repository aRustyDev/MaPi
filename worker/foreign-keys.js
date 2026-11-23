// The caller must hold the same synchronous transaction as the data being
// checked. Only the existence of a violation matters to relocation; returning
// every violation can otherwise materialize an unbounded result in JavaScript.
// SQLite may still need to scan substantial data before it finds a violation.
export function assertNoForeignKeyViolations(storage, message) {
  // Explicit function-call syntax is important: a same-named table or view
  // must make this fail closed, never shadow the pragma with an empty result.
  const rows = storage.sql.exec('SELECT 1 AS violation FROM main.pragma_foreign_key_check() LIMIT 1').toArray();
  if (rows.length) throw Error(message);
}
