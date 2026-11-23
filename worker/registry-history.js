// Registry-owned resumable verification of staged transfer receipts. These
// helpers are called only from the registry's synchronous transactions.
const CREATE = `CREATE TABLE IF NOT EXISTS mapi_move_history_verification (project_id TEXT NOT NULL, move_id TEXT NOT NULL, source_object TEXT NOT NULL, destination_object TEXT NOT NULL, generation INTEGER NOT NULL, total_chunks INTEGER NOT NULL, next_index INTEGER NOT NULL, chain TEXT NOT NULL, final_digest TEXT NOT NULL, complete INTEGER NOT NULL, PRIMARY KEY(project_id, move_id))`;
const EXPECTED = 'CREATE TABLE mapi_move_history_verification (project_id TEXT NOT NULL, move_id TEXT NOT NULL, source_object TEXT NOT NULL, destination_object TEXT NOT NULL, generation INTEGER NOT NULL, total_chunks INTEGER NOT NULL, next_index INTEGER NOT NULL, chain TEXT NOT NULL, final_digest TEXT NOT NULL, complete INTEGER NOT NULL, PRIMARY KEY(project_id, move_id))';
const MAX_SAFE = Number.MAX_SAFE_INTEGER;
const digestOK = value => typeof value === 'string' && value.length === 64 && /^[0-9a-f]{64}$/.test(value);
const one = (sql, query, ...args) => sql.exec(query, ...args).toArray()[0];
const normalize = text => text.replace(/[ \t\r\n\f]+/g, ' ').replace(/^ +| +$/g, '');

export function validateHistoryVerificationSchema(sql) {
  const row = one(sql, "SELECT CASE WHEN typeof(sql)='text' AND length(CAST(sql AS BLOB))<=4096 THEN sql ELSE NULL END AS sql FROM sqlite_schema WHERE type='table' AND name='mapi_move_history_verification'");
  if (!row || typeof row.sql !== 'string' || normalize(row.sql) !== EXPECTED ||
      one(sql, "SELECT 1 FROM sqlite_schema WHERE tbl_name='mapi_move_history_verification' AND type IN ('index','trigger') AND sql IS NOT NULL LIMIT 1")) throw Error('Transfer history verification schema differs');
}

export function ensureHistoryVerificationSchema(sql) {
  sql.exec(CREATE);
  validateHistoryVerificationSchema(sql);
}

function validIdentity(identity) {
  return identity && typeof identity.projectId === 'string' && identity.projectId && typeof identity.moveId === 'string' && identity.moveId &&
    typeof identity.sourceObject === 'string' && identity.sourceObject && typeof identity.destinationObject === 'string' && identity.destinationObject &&
    Number.isSafeInteger(identity.generation) && identity.generation >= 1 && identity.generation < MAX_SAFE;
}

// SQL predicates compare potentially damaged identity fields without returning
// them to JavaScript. CASE projections bound all returned checkpoint values.
export function readHistoryCheckpoint(sql, identity, total, finalDigest) {
  if (!validIdentity(identity) || !Number.isSafeInteger(total) || total < 1 || !digestOK(finalDigest)) throw Error('Invalid transfer history identity');
  validateHistoryVerificationSchema(sql);
  const { projectId, moveId, sourceObject, destinationObject, generation } = identity;
  const exists = one(sql, 'SELECT 1 FROM mapi_move_history_verification WHERE project_id=? AND move_id=?', projectId, moveId);
  if (!exists) return null;
  const row = one(sql, `SELECT CASE WHEN typeof(total_chunks)='integer' AND total_chunks BETWEEN 1 AND ${MAX_SAFE} THEN total_chunks ELSE NULL END AS total, CASE WHEN typeof(next_index)='integer' AND next_index BETWEEN 0 AND ${MAX_SAFE} THEN next_index ELSE NULL END AS next, CASE WHEN typeof(chain)='text' AND length(CAST(chain AS BLOB))<=64 THEN chain ELSE NULL END AS chain, CASE WHEN typeof(complete)='integer' AND complete IN (0,1) THEN complete ELSE NULL END AS complete FROM mapi_move_history_verification WHERE project_id=? AND move_id=? AND source_object=? AND destination_object=? AND generation=? AND total_chunks=? AND final_digest=?`, projectId, moveId, sourceObject, destinationObject, generation, total, finalDigest);
  if (!row || row.total !== total || !Number.isSafeInteger(row.next) || row.next < 0 || row.next > total ||
      !(row.complete === 0 || row.complete === 1) || (row.complete === 1) !== (row.next === total) ||
      !(row.next === 0 ? row.chain === '' : digestOK(row.chain)) || (row.complete && row.chain !== finalDigest)) throw Error('Invalid transfer history verification checkpoint');
  return row;
}

export function initializeHistoryCheckpoint(sql, identity, total, finalDigest) {
  ensureHistoryVerificationSchema(sql);
  const prior = readHistoryCheckpoint(sql, identity, total, finalDigest);
  if (prior) return prior;
  const { projectId, moveId, sourceObject, destinationObject, generation } = identity;
  sql.exec('INSERT INTO mapi_move_history_verification VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, 0)', projectId, moveId, sourceObject, destinationObject, generation, total, '', finalDigest);
  return readHistoryCheckpoint(sql, identity, total, finalDigest);
}

export function advanceHistoryCheckpoint(sql, identity, total, finalDigest, previous, nextDigest) {
  if (!previous || !Number.isSafeInteger(previous.next) || previous.complete !== 0 || previous.next >= total || !digestOK(nextDigest)) throw Error('Invalid transfer history progress');
  const current = readHistoryCheckpoint(sql, identity, total, finalDigest);
  if (!current || current.next !== previous.next || current.chain !== previous.chain || current.complete !== previous.complete) throw Error('Transfer history checkpoint changed; retry');
  const next = current.next + 1, complete = next === total;
  if (complete && nextDigest !== finalDigest) throw Error('Transfer history final digest differs');
  sql.exec('UPDATE mapi_move_history_verification SET next_index=?, chain=?, complete=? WHERE project_id=? AND move_id=?', next, nextDigest, complete ? 1 : 0, identity.projectId, identity.moveId);
  return readHistoryCheckpoint(sql, identity, total, finalDigest);
}

export function completedHistoryCheckpoint(sql, identity, finalDigest) {
  if (!validIdentity(identity) || !digestOK(finalDigest)) return false;
  if (!one(sql, "SELECT 1 FROM sqlite_schema WHERE type='table' AND name='mapi_move_history_verification'")) return false;
  validateHistoryVerificationSchema(sql);
  const { projectId, moveId, sourceObject, destinationObject, generation } = identity;
  return !!one(sql, `SELECT 1 FROM mapi_move_history_verification WHERE project_id=? AND move_id=? AND source_object=? AND destination_object=? AND generation=? AND typeof(total_chunks)='integer' AND total_chunks BETWEEN 1 AND ${MAX_SAFE} AND typeof(next_index)='integer' AND next_index=total_chunks AND typeof(complete)='integer' AND complete=1 AND typeof(chain)='text' AND chain=? AND typeof(final_digest)='text' AND final_digest=?`, projectId, moveId, sourceObject, destinationObject, generation, finalDigest, finalDigest);
}
