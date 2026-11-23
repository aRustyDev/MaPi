// Compare singleton identity values in SQLite instead of returning potentially
// large stored values to JavaScript. Callers still provide the expected value;
// the RPC input and SQLite's own work are not bounded by this helper.
const queries = {
  project: "SELECT CASE WHEN typeof(id) = 'text' AND id COLLATE BINARY = ? THEN 1 ELSE 0 END AS matches FROM projects LIMIT 2",
  owner: "SELECT CASE WHEN typeof(project_id) = 'text' AND project_id COLLATE BINARY = ? THEN 1 ELSE 0 END AS matches FROM mapi_project LIMIT 2",
  origin: "SELECT CASE WHEN typeof(origin) = 'text' AND origin COLLATE BINARY = ? THEN 1 ELSE 0 END AS matches FROM mapi_project_origin LIMIT 2",
};

export function sourceIdentityMatches(storage, kind, expected) {
  if (!Object.hasOwn(queries, kind) || typeof expected !== 'string') return false;
  // SQLite binding replaces an isolated UTF-16 surrogate with U+FFFD. Such a
  // value cannot equal a string read from SQLite under the former strict JS
  // comparison, so reject it before binding rather than accepting replacement.
  for (const char of expected) {
    const code = char.codePointAt(0);
    if (code >= 0xd800 && code <= 0xdfff) return false;
  }
  const rows = storage.sql.exec(queries[kind], expected).toArray();
  return rows.length === 1 && rows[0].matches === 1;
}
