// Chunked relocation support is wired through the owner's private control paths.
// See the Phase 1 status for outstanding data-integrity and preflight gaps.
import { execute, readRelocationRow } from './sql.js';
import { assertNoForeignKeyViolations } from './foreign-keys.js';
import { projectFenceStatus } from './relocation.js';
import { assertRelocationTextGuard, assertRelocationValuesRepresentable, RELOCATION_TEXT_GUARD_VERSION } from './relocation-values.js';
import { inspectStreamRow, makeStreamFragment, encodeStreamOffset, relocationTableInfo, relocationTableDefinition, STREAM_SMALL_ROW_BYTES, STREAM_OFFSET_BASE } from './relocation-stream-export.js';
import { ensureStreamImportSchema, validateStreamImportSchema, streamImportStatus, importStream, STREAM_IMPORT_DDL } from './relocation-stream-import.js';
import { validReconciliationKeys } from './relocation-reconcile-cursor.js';
const MAX_BYTES = 128 * 1024;
const MAX_ROWS = 64;
const FRAGMENT_BYTES = 80 * 1024;
// The value-byte limit is shared by preflight, streaming export and import.
// Preflight independently accounts for SQLite record header and payload bytes.
export const MAX_ROW_VALUE_BYTES = 8_388_608 - 4096;
const MAX_ROW_JSON_BYTES = 12 * 1024 * 1024;
const bytes = text => new TextEncoder().encode(text).length;
const quote = value => '"' + value.replaceAll('"', '""') + '"';
const columns = (storage, table) => relocationTableInfo(storage, table).filter(c => c.hidden === 0).map(c => c.name);
const primaryKey = (storage, table) => relocationTableInfo(storage, table).filter(c => c.pk > 0).sort((a, b) => a.pk - b.pk).map(c => c.name);
const sqlArg = value => value && typeof value === 'object' && 'integer' in value ? { kind: 'int', value: value.integer } : value && typeof value === 'object' && 'blob' in value ? { kind: 'blob', value: value.blob } : { kind: 'value', value };
const one = (storage, sql, ...args) => storage.sql.exec(sql, ...args).toArray()[0];
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
// Control rows are durable input, not trusted JavaScript objects. Bound and
// validate their TEXT bytes in SQLite before bringing them across the bridge.
function boundedControlRow(storage, table, columns, textLimits, where, args, nullable = []) {
 const projection = columns.map(name => {
  const limit = textLimits[name];
  return limit === undefined ? quote(name) : `CASE WHEN ${quote(name)} IS NULL THEN NULL WHEN typeof(${quote(name)}) = 'text' AND octet_length(${quote(name)}) <= ${limit} THEN CAST(${quote(name)} AS BLOB) ELSE 0 END AS ${quote(name)}`;
 }).join(', ');
 const row = one(storage, `SELECT ${projection} FROM ${quote(table)} WHERE ${where} LIMIT 1`, ...args);
 if (!row) return null;
 for (const name of Object.keys(textLimits)) {
  if (row[name] === null && nullable.includes(name)) continue;
  if (!(row[name] instanceof ArrayBuffer)) throw Error('Invalid relocation control data');
  try { row[name] = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(row[name]); }
  catch { throw Error('Invalid relocation control data'); }
 }
 return row;
}
const exportCheckpoint = (storage, id) => boundedControlRow(storage, 'mapi_chunk_export', ['project_id','generation','move_id','tables','table_index','row_offset','next_chunk','chain','done','cursor','fragment_offset','text_guard'], {project_id:4096,move_id:4096,tables:65536,chain:64,cursor:4096}, 'project_id = ?', [id], ['cursor']);
const importCheckpoint = (storage, id) => boundedControlRow(storage, 'mapi_chunk_import', ['project_id','generation','move_id','object_name','tables','table_index','row_offset','next_chunk','chain','done','text_guard'], {project_id:4096,move_id:4096,object_name:4096,tables:65536,chain:64}, 'project_id = ?', [id]);
const exportEntry = (storage, id, index) => boundedControlRow(storage, 'mapi_chunk_export_data', ['content','digest'], {content:MAX_BYTES,digest:64}, 'project_id = ? AND chunk_index = ?', [id,index], ['digest']);
const importFragment = (storage, id) => boundedControlRow(storage, 'mapi_chunk_import_fragment', ['table_name','row_offset','total','next_offset','cursor'], {table_name:4096,cursor:4096}, 'project_id = ?', [id]);
const importDigest = (storage, id, index) => boundedControlRow(storage, 'mapi_chunk_import_data', ['digest'], {digest:64}, 'project_id = ? AND chunk_index = ?', [id,index]);
async function hash(value) { return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))].map(b => b.toString(16).padStart(2, '0')).join(''); }
// Native JSON and base64 errors can contain source rows or cursor values.
// The private relocation control path must never forward those bytes in an
// exception, including when a persisted checkpoint has been corrupted.
function parsePrivateJSON(value, message) {
 try { return JSON.parse(value); } catch { throw Error(message); }
}
function decodePrivateBase64(value, message) {
 try { return Uint8Array.fromBase64(value); } catch { throw Error(message); }
}
function encodeFragmentRow(row, encode = true) {
 let size = 0;
 const values = row.map(value => {
  if (typeof value === 'string') {
   const data = new TextEncoder().encode(value);
   size += data.length;
   return encode ? { text: data.toBase64() } : value;
  }
  if (value && typeof value === 'object' && typeof value.blob === 'string') {
   size += decodePrivateBase64(value.blob, 'Invalid fragment blob').length;
  } else if (value !== null) {
   size += 8;
  }
  return value;
 });
 if (size > MAX_ROW_VALUE_BYTES) throw Error('Row exceeds conservative SQLite size limit');
 if (!encode) return null;
 const encoded = new TextEncoder().encode(JSON.stringify(values));
 if (encoded.length > MAX_ROW_JSON_BYTES) throw Error('Encoded row exceeds fragment limit');
 return encoded;
}
function decodeFragmentRow(encoded) {
 let text;
 try { text = new TextDecoder('utf-8', { fatal: true }).decode(encoded); }
 catch { throw Error('Invalid fragment row'); }
 const values = parsePrivateJSON(text, 'Invalid fragment row');
 if (!Array.isArray(values)) throw Error('Invalid fragment row');
 const row = values.map(value => {
  if (value && typeof value === 'object' && Object.keys(value).length === 1 && typeof value.text === 'string') {
   try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(decodePrivateBase64(value.text, 'Invalid fragment row')); }
   catch { throw Error('Invalid fragment row'); }
  }
  return value;
 });
 encodeFragmentRow(row, false);
 return row;
}
function schema(storage) {
 storage.sql.exec(`CREATE TABLE IF NOT EXISTS mapi_relocation_project (project_id TEXT PRIMARY KEY, generation INTEGER NOT NULL, state TEXT NOT NULL, move_id TEXT, digest TEXT, object_name TEXT NOT NULL)`);
 storage.sql.exec(`CREATE TABLE IF NOT EXISTS mapi_chunk_export (project_id TEXT PRIMARY KEY, generation INTEGER NOT NULL, move_id TEXT NOT NULL, tables TEXT NOT NULL, table_index INTEGER NOT NULL, row_offset INTEGER NOT NULL, next_chunk INTEGER NOT NULL, chain TEXT NOT NULL, done INTEGER NOT NULL)`);
 if (!storage.sql.exec('PRAGMA table_info(mapi_chunk_export)').toArray().some(column => column.name === 'cursor')) storage.sql.exec('ALTER TABLE mapi_chunk_export ADD COLUMN cursor TEXT');
 if (!storage.sql.exec('PRAGMA table_info(mapi_chunk_export)').toArray().some(column => column.name === 'fragment_offset')) storage.sql.exec('ALTER TABLE mapi_chunk_export ADD COLUMN fragment_offset INTEGER NOT NULL DEFAULT 0');
 addTextGuardColumn(storage, 'mapi_chunk_export');
 storage.sql.exec(`CREATE TABLE IF NOT EXISTS mapi_chunk_export_data (project_id TEXT NOT NULL, chunk_index INTEGER NOT NULL, content TEXT NOT NULL, digest TEXT, PRIMARY KEY(project_id, chunk_index))`);
 storage.sql.exec(`CREATE TABLE IF NOT EXISTS mapi_chunk_import (project_id TEXT PRIMARY KEY, generation INTEGER NOT NULL, move_id TEXT NOT NULL, object_name TEXT NOT NULL, tables TEXT NOT NULL, table_index INTEGER NOT NULL, row_offset INTEGER NOT NULL, next_chunk INTEGER NOT NULL, chain TEXT NOT NULL, done INTEGER NOT NULL)`);
 addTextGuardColumn(storage, 'mapi_chunk_import');
 storage.sql.exec(`CREATE TABLE IF NOT EXISTS mapi_chunk_import_data (project_id TEXT NOT NULL, chunk_index INTEGER NOT NULL, digest TEXT NOT NULL, PRIMARY KEY(project_id, chunk_index))`);
 storage.sql.exec(`CREATE TABLE IF NOT EXISTS mapi_chunk_import_fragment (project_id TEXT PRIMARY KEY, table_name TEXT NOT NULL, row_offset INTEGER NOT NULL, total INTEGER NOT NULL, next_offset INTEGER NOT NULL, cursor TEXT NOT NULL)`);
 storage.sql.exec(`CREATE TABLE IF NOT EXISTS mapi_chunk_import_fragment_data (project_id TEXT NOT NULL, chunk_index INTEGER NOT NULL, data BLOB NOT NULL, PRIMARY KEY (project_id, chunk_index))`);
 ensureStreamImportSchema(storage);
}
function addTextGuardColumn(storage, table) {
 if (!storage.sql.exec(`PRAGMA table_info(${table})`).toArray().some(column => column.name === 'text_guard')) {
  storage.sql.exec(`ALTER TABLE ${table} ADD COLUMN text_guard INTEGER NOT NULL DEFAULT 0`);
 }
}
function validateTables(tables) {
 if (!Array.isArray(tables) || !tables.length || tables.some(t => typeof t !== 'string' || !t)) throw Error('Invalid chunk table list');
 // SQLite folds ASCII case in identifiers, including quoted names. Validate
 // that same identity here so a case variant cannot address control tables
 // or cause the same business table to be transferred more than once.
 const names = tables.map(t => t.replace(/[A-Z]/g, character => character.toLowerCase()));
 if (new Set(names).size !== names.length || names.some(t => t === 'mapi_owner_fence' || t.startsWith('mapi_relocation_') || t.startsWith('mapi_chunk_'))) throw Error('Invalid chunk table list');
}
const controlDefinitions = {
 mapi_relocation_project: 'CREATE TABLE mapi_relocation_project (project_id TEXT PRIMARY KEY, generation INTEGER NOT NULL, state TEXT NOT NULL, move_id TEXT, digest TEXT, object_name TEXT NOT NULL)',
 mapi_chunk_export: 'CREATE TABLE mapi_chunk_export (project_id TEXT PRIMARY KEY, generation INTEGER NOT NULL, move_id TEXT NOT NULL, tables TEXT NOT NULL, table_index INTEGER NOT NULL, row_offset INTEGER NOT NULL, next_chunk INTEGER NOT NULL, chain TEXT NOT NULL, done INTEGER NOT NULL, cursor TEXT, fragment_offset INTEGER NOT NULL DEFAULT 0, text_guard INTEGER NOT NULL DEFAULT 0)',
 mapi_chunk_export_data: 'CREATE TABLE mapi_chunk_export_data (project_id TEXT NOT NULL, chunk_index INTEGER NOT NULL, content TEXT NOT NULL, digest TEXT, PRIMARY KEY(project_id, chunk_index))',
 mapi_chunk_import: 'CREATE TABLE mapi_chunk_import (project_id TEXT PRIMARY KEY, generation INTEGER NOT NULL, move_id TEXT NOT NULL, object_name TEXT NOT NULL, tables TEXT NOT NULL, table_index INTEGER NOT NULL, row_offset INTEGER NOT NULL, next_chunk INTEGER NOT NULL, chain TEXT NOT NULL, done INTEGER NOT NULL, text_guard INTEGER NOT NULL DEFAULT 0)',
 mapi_chunk_import_data: 'CREATE TABLE mapi_chunk_import_data (project_id TEXT NOT NULL, chunk_index INTEGER NOT NULL, digest TEXT NOT NULL, PRIMARY KEY(project_id, chunk_index))',
 mapi_chunk_import_fragment: 'CREATE TABLE mapi_chunk_import_fragment (project_id TEXT PRIMARY KEY, table_name TEXT NOT NULL, row_offset INTEGER NOT NULL, total INTEGER NOT NULL, next_offset INTEGER NOT NULL, cursor TEXT NOT NULL)',
 mapi_chunk_import_fragment_data: 'CREATE TABLE mapi_chunk_import_fragment_data (project_id TEXT NOT NULL, chunk_index INTEGER NOT NULL, data BLOB NOT NULL, PRIMARY KEY (project_id, chunk_index))',
 ...STREAM_IMPORT_DDL,
};
function validateControlSchema(storage) {
 for (const [table, expected] of Object.entries(controlDefinitions)) {
  const object = one(storage, "SELECT CASE WHEN typeof(sql) = 'text' AND length(CAST(sql AS BLOB)) <= 8192 THEN CAST(sql AS BLOB) END AS ddl FROM sqlite_schema WHERE type = 'table' AND name = ?", table);
  let definition;
  try { if (object?.ddl instanceof ArrayBuffer) definition = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(object.ddl); } catch { throw Error('Import control schema is incomplete or changed'); }
  if (typeof definition !== 'string' || definition.trim().replace(/\s+/g, ' ') !== expected || one(storage, "SELECT 1 FROM sqlite_schema WHERE tbl_name = ? COLLATE NOCASE AND type IN ('index', 'trigger') AND sql IS NOT NULL LIMIT 1", table)) throw Error('Import control schema is incomplete or changed');
 }
}
function validateControlOwnership(storage, id) {
 for (const table of ['mapi_chunk_export', 'mapi_chunk_export_data']) {
  if (one(storage, `SELECT 1 FROM ${quote(table)} LIMIT 1`)) throw Error('Destination export control state is not empty');
 }
 for (const table of ['mapi_relocation_project', 'mapi_chunk_import', 'mapi_chunk_import_data', 'mapi_chunk_import_fragment', 'mapi_chunk_import_fragment_data', 'mapi_chunk_import_stream', 'mapi_chunk_import_stream_data']) {
  // The two data tables have a canonical NOT NULL project key. SQLite may
  // otherwise plan an IS NULL check as a scan despite that constraint.
  const nullable = !['mapi_chunk_import_data', 'mapi_chunk_import_fragment_data', 'mapi_chunk_import_stream_data'].includes(table);
  for (const predicate of [...(nullable ? ['project_id IS NULL'] : []), 'project_id < ?', 'project_id > ?']) {
   if (one(storage, `SELECT 1 FROM ${quote(table)} WHERE ${predicate} LIMIT 1`, ...(predicate.includes('?') ? [id] : []))) throw Error('Foreign import control state');
  }
 }
}
function validateImportCheckpoint(storage, id, checkpoint, project, tables) {
 if (!Number.isSafeInteger(checkpoint.next_chunk) || checkpoint.next_chunk < 0 || !Number.isSafeInteger(checkpoint.table_index) || checkpoint.table_index < 0 || !Number.isSafeInteger(checkpoint.row_offset) || checkpoint.row_offset < 0 || typeof checkpoint.chain !== 'string') throw Error('Invalid import checkpoint');
 if (project.state === 'staged' ? checkpoint.table_index !== tables.length || checkpoint.row_offset !== 0 || checkpoint.next_chunk === 0 : checkpoint.table_index >= tables.length) throw Error('Invalid import checkpoint');
 if (one(storage, 'SELECT 1 FROM mapi_chunk_import_data WHERE project_id = ? AND chunk_index < 0 LIMIT 1', id)) throw Error('Import checkpoint history is inconsistent');
 const future = one(storage, 'SELECT 1 FROM mapi_chunk_import_data WHERE project_id = ? AND chunk_index >= ? LIMIT 1', id, checkpoint.next_chunk);
 if (future) throw Error('Import checkpoint history is inconsistent');
 if (checkpoint.next_chunk === 0) {
  if (checkpoint.chain !== '') throw Error('Import checkpoint history is inconsistent');
 } else {
  const last = importDigest(storage, id, checkpoint.next_chunk - 1);
  if (!last || !/^[0-9a-f]{64}$/.test(checkpoint.chain) || last.digest !== checkpoint.chain) throw Error('Import checkpoint history is inconsistent');
 }
 if (project.state === 'staged' && project.digest !== checkpoint.chain) throw Error('Staged import digest differs');
 const fragment = importFragment(storage, id);
 const pieces = one(storage, 'SELECT chunk_index, length(data) AS size FROM mapi_chunk_import_fragment_data WHERE project_id = ? ORDER BY chunk_index DESC LIMIT 1', id);
 validateStreamImportSchema(storage, id);
 const stream = streamImportStatus(storage, id);
 const streamData = one(storage, 'SELECT 1 FROM mapi_chunk_import_stream_data WHERE project_id = ? LIMIT 1', id);
 if (project.state === 'staged' ? stream || streamData : Boolean(stream) !== Boolean(streamData)) throw Error('Stream import checkpoint is inconsistent');
 if (stream && (fragment || pieces || stream.table_name !== tables[checkpoint.table_index] || stream.row_offset !== checkpoint.row_offset || stream.last_chunk !== checkpoint.next_chunk - 1)) throw Error('Stream import checkpoint is inconsistent');
 if (project.state === 'staged' ? fragment || pieces : Boolean(fragment) !== Boolean(pieces)) throw Error('Import fragment checkpoint is inconsistent');
 if (fragment) {
  if (fragment.table_name !== tables[checkpoint.table_index]) throw Error('Import fragment checkpoint is inconsistent');
  let cursor;
  try { cursor = JSON.parse(fragment.cursor); } catch { throw Error('Import fragment checkpoint is inconsistent'); }
  const keys = primaryKey(storage, fragment.table_name);
  if (fragment.row_offset !== checkpoint.row_offset || !Number.isSafeInteger(fragment.total) || fragment.total <= 0 || fragment.total > MAX_BYTES || !Number.isSafeInteger(fragment.next_offset) || fragment.next_offset <= 0 || fragment.next_offset >= fragment.total || !Number.isSafeInteger(pieces.chunk_index) || pieces.chunk_index !== checkpoint.next_chunk - 1 || !Number.isSafeInteger(pieces.size) || pieces.size <= 0 || pieces.size > FRAGMENT_BYTES || fragment.next_offset < pieces.size || !keys.length || !Array.isArray(cursor) || cursor.length !== keys.length || cursor.some(value => value === null)) throw Error('Import fragment checkpoint is inconsistent');
 }
}
// The owner can bind each storage transaction to its independently configured
// recovery epoch. Never accept an async authority callback: it would return
// before the guarded transaction completed.
function checkAuthority(assertAuthority) {
 if (typeof assertAuthority !== 'function') throw Error('Invalid relocation authority check');
 const result = assertAuthority();
 if (result !== null && (typeof result === 'object' || typeof result === 'function') && typeof result.then === 'function') throw Error('Relocation authority check must be synchronous');
}

function validFence(storage, id, generation, move) {
 const hasOwnerFence = one(storage, "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'mapi_owner_fence'");
 const state = hasOwnerFence ? one(storage, 'SELECT project_id, generation, state, move_id, digest, object_name FROM mapi_owner_fence WHERE singleton = 1') : projectFenceStatus(storage, id);
 if (hasOwnerFence && projectFenceStatus(storage, id)) throw Error('Conflicting owner fence records');
 if (state?.state !== 'frozen' || state.generation !== generation || state.move_id !== move) throw Error('Source is not frozen for this move');
 if (state.project_id !== id) throw Error('Source project identity mismatch');
 return { ...state, ownerFence: Boolean(hasOwnerFence) };
}
export function beginChunkExport(storage, id, generation, move, tables, assertAuthority = () => {}) {
 validateTables(tables);
 return storage.transactionSync(() => {
  checkAuthority(assertAuthority);
  schema(storage);
  validFence(storage, id, generation, move);
  const previous = exportCheckpoint(storage, id);
  if (previous) {
   assertRelocationTextGuard(previous);
   if (previous.generation !== generation || previous.move_id !== move || previous.tables !== JSON.stringify(tables)) throw Error('Conflicting export');
   return;
  }
  if (one(storage, 'SELECT 1 FROM mapi_chunk_export_data WHERE project_id = ? LIMIT 1', id)) throw Error('Legacy relocation transfer requires manual review');
  for (const table of tables) {
   if (!columns(storage, table).length) throw Error('Missing export table');
   if (!primaryKey(storage, table).length) throw Error('Export table requires a primary key');
  }
  storage.sql.exec('INSERT INTO mapi_chunk_export (project_id, generation, move_id, tables, table_index, row_offset, next_chunk, chain, done, cursor, fragment_offset, text_guard) VALUES (?, ?, ?, ?, 0, 0, 0, ?, 0, NULL, 0, ?)', id, generation, move, JSON.stringify(tables), '', RELOCATION_TEXT_GUARD_VERSION);
 });
}

// At most one durable chunk is prepared without a digest at any time. A retry
// computes the same digest over that persisted content before moving its cursor.
export async function exportChunk(storage, id, generation, move, index, failAfterReserve = false, assertAuthority = () => {}) {
 if (!Number.isSafeInteger(index) || index < 0) throw Error('Invalid chunk index');
 const content = storage.transactionSync(() => {
  checkAuthority(assertAuthority);
  validFence(storage, id, generation, move);
  const c = exportCheckpoint(storage, id);
  if (!c || c.generation !== generation || c.move_id !== move || index > c.next_chunk) throw Error('Export cursor mismatch');
  assertRelocationTextGuard(c);
  const existing = exportEntry(storage, id, index);
  if (existing) {
   // Check while it is still the immediate predecessor: the cursor can
   // advance during the asynchronous digest operation below.
   if (index === c.next_chunk - 1 && existing.digest !== c.chain) throw Error('Finalized export checkpoint differs');
   return existing.content;
  }
  if (index !== c.next_chunk || c.done) throw Error('Export is complete');
  const tables = parsePrivateJSON(c.tables, 'Invalid export table checkpoint'), table = tables[c.table_index], names = columns(storage, table);
  if (!names.length) throw Error('Export schema changed');
  const keys = primaryKey(storage, table), keyIndices = keys.map(key => names.indexOf(key));
  if (!keys.length || keyIndices.some(index => index < 0)) throw Error('Export primary key changed');
  // For ordinary SQLite columns, the declared default is BINARY and a bare
  // tuple comparison can seek on the primary-key index. Explicit COLLATE
  // expressions force SQLite to scan that index. Preserve the older binary
  // comparison for tables with an explicit collation in their DDL.
  const definition = relocationTableDefinition(storage, table);
  const explicitCollation = /\bCOLLATE\b/i.test(definition);
  if (c.row_offset && c.cursor === null) throw Error('Legacy offset checkpoint cannot resume with keyset pagination');
  let cursor = c.cursor === null ? null : parsePrivateJSON(c.cursor, 'Invalid export cursor checkpoint');
  if (cursor !== null && (!validReconciliationKeys(cursor) || cursor.length !== keys.length)) throw Error('Invalid export cursor checkpoint');
  const payload = { projectId: id, generation, moveId: move, index, prev: c.chain, table, columns: names, offset: c.row_offset, rows: [], last: false, done: false, cursor: null };
  const nextRow = () => {
   const order = keys.map(key => quote(key) + (explicitCollation ? ' COLLATE BINARY' : '')).join(', ');
   const filter = cursor ? ` WHERE (${order}) > (${keys.map(() => '?').join(', ')})` : '';
   const source = `FROM ${quote(table)}${filter} ORDER BY ${order} LIMIT 1`;
   return readRelocationRow(storage, names, source, cursor ? cursor.map(sqlArg) : []);
  };
  const inspect = () => inspectStreamRow(storage, table, names, keys, cursor, explicitCollation);
  for (; payload.rows.length < MAX_ROWS;) {
   const candidate = inspect();
   if (!candidate) { payload.last = true; break; }
   if (candidate.size > STREAM_SMALL_ROW_BYTES) {
    if (c.fragment_offset && c.fragment_offset < STREAM_OFFSET_BASE) throw Error('Legacy relocation transfer requires manual review');
    if (!payload.rows.length) {
     payload.stream = makeStreamFragment(storage, candidate, c.fragment_offset);
     payload.cursor = payload.stream.rowDone ? candidate.cursor : cursor;
    }
    break;
   }
   if (c.fragment_offset >= STREAM_OFFSET_BASE) throw Error('Streamed row changed during export');
   const row = nextRow();
   if (!row) { payload.last = true; break; }
   assertRelocationValuesRepresentable(row);
   const nextCursor = keyIndices.map(index => row[index]);
   if (nextCursor.some(value => value === null)) throw Error('Export primary key contains NULL');
   payload.rows.push(row);
   payload.cursor = nextCursor;
   // A string's UTF-16 length is a lower bound on its JSON-encoded UTF-8
   // length. Avoid serializing a whole large row just to choose fragmentation;
   // smaller or ambiguous rows retain the exact existing size calculation.
   const definitelyLarge = row.some(value => typeof value === 'string'
    ? value.length > MAX_BYTES - 1024
    : value && typeof value === 'object' && typeof value.blob === 'string' && value.blob.length > MAX_BYTES - 1024);
   if (definitelyLarge || bytes(JSON.stringify(payload)) > MAX_BYTES - 1024) {
    payload.rows.pop();
    payload.cursor = cursor;
    if (!payload.rows.length) {
     const encoded = encodeFragmentRow(row);
     if (c.fragment_offset >= encoded.length) throw Error('Invalid fragmented row offset');
     const part = encoded.subarray(c.fragment_offset, c.fragment_offset + FRAGMENT_BYTES);
     const end = c.fragment_offset + part.length;
     payload.fragment = { offset: c.fragment_offset, total: encoded.length, data: part.toBase64(), cursor: nextCursor };
     payload.cursor = end === encoded.length ? nextCursor : cursor;
    }
    break;
   }
   if (c.fragment_offset) throw Error('Fragmented row changed during export');
   cursor = nextCursor;
  }
  if (!payload.last && payload.rows.length === MAX_ROWS && !inspect()) payload.last = true;
  payload.done = payload.last && c.table_index === tables.length - 1;
  const result = JSON.stringify(payload);
  if (bytes(result) > MAX_BYTES) throw Error('Chunk limit exceeded');
  storage.sql.exec('INSERT INTO mapi_chunk_export_data VALUES (?, ?, ?, NULL)', id, index, result);
  return result;
 });
 if (failAfterReserve) throw Error('Injected export interruption');
 const digest = await hash(content);
 storage.transactionSync(() => {
  checkAuthority(assertAuthority);
  const state = validFence(storage, id, generation, move), c = exportCheckpoint(storage, id);
  const entry = exportEntry(storage, id, index);
  if (!c || c.generation !== generation || c.move_id !== move || !Number.isSafeInteger(c.next_chunk) || c.next_chunk < 0) throw Error('Export cursor changed');
  assertRelocationTextGuard(c);
  if (!entry || entry.content !== content) throw Error('Export chunk changed');
  if (index < c.next_chunk) {
   if (entry.digest !== digest) throw Error('Finalized export digest differs');
   if (index === c.next_chunk - 1 && c.chain !== digest) throw Error('Finalized export checkpoint differs');
   return;
  }
  // Finalization writes the digest and advances the cursor atomically. An
  // already-digested current chunk is inconsistent rather than a retry.
  if (index !== c.next_chunk || c.done || entry.digest !== null) throw Error('Export cursor changed');
  const p = parsePrivateJSON(content, 'Invalid relocation chunk');
  if (p.prev !== c.chain) throw Error('Export hash chain changed');
  const fragment = p.fragment;
  const stream = p.stream;
  if (fragment && stream) throw Error('Invalid relocation chunk');
  if (!p.last && !fragment && !stream && !Array.isArray(p.cursor)) throw Error('Legacy offset checkpoint cannot resume with keyset pagination');
  const fragmentEnd = fragment ? fragment.offset + decodePrivateBase64(fragment.data, 'Invalid fragment data').length : 0;
  const fragmentDone = fragment && fragmentEnd === fragment.total;
  if (p.done && state.digest && state.digest !== digest) throw Error('Conflicting final digest');
  storage.sql.exec('UPDATE mapi_chunk_export_data SET digest = ? WHERE project_id = ? AND chunk_index = ?', digest, id, index);
  const streamOffset = stream && !stream.rowDone ? encodeStreamOffset(stream.nextColumn, stream.nextOffset) : 0;
  storage.sql.exec('UPDATE mapi_chunk_export SET next_chunk = next_chunk + 1, table_index = ?, row_offset = ?, chain = ?, done = ?, cursor = ?, fragment_offset = ? WHERE project_id = ?', c.table_index + (p.last ? 1 : 0), p.last ? 0 : p.offset + p.rows.length + (fragmentDone || stream?.rowDone ? 1 : 0), digest, p.done ? 1 : 0, p.last || p.cursor === null ? null : JSON.stringify(p.cursor), stream ? streamOffset : fragment && !fragmentDone ? fragmentEnd : 0, id);
  if (p.done) {
   if (state.ownerFence) storage.sql.exec('UPDATE mapi_owner_fence SET digest = ? WHERE singleton = 1', digest);
   else storage.sql.exec('UPDATE mapi_relocation_project SET digest = ? WHERE project_id = ?', digest, id);
  }
 });
 return { content, digest };
}

export function beginChunkImport(storage, id, generation, move, destination, tables, assertAuthority = () => {}) {
 validateTables(tables); if (typeof id !== 'string' || !id || typeof move !== 'string' || !move || typeof destination !== 'string' || !destination || !Number.isSafeInteger(generation) || generation < 1 || generation === Number.MAX_SAFE_INTEGER) throw Error('Invalid import');
 return storage.transactionSync(() => {
  checkAuthority(assertAuthority);
  if (one(storage, "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'mapi_owner_fence'")) throw Error('Destination owner is already fenced');
  const hasImport = one(storage, "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'mapi_chunk_import'");
  const prior = hasImport ? importCheckpoint(storage, id) : null;
  if (prior) {
   assertRelocationTextGuard(prior);
   validateControlSchema(storage);
   validateControlOwnership(storage, id);
   if (prior.generation !== generation || prior.move_id !== move || prior.object_name !== destination || prior.tables !== JSON.stringify(tables)) throw Error('Conflicting import');
   const project = projectFenceStatus(storage, id);
   if (!project || !['importing', 'staged'].includes(project.state) || project.project_id !== id || project.generation !== generation + 1 || project.move_id !== move || project.object_name !== destination || prior.done !== (project.state === 'staged' ? 1 : 0)) throw Error('Destination import is not active');
   validateImportCheckpoint(storage, id, prior, project, tables);
   return;
  }
  schema(storage);
  validateControlSchema(storage);
  for (const table of Object.keys(controlDefinitions)) if (one(storage, `SELECT 1 FROM ${quote(table)} LIMIT 1`)) throw Error('Destination control state is not empty');
  for (const table of tables) if (!columns(storage, table).length || one(storage, `SELECT 1 FROM ${quote(table)} LIMIT 1`)) throw Error('Destination table is not empty');
  storage.sql.exec("INSERT INTO mapi_relocation_project VALUES (?, ?, 'importing', ?, NULL, ?)", id, generation + 1, move, destination);
  storage.sql.exec('INSERT INTO mapi_chunk_import VALUES (?, ?, ?, ?, ?, 0, 0, 0, ?, 0, ?)', id, generation, move, destination, JSON.stringify(tables), '', RELOCATION_TEXT_GUARD_VERSION);
 });
}

export async function importChunk(storage, id, envelope, failAfterRows = 0, assertAuthority = () => {}) {
 // Hash, parse, replay-check and commit the same immutable values. A caller
 // in this isolate can otherwise mutate its envelope while digest awaits.
 const content = envelope?.content, digest = envelope?.digest;
 if (typeof content !== 'string' || content.length > MAX_BYTES || bytes(content) > MAX_BYTES || await hash(content) !== digest) throw Error('Invalid chunk digest or size');
 const p = parsePrivateJSON(content, 'Invalid relocation chunk');
 return storage.transactionSync(() => {
  checkAuthority(assertAuthority);
  const c = importCheckpoint(storage, id);
  const project = projectFenceStatus(storage, id);
  if (!c || p.projectId !== id || p.generation !== c.generation || p.moveId !== c.move_id || !Number.isSafeInteger(p.index) || p.index < 0) throw Error('Import identity mismatch');
  assertRelocationTextGuard(c);
  if (one(storage, "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'mapi_owner_fence'") || !project || !['importing', 'staged'].includes(project.state) || project.project_id !== id || project.generation !== c.generation + 1 || project.move_id !== c.move_id || project.object_name !== c.object_name || c.done !== (project.state === 'staged' ? 1 : 0)) throw Error('Destination import is not active');
  const tables = parsePrivateJSON(c.tables, 'Invalid import table checkpoint');
  validateTables(tables);
  validateControlSchema(storage);
  validateControlOwnership(storage, id);
  validateImportCheckpoint(storage, id, c, project, tables);
  if (p.index < c.next_chunk) {
   const prior = importDigest(storage, id, p.index);
   if (!prior || prior.digest !== digest) throw Error('Conflicting chunk replay');
   return;
  }
  if (project?.state !== 'importing' || c.done || p.index !== c.next_chunk || p.prev !== c.chain) throw Error('Import cursor mismatch');
  if (p.table !== tables[c.table_index] || p.offset !== c.row_offset || !Array.isArray(p.rows) || p.rows.length > MAX_ROWS || (!p.rows.length && !p.last && !p.fragment && !p.stream) || p.fragment && p.stream || typeof p.last !== 'boolean' || typeof p.done !== 'boolean' || p.done !== (p.last && c.table_index === tables.length - 1)) throw Error('Unexpected chunk shape');
  const names = columns(storage, p.table);
  if (!equal(names, p.columns)) throw Error('Import schema differs');
  const pending = importFragment(storage, id);
  const pendingStream = streamImportStatus(storage, id);
  let completedFragment = false;
  let completedStream = false;
  storage.sql.exec('PRAGMA defer_foreign_keys = ON');
  if (p.stream) {
   if (pending || p.rows.length || p.last || p.done || p.stream.rowDone && !equal(p.cursor, p.stream.cursor)) throw Error('Invalid stream chunk');
   completedStream = importStream(storage, { projectId: id, table: p.table, names, rowOffset: p.offset, index: p.index, stream: p.stream, failAfterRows });
  } else if (pendingStream) throw Error('Streamed row is incomplete');
  if (p.fragment) {
   const fragment = p.fragment;
   // The old envelope is retained only for small rows whose escaped ordinary
   // JSON exceeds the chunk threshold. Never reassemble an unbounded journal.
   if (p.rows.length || p.last || p.done || !Number.isSafeInteger(fragment.offset) || fragment.offset < 0 || !Number.isSafeInteger(fragment.total) || fragment.total <= 0 || fragment.total > MAX_BYTES || typeof fragment.data !== 'string' || !Array.isArray(fragment.cursor) || bytes(JSON.stringify(fragment.cursor)) > 4096) throw Error('Invalid row fragment');
   const part = decodePrivateBase64(fragment.data, 'Invalid fragment data');
   if (!part.length || part.length > FRAGMENT_BYTES || fragment.offset + part.length > fragment.total || fragment.offset + part.length < fragment.total && part.length !== FRAGMENT_BYTES) throw Error('Invalid fragment size');
   if (pending) {
    if (pending.table_name !== p.table || pending.row_offset !== p.offset || pending.total !== fragment.total || pending.next_offset !== fragment.offset || pending.cursor !== JSON.stringify(fragment.cursor)) throw Error('Fragment cursor mismatch');
   } else {
    if (fragment.offset !== 0) throw Error('Fragment must begin at zero');
    storage.sql.exec('INSERT INTO mapi_chunk_import_fragment VALUES (?, ?, ?, ?, 0, ?)', id, p.table, p.offset, fragment.total, JSON.stringify(fragment.cursor));
   }
   storage.sql.exec('INSERT INTO mapi_chunk_import_fragment_data VALUES (?, ?, ?)', id, p.index, part.buffer);
   const end = fragment.offset + part.length;
   storage.sql.exec('UPDATE mapi_chunk_import_fragment SET next_offset = ? WHERE project_id = ?', end, id);
   if (end === fragment.total) {
    // The legacy envelope is capped to 128 KiB and has at most two fixed-size
    // pieces. Verify bounded metadata first, in this transaction, before any
    // stored BLOB crosses the bridge; corrupted journals cannot force a scan
    // or materialize arbitrary piece data.
    const metadata = storage.sql.exec("SELECT chunk_index, typeof(data) AS kind, length(data) AS size FROM mapi_chunk_import_fragment_data WHERE project_id = ? ORDER BY chunk_index LIMIT 3", id).toArray();
    const expected = Math.ceil(fragment.total / FRAGMENT_BYTES);
    if (metadata.length !== expected || metadata.some((piece, n) => piece.kind !== 'blob' || piece.chunk_index !== p.index - expected + 1 + n || piece.size !== Math.min(FRAGMENT_BYTES, fragment.total - n * FRAGMENT_BYTES))) throw Error('Invalid legacy fragment pieces');
    const pieces = storage.sql.exec('SELECT data FROM mapi_chunk_import_fragment_data WHERE project_id = ? ORDER BY chunk_index LIMIT 2', id).raw().toArray();
    const encoded = new Uint8Array(fragment.total);
    let position = 0;
    for (const [data] of pieces) {
     const piece = new Uint8Array(data);
     if (position + piece.length > encoded.length) throw Error('Fragment overflow');
     encoded.set(piece, position);
     position += piece.length;
    }
    if (position !== encoded.length) throw Error('Fragment length mismatch');
    const row = decodeFragmentRow(encoded);
    const keys = primaryKey(storage, p.table);
    if (!Array.isArray(row) || row.length !== names.length || !equal(keys.map(key => row[names.indexOf(key)]), fragment.cursor) || !equal(p.cursor, fragment.cursor)) throw Error('Fragment row or cursor mismatch');
    p.rows = [row];
    completedFragment = true;
   }
  } else if (pending) throw Error('Fragmented row is incomplete');
  let inserted = 0;
  for (const row of p.rows) {
   if (!Array.isArray(row) || row.length !== names.length) throw Error('Invalid chunk row');
   assertRelocationValuesRepresentable(row);
   const args = row.map(value => value && typeof value === 'object' && 'integer' in value ? { kind: 'int', value: value.integer } : value && typeof value === 'object' && 'blob' in value ? { kind: 'blob', value: value.blob } : { kind: 'value', value });
   execute(storage, { statement: `INSERT INTO ${quote(p.table)} (${names.map(quote).join(', ')}) VALUES (${names.map(() => '?').join(', ')})`, args, query: false });
   if (failAfterRows && ++inserted === failAfterRows) throw Error('Injected chunk failure');
  }
  // Check before transactionSync returns: a deferred constraint failure at
  // commit can reset the object instead of surfacing as an ordinary rollback.
  assertNoForeignKeyViolations(storage, 'Import violates foreign keys');
  if (completedFragment) {
   storage.sql.exec('DELETE FROM mapi_chunk_import_fragment_data WHERE project_id = ?', id);
   storage.sql.exec('DELETE FROM mapi_chunk_import_fragment WHERE project_id = ?', id);
  }
  storage.sql.exec('INSERT INTO mapi_chunk_import_data VALUES (?, ?, ?)', id, p.index, digest);
  storage.sql.exec('UPDATE mapi_chunk_import SET next_chunk = next_chunk + 1, table_index = ?, row_offset = ?, chain = ?, done = ? WHERE project_id = ?', c.table_index + (p.last ? 1 : 0), p.last ? 0 : p.offset + p.rows.length + (completedStream ? 1 : 0), digest, p.done ? 1 : 0, id);
  if (p.done) storage.sql.exec("UPDATE mapi_relocation_project SET state = 'staged', digest = ? WHERE project_id = ?", digest, id);
 });
}
export function chunkExportStatus(storage, id) { return exportCheckpoint(storage, id); }
export function chunkImportStatus(storage, id) { return importCheckpoint(storage, id); }
