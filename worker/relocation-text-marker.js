// The scan marker is a reserved view containing an unpredictable token. DDL
// does not alter SQLite's connection change counters or last insert rowid.
const NAME = 'mapi_relocation_text_preflight_marker';
const TOKEN = /^[0-9a-f]{32}$/;

function definition(token) {
  return `CREATE VIEW ${NAME} AS SELECT '${token}' AS token`;
}

export function readTextPreflightMarker(storage) {
  const rows = storage.sql.exec("SELECT type, sql FROM sqlite_schema WHERE name = ? COLLATE NOCASE LIMIT 2", NAME).toArray();
  if (!rows.length) return null;
  if (rows.length !== 1 || rows[0].type !== 'view' || typeof rows[0].sql !== 'string') throw new Error('Invalid TEXT preflight marker');
  const match = /^CREATE VIEW mapi_relocation_text_preflight_marker AS SELECT '([0-9a-f]{32})' AS token$/.exec(rows[0].sql);
  if (!match || rows[0].sql !== definition(match[1])) throw new Error('Invalid TEXT preflight marker');
  return match[1];
}

// These operations must run inside the caller's synchronous transaction.
export function createTextPreflightMarker(storage, token) {
  if (typeof token !== 'string' || !TOKEN.test(token)) throw new Error('Invalid TEXT preflight token');
  if (readTextPreflightMarker(storage) !== null) throw new Error('TEXT preflight marker already exists');
  storage.sql.exec(definition(token));
  if (readTextPreflightMarker(storage) !== token) throw new Error('TEXT preflight marker creation failed');
}

export function invalidateTextPreflightMarker(storage) {
  const rows = storage.sql.exec("SELECT type, sql FROM sqlite_schema WHERE name = ? COLLATE NOCASE LIMIT 2", NAME).toArray();
  if (rows.length !== 1 || rows[0].type !== 'view' || typeof rows[0].sql !== 'string' ||
      !/^CREATE VIEW mapi_relocation_text_preflight_marker AS SELECT '[0-9a-f]{32}' AS token$/.test(rows[0].sql)) return;
  storage.sql.exec(`DROP VIEW main.${NAME}`);
  if (readTextPreflightMarker(storage) !== null) throw new Error('TEXT preflight marker invalidation failed');
}

export function hasTextPreflightMarker(storage) {
  const rows = storage.sql.exec("SELECT type, sql FROM sqlite_schema WHERE name = ? COLLATE NOCASE LIMIT 2", NAME).toArray();
  return rows.length === 1 && rows[0].type === 'view' && typeof rows[0].sql === 'string' &&
    /^CREATE VIEW mapi_relocation_text_preflight_marker AS SELECT '[0-9a-f]{32}' AS token$/.test(rows[0].sql);
}

// SQLite accepts single-quoted identifiers in some identifier positions.
// Keep those protected without rejecting ordinary strings and comments.
export function assertNoTextPreflightMarkerAccess(statement) {
  if (typeof statement !== 'string') throw new Error('Invalid SQL statement');
  const reserved = new Set([NAME, 'mapi_relocation_text_preflight_seal']);
  const tokens = [];
  const pattern = /--[^\n]*|\/\*[\s\S]*?(?:\*\/|$)|'(?:''|[^'])*(?:'|$)|"(?:""|[^"])*(?:"|$)|`(?:``|[^`])*(?:`|$)|\[[^\]]*(?:\]|$)|[a-zA-Z_\u0080-\u{10ffff}][a-zA-Z_0-9$\u0080-\u{10ffff}]*|[^\s]/gu;
  for (const match of statement.matchAll(pattern)) {
    const token = match[0];
    if (token.startsWith('--') || token.startsWith('/*')) continue;
    tokens.push(token);
  }
  const words = tokens.map(token => token.toLowerCase());
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    let value = token;
    if (token.startsWith("'")) {
      value = token.slice(1, token.endsWith("'") ? -1 : undefined).replaceAll("''", "'").toLowerCase();
      if (!reserved.has(value)) continue;
      let before = index - 1;
      if (words[before] === '.') before -= 2;
      if (['rollback', 'abort', 'replace', 'fail', 'ignore'].includes(words[before]) && words[before - 1] === 'or') before -= 2;
      if (['into', 'update', 'from', 'join', 'view', 'table', 'index', 'trigger', 'on', 'to', 'exists', 'references', 'reindex'].includes(words[before])) throw new Error('Reserved TEXT preflight marker');
      continue;
    }
    if (token.startsWith('"') || token.startsWith('`')) value = token.slice(1, -1).replaceAll(token[0] + token[0], token[0]);
    else if (token.startsWith('[')) value = token.slice(1, -1);
    // Result-column aliases cannot name a schema object. Allow them even
    // when they happen to match a reserved object name.
    if (words[index - 1] === 'as') continue;
    // SQLite permits result aliases without AS. A quoted literal or numeric
    // expression immediately before an identifier cannot be a schema object
    // declaration, so allow this common alias form as well.
    const previous = tokens[index - 1];
    if (previous && (previous.startsWith("'") || /^[0-9]$/.test(previous))) continue;
    if (reserved.has(value.toLowerCase())) throw new Error('Reserved TEXT preflight marker');
  }
}

const SEAL_NAME = 'mapi_relocation_text_preflight_seal';
const SEAL_DDL = 'CREATE TABLE mapi_relocation_text_preflight_seal (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), project_id TEXT NOT NULL, origin TEXT NOT NULL, object_name TEXT NOT NULL, generation INTEGER NOT NULL, move_id TEXT NOT NULL, marker TEXT NOT NULL)';

function validSealIdentity(route, moveId) {
  return route && typeof route.projectId === 'string' && route.projectId &&
    typeof route.origin === 'string' && route.origin && typeof route.objectName === 'string' && route.objectName &&
    Number.isSafeInteger(route.generation) && route.generation > 0 && typeof moveId === 'string' && moveId;
}

export function assertTextPreflightSeal(storage, route, moveId) {
  if (!validSealIdentity(route, moveId)) throw new Error('Invalid TEXT preflight seal identity');
  const sql = storage.sql;
  const objects = sql.exec('SELECT type, sql FROM sqlite_schema WHERE name = ? COLLATE NOCASE LIMIT 2', SEAL_NAME).toArray();
  if (objects.length !== 1 || objects[0].type !== 'table' || objects[0].sql !== SEAL_DDL ||
      sql.exec("SELECT 1 FROM sqlite_schema WHERE tbl_name = ? COLLATE NOCASE AND type IN ('trigger', 'index') AND sql IS NOT NULL LIMIT 1", SEAL_NAME).toArray().length) throw new Error('Invalid TEXT preflight seal schema');
  const marker = readTextPreflightMarker(storage);
  if (!marker) throw new Error('Missing TEXT preflight marker');
  const rows = sql.exec(`SELECT singleton, CASE WHEN project_id = ? AND origin = ? AND object_name = ? AND generation = ? AND move_id = ? AND marker = ? THEN 1 ELSE 0 END AS matches FROM ${SEAL_NAME} LIMIT 2`, route.projectId, route.origin, route.objectName, route.generation, moveId, marker).toArray();
  if (rows.length !== 1 || rows[0].singleton !== 1 || rows[0].matches !== 1) throw new Error('TEXT preflight seal mismatch');
  return marker;
}

// The caller must hold the same transaction that verifies and freezes the owner.
export function writeTextPreflightSeal(storage, route, moveId, marker) {
  if (!validSealIdentity(route, moveId) || typeof marker !== 'string' || !TOKEN.test(marker) || readTextPreflightMarker(storage) !== marker) throw new Error('TEXT preflight marker mismatch');
  const sql = storage.sql;
  const exists = sql.exec('SELECT 1 FROM sqlite_schema WHERE name = ? COLLATE NOCASE LIMIT 1', SEAL_NAME).toArray().length;
  if (!exists) {
    sql.exec(SEAL_DDL);
    sql.exec(`INSERT INTO ${SEAL_NAME} VALUES (1, ?, ?, ?, ?, ?, ?)`, route.projectId, route.origin, route.objectName, route.generation, moveId, marker);
  }
  if (assertTextPreflightSeal(storage, route, moveId) !== marker) throw new Error('TEXT preflight seal mismatch');
}
