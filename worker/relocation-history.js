import { RELOCATION_CHUNK_VERSION } from './relocation-values.js';

// Read-only verification of the transfer journal. One invocation reads at most
// one bounded source chunk and one destination digest; the registry persists
// the ordered cursor. Fences and checkpoints are rechecked around async hashing.
const MAX_CONTENT_BYTES = 128 * 1024;
const MAX_SAFE = Number.MAX_SAFE_INTEGER;
const encoder = new TextEncoder();
const digestOK = value => typeof value === 'string' && value.length === 64 && /^[0-9a-f]{64}$/.test(value);
const one = (storage, sql, ...args) => storage.sql.exec(sql, ...args).toArray()[0];

const definitions = {
  mapi_chunk_export: 'CREATE TABLE mapi_chunk_export (project_id TEXT PRIMARY KEY, generation INTEGER NOT NULL, move_id TEXT NOT NULL, tables TEXT NOT NULL, table_index INTEGER NOT NULL, row_offset INTEGER NOT NULL, next_chunk INTEGER NOT NULL, chain TEXT NOT NULL, done INTEGER NOT NULL, cursor TEXT, fragment_offset INTEGER NOT NULL DEFAULT 0)',
  mapi_chunk_export_data: 'CREATE TABLE mapi_chunk_export_data (project_id TEXT NOT NULL, chunk_index INTEGER NOT NULL, content TEXT NOT NULL, digest TEXT, PRIMARY KEY(project_id, chunk_index))',
  mapi_chunk_import: 'CREATE TABLE mapi_chunk_import (project_id TEXT PRIMARY KEY, generation INTEGER NOT NULL, move_id TEXT NOT NULL, object_name TEXT NOT NULL, tables TEXT NOT NULL, table_index INTEGER NOT NULL, row_offset INTEGER NOT NULL, next_chunk INTEGER NOT NULL, chain TEXT NOT NULL, done INTEGER NOT NULL)',
  mapi_chunk_import_data: 'CREATE TABLE mapi_chunk_import_data (project_id TEXT NOT NULL, chunk_index INTEGER NOT NULL, digest TEXT NOT NULL, PRIMARY KEY(project_id, chunk_index))',
};
const normalize = text => text.replace(/[ \t\r\n\f]+/g, ' ').replace(/^ +| +$/g, '');

function validateTable(storage, name, projectId, nullableProject) {
  const definition = one(storage, "SELECT CASE WHEN typeof(sql)='text' AND length(CAST(sql AS BLOB))<=4096 THEN sql ELSE NULL END AS sql FROM sqlite_schema WHERE type='table' AND name=?", name)?.sql;
  if (typeof definition !== 'string' || normalize(definition) !== definitions[name] ||
      one(storage, "SELECT 1 FROM sqlite_schema WHERE tbl_name=? AND type IN ('index','trigger') AND sql IS NOT NULL LIMIT 1", name)) throw Error('Transfer history schema differs');
  if ((nullableProject && one(storage, `SELECT 1 FROM ${name} WHERE project_id IS NULL LIMIT 1`)) ||
      one(storage, `SELECT 1 FROM ${name} WHERE project_id < ? LIMIT 1`, projectId) ||
      one(storage, `SELECT 1 FROM ${name} WHERE project_id > ? LIMIT 1`, projectId)) throw Error('Foreign transfer history');
}

function validateRoute(route, moveId) {
  if (!route || typeof route.projectId !== 'string' || !route.projectId || typeof route.origin !== 'string' || !route.origin ||
      typeof route.objectName !== 'string' || !route.objectName || !Number.isSafeInteger(route.generation) || route.generation < 1 ||
      typeof moveId !== 'string' || !moveId) throw Error('Invalid transfer history identity');
}

function sourceFence(storage, route, moveId, expectedDigest) {
  const ownerFence = one(storage, "SELECT 1 FROM sqlite_schema WHERE type='table' AND name='mapi_owner_fence'");
  if (ownerFence) {
    if (!one(storage, "SELECT 1 FROM mapi_owner_fence WHERE singleton=1 AND project_id=? AND origin=? AND object_name=? AND generation=? AND state='frozen' AND move_id=? AND digest=?", route.projectId, route.origin, route.objectName, route.generation, moveId, expectedDigest) ||
        one(storage, 'SELECT 1 FROM mapi_relocation_project WHERE project_id=? LIMIT 1', route.projectId)) throw Error('Source transfer fence differs');
  } else if (!one(storage, "SELECT 1 FROM mapi_relocation_project WHERE project_id=? AND object_name=? AND generation=? AND state='frozen' AND move_id=? AND digest=?", route.projectId, route.objectName, route.generation, moveId, expectedDigest)) throw Error('Source transfer fence differs');
}

function destinationFence(storage, route, moveId, expectedDigest) {
  if (one(storage, "SELECT 1 FROM sqlite_schema WHERE type='table' AND name='mapi_owner_fence'") ||
      !one(storage, "SELECT 1 FROM mapi_relocation_project WHERE project_id=? AND object_name=? AND generation=? AND state='staged' AND move_id=? AND digest=?", route.projectId, route.objectName, route.generation + 1, moveId, expectedDigest)) throw Error('Destination transfer fence differs');
}

function status(storage, role, route, moveId, expectedDigest) {
  validateRoute(route, moveId);
  const formatTable = one(storage, "SELECT 1 FROM sqlite_schema WHERE type='table' AND name='mapi_chunk_format'");
  const format = formatTable && one(storage, 'SELECT version FROM mapi_chunk_format WHERE project_id=? AND move_id=?', route.projectId, moveId);
  if (!format || format.version !== RELOCATION_CHUNK_VERSION) throw Error('Legacy relocation chunk checkpoint requires manual review');
  if (!digestOK(expectedDigest) || route.generation >= MAX_SAFE) throw Error('Invalid transfer history digest');
  const source = role === 'source';
  if (!source && role !== 'destination') throw Error('Invalid transfer history role');
  const checkpoint = source ? 'mapi_chunk_export' : 'mapi_chunk_import';
  const journal = source ? 'mapi_chunk_export_data' : 'mapi_chunk_import_data';
  validateTable(storage, checkpoint, route.projectId, true);
  validateTable(storage, journal, route.projectId, false);
  if (source) sourceFence(storage, route, moveId, expectedDigest);
  else destinationFence(storage, route, moveId, expectedDigest);
  const extra = source ? '' : ' AND object_name=?';
  const args = [route.projectId, route.generation, moveId, expectedDigest, ...(source ? [] : [route.objectName])];
  const record = one(storage, `SELECT CASE WHEN typeof(next_chunk)='integer' AND next_chunk BETWEEN 1 AND ${MAX_SAFE} THEN next_chunk ELSE NULL END AS total FROM ${checkpoint} WHERE project_id=? AND generation=? AND move_id=? AND done=1 AND chain=?${extra}`, ...args);
  if (!record || !Number.isSafeInteger(record.total) || record.total < 1 ||
      one(storage, `SELECT 1 FROM ${journal} WHERE project_id=? AND chunk_index < 0 LIMIT 1`, route.projectId) ||
      one(storage, `SELECT 1 FROM ${journal} WHERE project_id=? AND chunk_index >= ? LIMIT 1`, route.projectId, record.total)) throw Error('Invalid transfer history checkpoint');
  return { total: record.total, digest: expectedDigest };
}

export function transferHistoryStatus(storage, role, route, moveId, digest) {
  return storage.transactionSync(() => status(storage, role, route, moveId, digest));
}

function sourceChunk(storage, route, moveId, digest, index) {
  const current = status(storage, 'source', route, moveId, digest);
  if (!Number.isSafeInteger(index) || index < 0 || index >= current.total) throw Error('Invalid transfer history index');
  const row = one(storage, `SELECT CASE WHEN typeof(chunk_index)='integer' AND chunk_index BETWEEN 0 AND ${MAX_SAFE} THEN chunk_index ELSE NULL END AS actual_index, CASE WHEN typeof(content)='text' AND length(CAST(content AS BLOB))<=? THEN content ELSE NULL END AS content, CASE WHEN typeof(digest)='text' AND length(CAST(digest AS BLOB))=64 THEN digest ELSE NULL END AS digest FROM mapi_chunk_export_data WHERE project_id=? AND chunk_index>? ORDER BY chunk_index LIMIT 1`, MAX_CONTENT_BYTES, route.projectId, index - 1);
  if (!row || row.actual_index !== index || typeof row.content !== 'string' || !digestOK(row.digest) ||
      (index === current.total - 1 && one(storage, 'SELECT 1 FROM mapi_chunk_export_data WHERE project_id=? AND chunk_index>? LIMIT 1', route.projectId, index))) throw Error('Missing or invalid source transfer history');
  return { ...current, content: row.content, chunkDigest: row.digest };
}

export async function sourceTransferHistory(storage, route, moveId, digest, index) {
  const before = storage.transactionSync(() => sourceChunk(storage, route, moveId, digest, index));
  // Invalid stored UTF-8 can expand when decoded into JavaScript. This size
  // check bounds re-encoding; it does not establish lossless TEXT semantics.
  if (before.content.length > MAX_CONTENT_BYTES) throw Error('Source transfer history exceeds limit');
  const encoded = encoder.encode(before.content);
  if (encoded.length > MAX_CONTENT_BYTES) throw Error('Source transfer history exceeds limit');
  let payload;
  try { payload = JSON.parse(before.content); } catch { throw Error('Invalid source transfer history'); }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || payload.format !== RELOCATION_CHUNK_VERSION || payload.projectId !== route.projectId ||
      payload.generation !== route.generation || payload.moveId !== moveId || payload.index !== index ||
      typeof payload.done !== 'boolean' || payload.done !== (index === before.total - 1) ||
      (payload.done && payload.last !== true) || !(index === 0 ? payload.prev === '' : digestOK(payload.prev))) throw Error('Invalid source transfer history');
  const computed = [...new Uint8Array(await crypto.subtle.digest('SHA-256', encoded))].map(byte => byte.toString(16).padStart(2, '0')).join('');
  if (computed !== before.chunkDigest) throw Error('Source transfer history digest differs');
  storage.transactionSync(() => {
    const after = sourceChunk(storage, route, moveId, digest, index);
    if (after.total !== before.total || after.digest !== before.digest || after.chunkDigest !== before.chunkDigest || after.content !== before.content) throw Error('Source transfer history changed');
  });
  return { total: before.total, digest, index, previous: payload.prev, chunkDigest: computed, done: payload.done };
}

export function destinationTransferHistory(storage, route, moveId, digest, index) {
  return storage.transactionSync(() => {
    const current = status(storage, 'destination', route, moveId, digest);
    if (!Number.isSafeInteger(index) || index < 0 || index >= current.total) throw Error('Invalid transfer history index');
    const row = one(storage, `SELECT CASE WHEN typeof(chunk_index)='integer' AND chunk_index BETWEEN 0 AND ${MAX_SAFE} THEN chunk_index ELSE NULL END AS actual_index, CASE WHEN typeof(digest)='text' AND length(CAST(digest AS BLOB))=64 THEN digest ELSE NULL END AS digest FROM mapi_chunk_import_data WHERE project_id=? AND chunk_index>? ORDER BY chunk_index LIMIT 1`, route.projectId, index - 1);
    if (!row || row.actual_index !== index || !digestOK(row.digest) ||
        (index === current.total - 1 && one(storage, 'SELECT 1 FROM mapi_chunk_import_data WHERE project_id=? AND chunk_index>? LIMIT 1', route.projectId, index))) throw Error('Missing or invalid destination transfer history');
    return { ...current, index, chunkDigest: row.digest };
  });
}
