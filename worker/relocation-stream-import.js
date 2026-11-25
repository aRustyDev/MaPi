// Durable v2 row-fragment staging. Call from the same synchronous transaction
// as the owner fence, chunk-chain validation and import checkpoint update.
import { createHash } from 'node:crypto';
import { MAX_ROW_VALUE_BYTES } from './relocation-chunks.js';

export const STREAM_SLICE_BYTES = 64 * 1024;
export const STREAM_IMPORT_DDL = Object.freeze({
 mapi_chunk_import_stream: 'CREATE TABLE mapi_chunk_import_stream (project_id TEXT PRIMARY KEY, table_name TEXT NOT NULL, row_offset INTEGER NOT NULL, columns TEXT NOT NULL, types TEXT NOT NULL, cursor TEXT NOT NULL, column_index INTEGER NOT NULL, next_offset INTEGER NOT NULL, last_chunk INTEGER NOT NULL, utf8_remaining INTEGER NOT NULL, utf8_min INTEGER NOT NULL, utf8_max INTEGER NOT NULL)',
 mapi_chunk_import_stream_data: 'CREATE TABLE mapi_chunk_import_stream_data (project_id TEXT NOT NULL, column_index INTEGER NOT NULL, piece_offset INTEGER NOT NULL, data BLOB NOT NULL, digest TEXT NOT NULL, PRIMARY KEY (project_id, column_index, piece_offset))',
});
const quote = name => '"' + name.replaceAll('"', '""') + '"';
const first = (storage, sql, ...args) => storage.sql.exec(sql, ...args).toArray()[0];
const bytes = value => new TextEncoder().encode(value).length;
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const digest = data => createHash('sha256').update(new Uint8Array(data)).digest('hex');
const own = (obj, fields) => !!obj && typeof obj === 'object' && !Array.isArray(obj) && Object.keys(obj).sort().join(',') === fields.slice().sort().join(',');
const parse = value => { try { return JSON.parse(value); } catch { throw Error('Invalid stream import checkpoint'); } };

export function ensureStreamImportSchema(storage) {
 for (const ddl of Object.values(STREAM_IMPORT_DDL)) storage.sql.exec(ddl.replace('CREATE TABLE ', 'CREATE TABLE IF NOT EXISTS '));
}

export function validateStreamImportSchema(storage, projectId) {
 for (const [name, expected] of Object.entries(STREAM_IMPORT_DDL)) {
  // sqlite_schema may itself be corrupted; compare inside SQLite so an
  // attacker-controlled SQL definition never crosses into JavaScript.
  const objects = storage.sql.exec("SELECT CASE WHEN name = ? COLLATE BINARY AND type = 'table' AND sql = ? COLLATE BINARY THEN 1 ELSE 0 END AS matches FROM sqlite_schema WHERE name = ? COLLATE NOCASE LIMIT 2", name, expected, name).toArray();
  if (objects.length !== 1 || objects[0].matches !== 1 || first(storage, "SELECT 1 FROM sqlite_schema WHERE tbl_name = ? COLLATE NOCASE AND type IN ('trigger', 'index') AND sql IS NOT NULL LIMIT 1", name)) throw Error('Stream import control schema changed');
  for (const predicate of ['project_id IS NULL', 'project_id < ?', 'project_id > ?']) {
   if (first(storage, `SELECT 1 FROM ${name} WHERE ${predicate} LIMIT 1`, ...(predicate.includes('?') ? [projectId] : []))) throw Error('Foreign stream import control state');
  }
 }
}

export function streamImportStatus(storage, projectId) {
 // Validate byte lengths in SQLite before reading any persisted TEXT into JS.
 // A corrupted checkpoint may otherwise materialize an arbitrarily large value.
 const safe = first(storage, `SELECT CASE WHEN typeof(table_name) = 'text' AND length(CAST(table_name AS BLOB)) <= 32768 AND typeof(columns) = 'text' AND length(CAST(columns AS BLOB)) <= 32768 AND typeof(types) = 'text' AND length(CAST(types AS BLOB)) <= 32768 AND typeof(cursor) = 'text' AND length(CAST(cursor AS BLOB)) <= 4096 THEN 1 ELSE 0 END AS ok FROM mapi_chunk_import_stream WHERE project_id = ? LIMIT 1`, projectId);
 if (!safe) return null;
 if (safe.ok !== 1) throw Error('Invalid stream import checkpoint');
 const rows = storage.sql.exec('SELECT CAST(table_name AS BLOB), row_offset, CAST(columns AS BLOB), CAST(types AS BLOB), CAST(cursor AS BLOB), column_index, next_offset, last_chunk, utf8_remaining, utf8_min, utf8_max FROM mapi_chunk_import_stream WHERE project_id = ? LIMIT 1', projectId).raw().toArray();
 if (rows.length !== 1) throw Error('Invalid stream import checkpoint');
 const [tableBytes,rowOffset,columnBytes,typeBytes,cursorBytes,columnIndex,nextOffset,lastChunk,remaining,minimum,maximum] = rows[0];
 let tableName, columns, types, cursor;
 try {
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  tableName = decoder.decode(tableBytes); columns = decoder.decode(columnBytes); types = decoder.decode(typeBytes); cursor = decoder.decode(cursorBytes);
 } catch { throw Error('Invalid stream import checkpoint'); }
 if (!Number.isSafeInteger(rowOffset) || rowOffset < 0 || !Number.isSafeInteger(columnIndex) || columnIndex < 0 || columnIndex >= 100 || !Number.isSafeInteger(nextOffset) || nextOffset < 0 || nextOffset > MAX_ROW_VALUE_BYTES || !Number.isSafeInteger(lastChunk) || lastChunk < 0 || ![remaining,minimum,maximum].every(Number.isInteger) || !['0:128:191','1:128:191','2:128:191','2:160:191','2:128:159','3:128:191','3:144:191','3:128:143'].includes(`${remaining}:${minimum}:${maximum}`)) throw Error('Invalid stream import checkpoint');
 const names = parse(columns), descriptors = parse(types), parsedCursor = parse(cursor);
 if (!Array.isArray(names) || !names.length || names.length > 100 || names.some(name => typeof name !== 'string' || !name) || JSON.stringify(names) !== columns || !Array.isArray(parsedCursor) || JSON.stringify(parsedCursor) !== cursor) throw Error('Invalid stream import checkpoint');
 validTypes(descriptors, names);
 const current = descriptors[columnIndex];
 if (JSON.stringify(descriptors) !== types || !current || !['text','blob'].includes(current.kind) || nextOffset % STREAM_SLICE_BYTES !== 0 || nextOffset > 0 && nextOffset >= current.length || remaining && (current.kind !== 'text' || nextOffset === 0)) throw Error('Invalid stream import checkpoint');
 return { table_name: tableName, row_offset: rowOffset, columns, types, cursor, column_index: columnIndex, next_offset: nextOffset, last_chunk: lastChunk, utf8_remaining: remaining, utf8_min: minimum, utf8_max: maximum };
}

function validTypes(types, names) {
 if (!Array.isArray(types) || types.length !== names.length || !types.length || types.length > 100) throw Error('Invalid stream row descriptors');
 let total = 0;
 for (const item of types) {
  if (item?.kind === 'text' || item?.kind === 'blob') {
   if (!own(item, ['kind', 'length']) || !Number.isSafeInteger(item.length) || item.length < 0 || item.length > MAX_ROW_VALUE_BYTES) throw Error('Invalid stream row descriptors');
   total += item.length;
  } else if (item?.kind === 'null') {
   if (!own(item, ['kind'])) throw Error('Invalid stream row descriptors');
  } else if (item?.kind === 'integer') {
   if (!own(item, ['kind', 'value']) || typeof item.value !== 'string' || !/^(0|-?[1-9][0-9]*)$/.test(item.value) || item.value.length > 20) throw Error('Invalid stream integer');
   const value = BigInt(item.value);
   if (value.toString() !== item.value || value < -9223372036854775808n || value > 9223372036854775807n) throw Error('Invalid stream integer');
   total += 8;
  } else if (item?.kind === 'real') {
   if (!own(item, ['kind', 'value']) || typeof item.value !== 'number' || !Number.isFinite(item.value)) throw Error('Invalid stream real');
   total += 8;
  } else throw Error('Invalid stream row descriptors');
  if (total > MAX_ROW_VALUE_BYTES) throw Error('Row exceeds conservative SQLite size limit');
 }
 if (bytes(JSON.stringify(types)) > 32768) throw Error('Stream row descriptors exceed limit');
 return types;
}

// Strict UTF-8 state is checkpointed, including an incomplete code point at an
// eviction boundary. No untrusted TEXT bytes pass through a Workerd string.
function consumeUtf8(state, data, done) {
 for (const byte of data) {
  if (state.remaining) {
   if (byte < state.minimum || byte > state.maximum) throw Error('Invalid UTF-8 TEXT in stream row');
   state.remaining--; state.minimum = 128; state.maximum = 191;
  } else if (byte <= 127) {
  } else if (byte >= 194 && byte <= 223) state.remaining = 1;
  else if (byte >= 224 && byte <= 239) { state.remaining = 2; if (byte === 224) state.minimum = 160; if (byte === 237) state.maximum = 159; }
  else if (byte >= 240 && byte <= 244) { state.remaining = 3; if (byte === 240) state.minimum = 144; if (byte === 244) state.maximum = 143; }
  else throw Error('Invalid UTF-8 TEXT in stream row');
 }
 if (done && state.remaining) throw Error('Invalid UTF-8 TEXT in stream row');
}

function nextCell(types, from) {
 for (let i = from; i < types.length; i++) if (types[i].kind === 'text' || types[i].kind === 'blob') return i;
 return null;
}

function validateCursor(storage, projectId, table, names, types, cursor) {
 const keys = []; let previous = 0, nameBytes = 0;
 for (;;) {
  // Read one bounded primary-key name at a time, excluding defaults and DDL.
  const entry = first(storage, 'SELECT pk, length(CAST(name AS BLOB)) AS size FROM pragma_table_xinfo(?) WHERE pk > ? ORDER BY pk LIMIT 1', table, previous);
  if (!entry) break;
  if (!Number.isSafeInteger(entry.pk) || entry.pk <= previous || !Number.isSafeInteger(entry.size) || entry.size < 1 || (nameBytes += entry.size) > 32768 || keys.length >= 100) throw Error('Invalid stream primary key schema');
  const row = storage.sql.exec('SELECT CAST(name AS BLOB) FROM pragma_table_xinfo(?) WHERE pk = ? AND length(CAST(name AS BLOB)) = ? LIMIT 1', table, entry.pk, entry.size).raw().toArray()[0];
  if (!row || !(row[0] instanceof ArrayBuffer) || row[0].byteLength !== entry.size) throw Error('Invalid stream primary key schema');
  let name;
  try { name = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(row[0]); } catch { throw Error('Invalid stream primary key schema'); }
  keys.push({ name, pk: entry.pk }); previous = entry.pk;
 }
 if (!keys.length || !Array.isArray(cursor) || cursor.length !== keys.length || cursor.some(value => value === null) || bytes(JSON.stringify(cursor)) > 4096) throw Error('Invalid stream primary key cursor');
 let keyBytes = 0;
 const actual = keys.map(key => {
  const column = names.indexOf(key.name), type = types[column];
  if (column < 0 || !type || type.kind === 'null') throw Error('Invalid stream primary key cursor');
  if (type.kind === 'integer') return { integer: type.value };
  if (type.kind === 'real') return type.value;
  keyBytes += type.length;
  if (keyBytes > 4096) throw Error('Stream primary key exceeds limit');
  const pieces = storage.sql.exec('SELECT data FROM mapi_chunk_import_stream_data WHERE project_id = ? AND column_index = ? ORDER BY piece_offset', projectId, column).raw().toArray();
  const data = new Uint8Array(type.length); let offset = 0;
  for (const [piece] of pieces) { const chunk = new Uint8Array(piece); if (offset + chunk.length > data.length) throw Error('Invalid stream primary key'); data.set(chunk, offset); offset += chunk.length; }
  if (offset !== data.length) throw Error('Invalid stream primary key');
  if (type.kind === 'blob') return { blob: data.toBase64() };
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(data); } catch { throw Error('Invalid stream primary key'); }
 });
 if (!equal(actual, cursor)) throw Error('Stream primary key cursor differs');
}

function validateStagedCells(storage, projectId, types) {
 for (const predicate of ['column_index < 0', 'column_index >= ?']) {
  if (first(storage, `SELECT 1 FROM mapi_chunk_import_stream_data WHERE project_id = ? AND ${predicate} LIMIT 1`, projectId, ...(predicate.includes('?') ? [types.length] : []))) throw Error('Invalid staged stream cells');
 }
 for (let column = 0; column < types.length; column++) {
  const type = types[column], data = type.kind === 'text' || type.kind === 'blob';
  const expected = data ? Math.max(1, Math.ceil(type.length / STREAM_SLICE_BYTES)) : 0;
  // The bounded LIMIT and primary-key order prevent malformed durable state
  // from forcing a scan over an unbounded number of pieces or returning data.
  const pieces = storage.sql.exec('SELECT piece_offset, typeof(data) AS kind, length(data) AS size FROM mapi_chunk_import_stream_data WHERE project_id = ? AND column_index = ? ORDER BY piece_offset LIMIT ?', projectId, column, expected + 1).toArray();
  if (pieces.length !== expected) throw Error('Incomplete staged stream cell');
  for (let i = 0; i < pieces.length; i++) {
   const offset = i * STREAM_SLICE_BYTES, size = Math.min(STREAM_SLICE_BYTES, type.length - offset);
   if (pieces[i].piece_offset !== offset || pieces[i].kind !== 'blob' || pieces[i].size !== size) throw Error('Invalid staged stream slice');
   const piece = storage.sql.exec(`SELECT CASE WHEN typeof(data) = 'blob' AND length(data) = ? THEN data END, CASE WHEN typeof(digest) = 'text' AND length(CAST(digest AS BLOB)) = 64 THEN CAST(digest AS BLOB) END FROM mapi_chunk_import_stream_data WHERE project_id = ? AND column_index = ? AND piece_offset = ?`, size, projectId, column, offset).raw().toArray()[0];
   if (!piece || !(piece[0] instanceof ArrayBuffer) || !(piece[1] instanceof ArrayBuffer)) throw Error('Invalid staged stream slice');
   const expectedDigest = new TextDecoder('utf-8', { fatal: true }).decode(piece[1]);
   if (!/^[0-9a-f]{64}$/.test(expectedDigest) || digest(piece[0]) !== expectedDigest) throw Error('Invalid staged stream slice digest');
  }
 }
}

function insertRow(storage, projectId, table, names, types) {
 const args = [];
 const expressions = types.map((type, index) => {
  if (type.kind === 'null') return 'NULL';
  if (type.kind === 'integer') { args.push(type.value); return 'CAST(? AS INTEGER)'; }
  if (type.kind === 'real') { args.push(type.value); return 'CAST(? AS REAL)'; }
  args.push(projectId);
  // BLOB slices never cross into JS while assembling the inserted value.
  const ordered = `SELECT data FROM mapi_chunk_import_stream_data WHERE project_id = ? AND column_index = ${index} ORDER BY piece_offset`;
  return `(SELECT CAST(group_concat(CAST(data AS TEXT), '') AS ${type.kind === 'blob' ? 'BLOB' : 'TEXT'}) FROM (${ordered}))`;
 });
 storage.sql.exec(`INSERT INTO ${quote(table)} (${names.map(quote).join(', ')}) SELECT ${expressions.join(', ')}`, ...args);
}

// This function requires a synchronous transaction held by the caller.
export function importStream(storage, { projectId, table, names, rowOffset, index, stream, failAfterRows = 0 }) {
 if (typeof projectId !== 'string' || !projectId || typeof table !== 'string' || !table || !Array.isArray(names) || !names.length || names.length > 100 || names.some(name => typeof name !== 'string' || !name) || bytes(JSON.stringify(names)) > 32768 || !Number.isSafeInteger(rowOffset) || rowOffset < 0 || !Number.isSafeInteger(index) || index < 0) throw Error('Invalid stream import identity');
 if (!stream || stream.v !== 2 || !Number.isSafeInteger(stream.column) || stream.column < 0 || stream.column >= names.length || !Number.isSafeInteger(stream.offset) || stream.offset < 0 || !Number.isSafeInteger(stream.total) || stream.total < 0 || !['text', 'blob'].includes(stream.kind) || typeof stream.data !== 'string' || typeof stream.rowDone !== 'boolean' || !(stream.nextColumn === null || Number.isSafeInteger(stream.nextColumn)) || !(stream.nextOffset === null || Number.isSafeInteger(stream.nextOffset)) || !Array.isArray(stream.cursor) || bytes(JSON.stringify(stream.cursor)) > 4096) throw Error('Invalid stream packet');
 const fields = ['v', 'column', 'offset', 'total', 'kind', 'data', 'cursor', 'rowDone', 'nextColumn', 'nextOffset'];
 if (Object.hasOwn(stream, 'types')) fields.push('types');
 if (!own(stream, fields)) throw Error('Invalid stream packet');
 let part;
 try { part = Uint8Array.fromBase64(stream.data); } catch { throw Error('Invalid stream data'); }
 if (part.length > STREAM_SLICE_BYTES || part.toBase64() !== stream.data || stream.offset + part.length > stream.total || (stream.total > stream.offset && !part.length) || (stream.offset + part.length < stream.total && part.length !== STREAM_SLICE_BYTES) || (stream.total === 0 && (stream.offset !== 0 || part.length !== 0))) throw Error('Invalid stream slice');
 let state = streamImportStatus(storage, projectId), types, utf8;
 if (!state) {
  if (!Object.hasOwn(stream, 'types') || stream.offset !== 0 || first(storage, 'SELECT 1 FROM mapi_chunk_import_stream_data WHERE project_id = ? LIMIT 1', projectId)) throw Error('Invalid new stream import');
  types = validTypes(stream.types, names);
  if (stream.column !== nextCell(types, 0)) throw Error('Unexpected stream column');
  utf8 = { remaining: 0, minimum: 128, maximum: 191 };
  storage.sql.exec('INSERT INTO mapi_chunk_import_stream VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, 0, 128, 191)', projectId, table, rowOffset, JSON.stringify(names), JSON.stringify(types), JSON.stringify(stream.cursor), stream.column, index - 1);
 } else {
  if (Object.hasOwn(stream, 'types') || state.table_name !== table || state.row_offset !== rowOffset || state.columns !== JSON.stringify(names) || state.cursor !== JSON.stringify(stream.cursor) || state.last_chunk !== index - 1 || state.column_index !== stream.column || state.next_offset !== stream.offset) throw Error('Stream import checkpoint differs');
  types = validTypes(parse(state.types), names);
  if (![state.utf8_remaining, state.utf8_min, state.utf8_max].every(Number.isInteger) || !['0:128:191','1:128:191','2:128:191','2:160:191','2:128:159','3:128:191','3:144:191','3:128:143'].includes(`${state.utf8_remaining}:${state.utf8_min}:${state.utf8_max}`)) throw Error('Invalid stream UTF-8 checkpoint');
  utf8 = { remaining: state.utf8_remaining, minimum: state.utf8_min, maximum: state.utf8_max };
 }
 const type = types[stream.column];
 if (!type || type.kind !== stream.kind || type.length !== stream.total) throw Error('Stream descriptor differs');
 const end = stream.offset + part.length, cellDone = end === stream.total;
 if (stream.kind === 'text') consumeUtf8(utf8, part, cellDone);
 else if (utf8.remaining || utf8.minimum !== 128 || utf8.maximum !== 191) throw Error('Invalid stream UTF-8 checkpoint');
 const nextColumn = cellDone ? nextCell(types, stream.column + 1) : stream.column;
 const nextOffset = nextColumn === null ? null : cellDone ? 0 : end;
 const rowDone = nextColumn === null;
 if (stream.rowDone !== rowDone || stream.nextColumn !== nextColumn || stream.nextOffset !== nextOffset) throw Error('Invalid stream continuation');
 storage.sql.exec('INSERT INTO mapi_chunk_import_stream_data VALUES (?, ?, ?, ?, ?)', projectId, stream.column, stream.offset, part.buffer, digest(part.buffer));
 if (!rowDone) {
  storage.sql.exec('UPDATE mapi_chunk_import_stream SET column_index = ?, next_offset = ?, last_chunk = ?, utf8_remaining = ?, utf8_min = ?, utf8_max = ? WHERE project_id = ?', nextColumn, nextOffset, index, utf8.remaining, utf8.minimum, utf8.maximum, projectId);
  return false;
 }
 validateStagedCells(storage, projectId, types);
 validateCursor(storage, projectId, table, names, types, stream.cursor);
 insertRow(storage, projectId, table, names, types);
 if (failAfterRows) throw Error('Injected chunk failure');
 storage.sql.exec('DELETE FROM mapi_chunk_import_stream_data WHERE project_id = ?', projectId);
 storage.sql.exec('DELETE FROM mapi_chunk_import_stream WHERE project_id = ?', projectId);
 return true;
}
