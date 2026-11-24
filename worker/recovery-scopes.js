export const RECOVERY_SCOPE_ROWS = 64;
// Reserve space for the complete RPC envelope below 128 KiB.
export const RECOVERY_SCOPE_BYTES = 124 * 1024;
const encoder = new TextEncoder();

export function validRecoveryStamp(value) {
  return typeof value === 'string' && value.length <= 19 && /^(0|[1-9][0-9]*)$/.test(value) && BigInt(value) <= 9223372036854775807n;
}

// Mirrors encoding/json.Marshal on the pinned Go struct. JSON.stringify has
// the same short/control escapes, but Go additionally escapes HTML and the two
// JavaScript line separators. Go replaces invalid UTF-8, so reject lone UTF-16
// surrogates rather than accepting a spelling Go can never emit.
function canonicalGoScope(kind, args) {
  for (const value of [kind, ...(args ?? [])]) {
    if (typeof value !== 'string') continue;
    for (const char of value) {
      const cp = char.codePointAt(0);
      if (cp >= 0xd800 && cp <= 0xdfff) throw new Error('Invalid or foreign revision scope');
    }
  }
  const escapes = { '<': '\\u003c', '>': '\\u003e', '&': '\\u0026', '\u2028': '\\u2028', '\u2029': '\\u2029' };
  return JSON.stringify({ v: 1, kind, args }).replace(/[<>&\u2028\u2029]/g, char => escapes[char]);
}

// Validate deleted-entity scopes by their pinned Go call shape and owner,
// without requiring the referenced entity to remain in the restored database.
export function validateRecoveryScope(scope, projectId, sql) {
  // A UTF-8 encoding of a well-formed string cannot be shorter than its
  // UTF-16 code-unit length. Reject obviously oversized inputs before making
  // an encoded copy; the RPC itself has already materialized the string.
  if (typeof scope !== 'string' || scope.length > RECOVERY_SCOPE_BYTES / 2 || encoder.encode(scope).length > RECOVERY_SCOPE_BYTES / 2 || typeof projectId !== 'string' || !projectId) throw new Error('Invalid or foreign revision scope');
  let value;
  try { value = JSON.parse(scope); } catch { throw new Error('Invalid or foreign revision scope'); }
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.v !== 1 || typeof value.kind !== 'string' || Object.keys(value).length !== 3 || !Object.hasOwn(value, 'args')) throw new Error('Invalid or foreign revision scope');
  const counts = sql.exec("SELECT COUNT(*) AS n, COUNT(DISTINCT key) AS names, json_type(?, '$.v') AS version_type FROM json_each(?) WHERE key IN ('v', 'kind', 'args')", scope, scope).one();
  if (counts.n !== 3 || counts.names !== 3 || counts.version_type !== 'integer') throw new Error('Invalid or foreign revision scope');
  const args = value.args;
  let valid = false;
  switch (value.kind) {
    case 'project-create': valid = args === null; break;
    case 'project-update': case 'project-origin': valid = Array.isArray(args) && args.length === 1 && args[0] === projectId; break;
    case 'event': valid = Array.isArray(args) && args.length === 2 && args[0] === projectId && args[1] === projectId; break;
    case 'json-schema': valid = Array.isArray(args) && args.length === 2 && args[0] === projectId && (args[1] === null || typeof args[1] === 'string'); break;
    case 'team-update': case 'user-update': case 'user-password': case 'idp-revision': case 'application-revision': case 'policy-revision': case 'flow-definition':
      valid = Array.isArray(args) && args.length === 2 && args[0] === projectId && typeof args[1] === 'string' && !!args[1]; break;
  }
  if (!valid) throw new Error('Invalid or foreign revision scope');
  if (canonicalGoScope(value.kind, args) !== scope) throw new Error('Noncanonical revision scope');
}

// SQLite BINARY compares the UTF-8 byte sequence, not JS UTF-16 code units.
function compareScopeBytes(a, b) {
  const left = encoder.encode(a), right = encoder.encode(b);
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    if (left[i] !== right[i]) return left[i] < right[i] ? -1 : 1;
  }
  return Math.sign(left.length - right.length);
}

// Validate the owner's page independently before hashing or persisting it.
// The page has already crossed RPC, so this bounds only subsequent work.
export function validateRecoveryScopePage(page, projectId, previous, highwater, sql) {
  const keys = (value, expected) => value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === expected.length && Object.keys(value).every((key, i) => key === expected[i]);
  if (!keys(page, ['rows', 'cursor', 'done']) || !Array.isArray(page.rows) ||
      page.rows.length > RECOVERY_SCOPE_ROWS || typeof page.done !== 'boolean' ||
      (page.rows.length === 0 && !page.done) ||
      !(page.cursor === null || (typeof page.cursor === 'string' && page.cursor.length <= RECOVERY_SCOPE_BYTES / 2)) ||
      !validRecoveryStamp(highwater)) throw new Error('Invalid recovery scope page');
  if (previous !== null) {
    if (typeof previous !== 'string' || previous.length > RECOVERY_SCOPE_BYTES / 2) throw new Error('Invalid recovery scope cursor');
    validateRecoveryScope(previous, projectId, sql);
  }
  if (page.cursor !== (page.rows.length ? page.rows[page.rows.length - 1]?.scope : previous)) throw new Error('Invalid recovery scope cursor');
  let size = encoder.encode(JSON.stringify({ rows: [], cursor: page.cursor, done: page.done })).length;
  let last = previous;
  for (const [index, row] of page.rows.entries()) {
    if (!keys(row, ['scope', 'stamp'])) throw new Error('Invalid recovery scope page');
    validateRecoveryScope(row.scope, projectId, sql);
    if (!validRecoveryStamp(row.stamp) || BigInt(row.stamp) > BigInt(highwater)) throw new Error('Invalid recovery scope stamp');
    if (last !== null && compareScopeBytes(last, row.scope) >= 0) throw new Error('Recovery scope page did not advance');
    last = row.scope;
    size += encoder.encode(JSON.stringify(row)).length + (index ? 1 : 0);
    if (size > RECOVERY_SCOPE_BYTES) throw new Error('Recovery scope page exceeds limit');
  }
  if (size > RECOVERY_SCOPE_BYTES) throw new Error('Recovery scope page exceeds limit');
}

export function assertRecoveryEnvelope(value) {
  if (encoder.encode(JSON.stringify(value)).length > 128 * 1024) throw new Error('Recovery RPC envelope exceeds limit');
  return value;
}

// One indexed lookup per row keeps SQL materialization bounded to one key,
// even if all 65 candidate keys are near the per-key size limit.
function readPage(sql, projectId, after, query) {
  if (after !== null) validateRecoveryScope(after, projectId, sql);
  const rows = [];
  let cursor = after, done = false;
  for (;;) {
    const row = query(cursor);
    if (!row) { done = true; break; }
    validateRecoveryScope(row.scope, projectId, sql);
    if (!validRecoveryStamp(row.stamp)) throw new Error('Invalid recovery scope stamp');
    const value = { scope: row.scope, stamp: row.stamp };
    if (rows.length === RECOVERY_SCOPE_ROWS || encoder.encode(JSON.stringify({ rows: [...rows, value], cursor: value.scope, done: false })).length > RECOVERY_SCOPE_BYTES) break;
    rows.push(value);
    cursor = value.scope;
  }
  if (!done && !rows.length) throw new Error('Recovery scope exceeds page limit');
  return { rows, cursor, done };
}

export function readOwnerRecoveryScopes(sql, projectId, after = null) {
  const projection = "SELECT CASE WHEN length(CAST(scope AS BLOB)) <= ? THEN scope ELSE NULL END AS safe_scope, typeof(stamp) AS stamp_type, printf('%lld', stamp) AS stamp FROM mapi_revision_scopes";
  return readPage(sql, projectId, after, cursor => {
    const rows = cursor === null
      ? sql.exec(projection + ' ORDER BY mapi_revision_scopes.scope LIMIT 1', RECOVERY_SCOPE_BYTES / 2).toArray()
      : sql.exec(projection + ' WHERE mapi_revision_scopes.scope > ? ORDER BY mapi_revision_scopes.scope LIMIT 1', RECOVERY_SCOPE_BYTES / 2, cursor).toArray();
    if (!rows.length) return null;
    if (rows[0].stamp_type !== 'integer') throw new Error('Invalid recovery scope stamp');
    return { scope: rows[0].safe_scope, stamp: rows[0].stamp };
  });
}

export function readAnchoredRecoveryScopes(sql, recoveryId, projectId, after = null) {
  // Registry anchors are normally written only from validated pages, but a
  // damaged anchor must not force an oversized value into the isolate before
  // validation can reject it. These CASE expressions bound returned values;
  // they do not bound SQLite's own scan or intermediate work.
  const projection = `SELECT
    CASE WHEN typeof(scope) = 'text' AND length(CAST(scope AS BLOB)) <= ? THEN scope ELSE NULL END AS scope,
    CASE WHEN typeof(stamp) = 'text' AND length(CAST(stamp AS BLOB)) <= 19 THEN stamp ELSE NULL END AS stamp
    FROM mapi_recovery_scope_anchors WHERE recovery_id = ? AND project_id = ?`;
  return readPage(sql, projectId, after, cursor => {
    const rows = cursor === null
      ? sql.exec(projection + ' ORDER BY mapi_recovery_scope_anchors.scope LIMIT 1', RECOVERY_SCOPE_BYTES / 2, recoveryId, projectId).toArray()
      : sql.exec(projection + ' AND mapi_recovery_scope_anchors.scope > ? ORDER BY mapi_recovery_scope_anchors.scope LIMIT 1', RECOVERY_SCOPE_BYTES / 2, recoveryId, projectId, cursor).toArray();
    return rows[0] ?? null;
  });
}

export async function recoveryPageDigest(previous, projectId, recoveryId, page) {
  const data = encoder.encode(JSON.stringify({ version: 1, previous, projectId, recoveryId, page }));
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
  return [...digest].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
