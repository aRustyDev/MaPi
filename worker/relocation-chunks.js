// Experimental chunked companion to relocation.js. This is not wired to the app.
import { execute } from './sql.js';
import { projectFenceStatus } from './relocation.js';
const MAX_BYTES = 128 * 1024;
const MAX_ROWS = 64;
const bytes = text => new TextEncoder().encode(text).length;
const quote = value => '"' + value.replaceAll('"', '""') + '"';
const columns = (storage, table) => storage.sql.exec(`PRAGMA table_xinfo(${quote(table)})`).toArray().filter(c => c.hidden === 0).map(c => c.name);
const one = (storage, sql, ...args) => storage.sql.exec(sql, ...args).toArray()[0];
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
async function hash(value) { return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))].map(b => b.toString(16).padStart(2, '0')).join(''); }
function schema(storage) {
 storage.sql.exec(`CREATE TABLE IF NOT EXISTS mapi_relocation_project (project_id TEXT PRIMARY KEY, generation INTEGER NOT NULL, state TEXT NOT NULL, move_id TEXT, digest TEXT, object_name TEXT NOT NULL)`);
 storage.sql.exec(`CREATE TABLE IF NOT EXISTS mapi_chunk_export (project_id TEXT PRIMARY KEY, generation INTEGER NOT NULL, move_id TEXT NOT NULL, tables TEXT NOT NULL, table_index INTEGER NOT NULL, row_offset INTEGER NOT NULL, next_chunk INTEGER NOT NULL, chain TEXT NOT NULL, done INTEGER NOT NULL)`);
 storage.sql.exec(`CREATE TABLE IF NOT EXISTS mapi_chunk_export_data (project_id TEXT NOT NULL, chunk_index INTEGER NOT NULL, content TEXT NOT NULL, digest TEXT, PRIMARY KEY(project_id, chunk_index))`);
 storage.sql.exec(`CREATE TABLE IF NOT EXISTS mapi_chunk_import (project_id TEXT PRIMARY KEY, generation INTEGER NOT NULL, move_id TEXT NOT NULL, object_name TEXT NOT NULL, tables TEXT NOT NULL, table_index INTEGER NOT NULL, row_offset INTEGER NOT NULL, next_chunk INTEGER NOT NULL, chain TEXT NOT NULL, done INTEGER NOT NULL)`);
 storage.sql.exec(`CREATE TABLE IF NOT EXISTS mapi_chunk_import_data (project_id TEXT NOT NULL, chunk_index INTEGER NOT NULL, digest TEXT NOT NULL, PRIMARY KEY(project_id, chunk_index))`);
}
function validateTables(tables) {
 if (!Array.isArray(tables) || !tables.length || new Set(tables).size !== tables.length || tables.some(t => typeof t !== 'string' || !t || t.startsWith('mapi_relocation_') || t.startsWith('mapi_chunk_'))) throw Error('Invalid chunk table list');
}
function validFence(storage, id, generation, move) {
 const state = projectFenceStatus(storage, id);
 if (state?.state !== 'frozen' || state.generation !== generation || state.move_id !== move) throw Error('Source is not frozen for this move');
 return state;
}
export function beginChunkExport(storage, id, generation, move, tables) {
 validateTables(tables); schema(storage);
 return storage.transactionSync(() => {
  validFence(storage, id, generation, move);
  const previous = one(storage, 'SELECT * FROM mapi_chunk_export WHERE project_id = ?', id);
  if (previous) { if (previous.generation !== generation || previous.move_id !== move || previous.tables !== JSON.stringify(tables)) throw Error('Conflicting export'); return; }
  for (const table of tables) if (!columns(storage, table).length) throw Error('Missing export table');
  storage.sql.exec('INSERT INTO mapi_chunk_export VALUES (?, ?, ?, ?, 0, 0, 0, ?, 0)', id, generation, move, JSON.stringify(tables), '');
 });
}

// At most one durable chunk is prepared without a digest at any time. A retry
// computes the same digest over that persisted content before moving its cursor.
export async function exportChunk(storage, id, generation, move, index, failAfterReserve = false) {
 if (!Number.isSafeInteger(index) || index < 0) throw Error('Invalid chunk index');
 const content = storage.transactionSync(() => {
  validFence(storage, id, generation, move);
  const c = one(storage, 'SELECT * FROM mapi_chunk_export WHERE project_id = ?', id);
  if (!c || c.generation !== generation || c.move_id !== move || index > c.next_chunk) throw Error('Export cursor mismatch');
  const existing = one(storage, 'SELECT content FROM mapi_chunk_export_data WHERE project_id = ? AND chunk_index = ?', id, index);
  if (existing) return existing.content;
  if (index !== c.next_chunk || c.done) throw Error('Export is complete');
  const tables = JSON.parse(c.tables), table = tables[c.table_index], names = columns(storage, table);
  if (!names.length) throw Error('Export schema changed');
  const count = storage.sql.exec(`SELECT COUNT(*) AS n FROM ${quote(table)}`).one().n;
  const payload = { projectId: id, generation, moveId: move, index, prev: c.chain, table, columns: names, offset: c.row_offset, rows: [], last: false, done: false };
  for (let offset = c.row_offset; offset < count && payload.rows.length < MAX_ROWS; offset++) {
   const statement = `SELECT ${names.map(quote).join(', ')} FROM ${quote(table)} ORDER BY ${names.map(name => `${quote(name)} COLLATE BINARY`).join(', ')} LIMIT 1 OFFSET ?`;
   const row = execute(storage, { statement, args: [{ kind: 'value', value: offset }], query: true }).rows[0];
   payload.rows.push(row);
   if (bytes(JSON.stringify(payload)) > MAX_BYTES - 1024) { payload.rows.pop(); if (!payload.rows.length) throw Error('Row exceeds chunk limit'); break; }
  }
  payload.last = c.row_offset + payload.rows.length === count;
  payload.done = payload.last && c.table_index === tables.length - 1;
  const result = JSON.stringify(payload);
  if (bytes(result) > MAX_BYTES) throw Error('Chunk limit exceeded');
  storage.sql.exec('INSERT INTO mapi_chunk_export_data VALUES (?, ?, ?, NULL)', id, index, result);
  return result;
 });
 if (failAfterReserve) throw Error('Injected export interruption');
 const digest = await hash(content);
 storage.transactionSync(() => {
  const state = validFence(storage, id, generation, move), c = one(storage, 'SELECT * FROM mapi_chunk_export WHERE project_id = ?', id);
  const entry = one(storage, 'SELECT content, digest FROM mapi_chunk_export_data WHERE project_id = ? AND chunk_index = ?', id, index);
  if (!entry || entry.content !== content || (entry.digest && entry.digest !== digest)) throw Error('Export chunk changed');
  if (index < c.next_chunk) return;
  if (index !== c.next_chunk) throw Error('Export cursor changed');
  const p = JSON.parse(content);
  if (p.prev !== c.chain) throw Error('Export hash chain changed');
  if (p.done && state.digest && state.digest !== digest) throw Error('Conflicting final digest');
  storage.sql.exec('UPDATE mapi_chunk_export_data SET digest = ? WHERE project_id = ? AND chunk_index = ?', digest, id, index);
  storage.sql.exec('UPDATE mapi_chunk_export SET next_chunk = next_chunk + 1, table_index = ?, row_offset = ?, chain = ?, done = ? WHERE project_id = ?', c.table_index + (p.last ? 1 : 0), p.last ? 0 : p.offset + p.rows.length, digest, p.done ? 1 : 0, id);
  if (p.done) storage.sql.exec('UPDATE mapi_relocation_project SET digest = ? WHERE project_id = ?', digest, id);
 });
 return { content, digest };
}

export function beginChunkImport(storage, id, generation, move, destination, tables) {
 validateTables(tables); if (!id || !move || !destination || !Number.isSafeInteger(generation) || generation < 1) throw Error('Invalid import'); schema(storage);
 return storage.transactionSync(() => {
  const prior = one(storage, 'SELECT * FROM mapi_chunk_import WHERE project_id = ?', id);
  if (prior) { if (prior.generation !== generation || prior.move_id !== move || prior.object_name !== destination || prior.tables !== JSON.stringify(tables)) throw Error('Conflicting import'); return; }
  if (storage.sql.exec('SELECT COUNT(*) AS n FROM mapi_relocation_project').one().n) throw Error('Destination is not empty');
  for (const table of tables) if (!columns(storage, table).length || storage.sql.exec(`SELECT COUNT(*) AS n FROM ${quote(table)}`).one().n) throw Error('Destination table is not empty');
  storage.sql.exec("INSERT INTO mapi_relocation_project VALUES (?, ?, 'importing', ?, NULL, ?)", id, generation + 1, move, destination);
  storage.sql.exec('INSERT INTO mapi_chunk_import VALUES (?, ?, ?, ?, ?, 0, 0, 0, ?, 0)', id, generation, move, destination, JSON.stringify(tables), '');
 });
}

export async function importChunk(storage, id, envelope, failAfterRows = 0) {
 if (typeof envelope?.content !== 'string' || bytes(envelope.content) > MAX_BYTES || await hash(envelope.content) !== envelope.digest) throw Error('Invalid chunk digest or size');
 const p = JSON.parse(envelope.content);
 return storage.transactionSync(() => {
  const c = one(storage, 'SELECT * FROM mapi_chunk_import WHERE project_id = ?', id);
  const project = projectFenceStatus(storage, id);
  if (!c || p.projectId !== id || p.generation !== c.generation || p.moveId !== c.move_id || !Number.isSafeInteger(p.index)) throw Error('Import identity mismatch');
  if (p.index < c.next_chunk) {
   const prior = one(storage, 'SELECT digest FROM mapi_chunk_import_data WHERE project_id = ? AND chunk_index = ?', id, p.index);
   if (!prior || prior.digest !== envelope.digest) throw Error('Conflicting chunk replay');
   return;
  }
  if (project?.state !== 'importing' || c.done || p.index !== c.next_chunk || p.prev !== c.chain) throw Error('Import cursor mismatch');
  const tables = JSON.parse(c.tables);
  if (p.table !== tables[c.table_index] || p.offset !== c.row_offset || !Array.isArray(p.rows) || p.rows.length > MAX_ROWS || (!p.rows.length && !p.last) || typeof p.last !== 'boolean' || typeof p.done !== 'boolean' || p.done !== (p.last && c.table_index === tables.length - 1)) throw Error('Unexpected chunk shape');
  const names = columns(storage, p.table);
  if (!equal(names, p.columns)) throw Error('Import schema differs');
  storage.sql.exec('PRAGMA defer_foreign_keys = ON');
  let inserted = 0;
  for (const row of p.rows) {
   if (!Array.isArray(row) || row.length !== names.length) throw Error('Invalid chunk row');
   const args = row.map(value => value && typeof value === 'object' && 'integer' in value ? { kind: 'int', value: value.integer } : value && typeof value === 'object' && 'blob' in value ? { kind: 'blob', value: value.blob } : { kind: 'value', value });
   execute(storage, { statement: `INSERT INTO ${quote(p.table)} (${names.map(quote).join(', ')}) VALUES (${names.map(() => '?').join(', ')})`, args, query: false });
   if (failAfterRows && ++inserted === failAfterRows) throw Error('Injected chunk failure');
  }
  // Check before transactionSync returns: a deferred constraint failure at
  // commit can reset the object instead of surfacing as an ordinary rollback.
  if (storage.sql.exec('PRAGMA foreign_key_check').toArray().length) throw Error('Import violates foreign keys');
  storage.sql.exec('INSERT INTO mapi_chunk_import_data VALUES (?, ?, ?)', id, p.index, envelope.digest);
  storage.sql.exec('UPDATE mapi_chunk_import SET next_chunk = next_chunk + 1, table_index = ?, row_offset = ?, chain = ?, done = ? WHERE project_id = ?', c.table_index + (p.last ? 1 : 0), p.last ? 0 : p.offset + p.rows.length, envelope.digest, p.done ? 1 : 0, id);
  if (p.done) storage.sql.exec("UPDATE mapi_relocation_project SET state = 'staged', digest = ? WHERE project_id = ?", envelope.digest, id);
 });
}
export function chunkExportStatus(storage, id) { return one(storage, 'SELECT * FROM mapi_chunk_export WHERE project_id = ?', id) ?? null; }
export function chunkImportStatus(storage, id) { return one(storage, 'SELECT * FROM mapi_chunk_import WHERE project_id = ?', id) ?? null; }
