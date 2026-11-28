import { DurableObject } from 'cloudflare:workers';
import { initializeProjectFence, assertProjectWritable, freezeProject, activateProject, retireProject, initializeRouteGeneration, registerRouteGeneration, readRouteGeneration, beginRelocation, commitRelocation, projectFenceStatus } from '../worker/relocation.js';
import { beginChunkExport, exportChunk, beginChunkImport, importChunk, chunkExportStatus, chunkImportStatus, MAX_ROW_VALUE_BYTES } from '../worker/relocation-chunks.js';
import { execute } from '../worker/sql.js';
import { initializeOwnerFence } from '../worker/owner-fence.js';
const tables = ['users', 'sessions', 'events'];
const check = (v, text) => { if (!v) throw Error(text); };
const rejects = async (fn, text) => { try { await fn(); } catch { return; } throw Error(text); };
const rejectsWith = async (fn, message) => { try { await fn(); } catch (error) { if (String(error).includes(message)) return; throw error; } throw Error(`Expected ${message}`); };
const hash = async text => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))].map(b => b.toString(16).padStart(2, '0')).join('');
export class ChunkProject extends DurableObject {
 constructor(ctx, env) { super(ctx, env); this.s = ctx.storage; this.s.sql.exec('CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, precise INTEGER, data BLOB)'); this.s.sql.exec('CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, user_id TEXT REFERENCES users(id))'); this.s.sql.exec('CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, user_id TEXT REFERENCES users(id), kind TEXT)'); this.s.sql.exec('CREATE TABLE IF NOT EXISTS compound (a INTEGER NOT NULL, b TEXT NOT NULL, PRIMARY KEY (a, b))'); this.s.sql.exec('CREATE TABLE IF NOT EXISTS wide_text (id TEXT PRIMARY KEY, value TEXT)'); this.s.sql.exec('CREATE TABLE IF NOT EXISTS case_keys (id TEXT COLLATE NOCASE PRIMARY KEY, value TEXT)'); this.s.sql.exec('CREATE TABLE IF NOT EXISTS real_values (id TEXT PRIMARY KEY, value REAL)'); }
 init(id, name) { initializeProjectFence(this.s, id, name); }
 seed(id) { this.s.transactionSync(() => { assertProjectWritable(this.s, id, 1); for (let i = 0; i < 12; i++) { const key = `u${String(i).padStart(2, '0')}`; const data = new Uint8Array(50_000); data.fill(i); this.s.sql.exec(`INSERT INTO users VALUES (?, ${i % 2 ? '-9223372036854775808' : '9223372036854775807'}, ?)`, key, data.buffer); this.s.sql.exec('INSERT INTO sessions VALUES (?, ?)', `s${i}`, key); this.s.sql.exec('INSERT INTO events VALUES (?, ?, ?)', `e${i}`, key, 'created'); } }); }
 seedCompound(id) { this.s.transactionSync(() => { assertProjectWritable(this.s, id, 1); for (let i = 0; i < 70; i++) this.s.sql.exec("INSERT INTO compound VALUES (9223372036854775807, ?)", `key-${String(i).padStart(4, '0')}`); }); }
 compoundCount() { return this.s.sql.exec('SELECT COUNT(*) AS n FROM compound').one().n; }
 compoundPlan() { return this.s.sql.exec("EXPLAIN QUERY PLAN SELECT a, b FROM compound WHERE (a, b) > (CAST(? AS INTEGER), ?) ORDER BY a, b LIMIT 1", "9223372036854775807", "key-0001").toArray().map(row => row.detail); }
 seedCaseKeys(id) { this.s.transactionSync(() => { assertProjectWritable(this.s, id, 1); for (let i = 0; i < 70; i++) this.s.sql.exec('INSERT INTO case_keys VALUES (?, ?)', `${i % 2 ? 'k' : 'K'}-${String(i).padStart(4, '0')}`, `value-${i}`); }); }
 caseKeys() { return this.s.sql.exec('SELECT id, value FROM case_keys ORDER BY id COLLATE BINARY').toArray(); }
 casePlan() { return this.s.sql.exec("EXPLAIN QUERY PLAN SELECT id FROM case_keys WHERE (id COLLATE BINARY) > (?) ORDER BY id COLLATE BINARY LIMIT 1", "K-0001").toArray().map(row => row.detail); }
 seedMany(id) { this.s.transactionSync(() => { assertProjectWritable(this.s, id, 1); for (let i = 0; i < 130; i++) this.s.sql.exec('INSERT INTO users VALUES (?, ?, ?)', `key-${String(i).padStart(4, '0')}`, i, new Uint8Array([i % 256]).buffer); }); }
 oversized(id) { this.s.transactionSync(() => { assertProjectWritable(this.s, id, 1); const data = new Uint8Array(300_000); for (let i = 0; i < data.length; i++) data[i] = i % 251; this.s.sql.exec("INSERT INTO users VALUES ('large', 9223372036854775807, ?)", data.buffer); }); }
 beyondRowLimit(id) { this.s.transactionSync(() => { assertProjectWritable(this.s, id, 1); this.s.sql.exec("INSERT INTO users VALUES ('large', 0, ?)", new Uint8Array(8_385_000).buffer); }); }
 seedWideText(id) { this.s.transactionSync(() => { assertProjectWritable(this.s, id, 1); this.s.sql.exec("INSERT INTO wide_text VALUES ('wide', ?)", '\uFEFF' + 'é😀\n'.repeat(45_000)); }); }
 seedWireRows(id, value, includeSmall) { this.s.transactionSync(() => { assertProjectWritable(this.s, id, 1); if (includeSmall) this.s.sql.exec("INSERT INTO wide_text VALUES ('a', 'small')"); this.s.sql.exec("INSERT INTO wide_text VALUES ('wide', ?)", value); }); }
 seedRelocationText(id, invalid) {
  this.s.transactionSync(() => {
   assertProjectWritable(this.s, id, 1);
   this.s.sql.exec("INSERT INTO wide_text VALUES ('a', ?)", 'é😀\uFFFD');
   if (invalid) this.s.sql.exec("INSERT INTO wide_text VALUES ('z', CAST(X'80' AS TEXT))");
  });
 }
 relocationTextRows() {
  return this.s.sql.exec('SELECT id, typeof(value) AS kind, hex(value) AS bytes FROM wide_text ORDER BY id').toArray();
 }
 seedReal(id, value) { this.s.transactionSync(() => { assertProjectWritable(this.s, id, 1); if (value === 'positive') this.s.sql.exec("INSERT INTO real_values VALUES ('value', 1e999)"); else if (value === 'negative') this.s.sql.exec("INSERT INTO real_values VALUES ('value', -1e999)"); else if (value === 'null') this.s.sql.exec("INSERT INTO real_values VALUES ('value', NULL)"); else throw Error('Unknown REAL fixture'); }); }
 realState() { const row = this.s.sql.exec('SELECT typeof(value) AS kind, value FROM real_values').one(); return { kind: row.kind, positive: row.value === Infinity, negative: row.value === -Infinity }; }
 realRows() { return this.s.sql.exec('SELECT id, typeof(value) AS kind, value FROM real_values ORDER BY id').toArray(); }
 importControlCounts() { return ['mapi_chunk_import_data', 'mapi_chunk_import_fragment', 'mapi_chunk_import_fragment_data'].map(table => this.s.sql.exec(`SELECT COUNT(*) AS n FROM ${table}`).one().n); }
 readWideText() { return this.s.sql.exec("SELECT value FROM wide_text WHERE id = 'wide'").one().value; }
 write(id, gen) { this.s.transactionSync(() => { assertProjectWritable(this.s, id, gen); this.s.sql.exec("INSERT INTO users VALUES ('later', 0, X'01')"); }); }
 freeze(id, gen, move) { freezeProject(this.s, id, gen, move); }
 beginExport(id, gen, move, order = tables) { beginChunkExport(this.s, id, gen, move, order); }
 chunk(id, gen, move, n, fail) { return exportChunk(this.s, id, gen, move, n, fail); }
 beginImport(id, gen, move, dest, order = tables) { beginChunkImport(this.s, id, gen, move, dest, order); }
 receive(id, env, fail) { return importChunk(this.s, id, env, fail); }
 // Synthetic external recovery authority, deliberately changed while the
 // chunk digest is pending. The actual owner uses its configured epoch.
 setAuthorityEpoch(value) { this.s.sql.exec('CREATE TABLE IF NOT EXISTS mapi_test_authority (epoch TEXT NOT NULL)'); this.s.sql.exec('DELETE FROM mapi_test_authority'); this.s.sql.exec('INSERT INTO mapi_test_authority VALUES (?)', value); }
 assertAuthorityEpoch() { if (this.s.sql.exec('SELECT epoch FROM mapi_test_authority').one().epoch !== 'current') throw Error('Stale synthetic recovery epoch'); }
 beginGuardedExport(id, gen, move) { return beginChunkExport(this.s, id, gen, move, ['users'], () => this.assertAuthorityEpoch()); }
 beginGuardedImport(id, gen, move, dest) { return beginChunkImport(this.s, id, gen, move, dest, ['users'], () => this.assertAuthorityEpoch()); }
 beginAsyncGuardedExport(id, gen, move) { return beginChunkExport(this.s, id, gen, move, ['users'], () => Promise.resolve()); }
 guardedExport(id, gen, move, invalidate = false) {
  let scheduled = false;
  return exportChunk(this.s, id, gen, move, 0, false, () => {
   this.assertAuthorityEpoch();
   if (invalidate && !scheduled) { scheduled = true; queueMicrotask(() => this.setAuthorityEpoch('stale')); }
  });
 }
 guardedImport(id, chunk, invalidate = false) {
  if (invalidate) queueMicrotask(() => this.setAuthorityEpoch('stale'));
  return importChunk(this.s, id, chunk, 0, () => this.assertAuthorityEpoch());
 }
 guardedState(id, role) {
  const table = role === 'source' ? 'mapi_chunk_export_data' : 'mapi_chunk_import_data';
  const checkpoint = role === 'source' ? chunkExportStatus(this.s, id) : chunkImportStatus(this.s, id);
  const row = this.s.sql.exec(`SELECT COUNT(*) AS n FROM ${table} WHERE project_id = ?`, id).one();
  return { checkpoint, journalRows: row.n, users: this.s.sql.exec('SELECT COUNT(*) AS n FROM users').one().n };
 }
 clearTextGuardForTest(role) {
  const table = role === 'source' ? 'mapi_chunk_export' : 'mapi_chunk_import';
  this.s.sql.exec(`ALTER TABLE ${table} DROP COLUMN text_guard`);
 }
 setExportCursorForTest(id, value) { this.s.sql.exec('UPDATE mapi_chunk_export SET cursor = ? WHERE project_id = ?', value, id); }
 setTextGuardForTest(role, id, value) { const table = role === 'source' ? 'mapi_chunk_export' : 'mapi_chunk_import'; this.s.sql.exec(`UPDATE ${table} SET text_guard = ? WHERE project_id = ?`, value, id); }
 exportStatus(id) { return chunkExportStatus(this.s, id); }
 importStatus(id) { return chunkImportStatus(this.s, id); }
 controlSchema() { return this.s.sql.exec("SELECT name, sql FROM sqlite_schema WHERE name LIKE 'mapi_%' ORDER BY name").toArray(); }
 seedLegacyExportMetadata() { this.s.sql.exec('CREATE TABLE mapi_chunk_export (project_id TEXT PRIMARY KEY, generation INTEGER NOT NULL, move_id TEXT NOT NULL, tables TEXT NOT NULL, table_index INTEGER NOT NULL, row_offset INTEGER NOT NULL, next_chunk INTEGER NOT NULL, chain TEXT NOT NULL, done INTEGER NOT NULL)'); }
 seedMalformedImportMetadata() { this.s.sql.exec('CREATE TABLE mapi_chunk_import (project_id TEXT, generation INTEGER NOT NULL, move_id TEXT NOT NULL, object_name TEXT NOT NULL, tables TEXT NOT NULL, table_index INTEGER NOT NULL, row_offset INTEGER NOT NULL, next_chunk INTEGER NOT NULL, chain TEXT NOT NULL, done INTEGER NOT NULL)'); }
 seedActiveOwnerFence(id, name) { initializeOwnerFence(this.s, { projectId: id, origin: 'https://active.example', objectName: name, generation: 1 }); }
 dropImportFragmentTable() { this.s.sql.exec('DROP TABLE mapi_chunk_import_fragment_data'); }
 restoreImportFragmentTable() { this.s.sql.exec('CREATE TABLE mapi_chunk_import_fragment_data (project_id TEXT NOT NULL, chunk_index INTEGER NOT NULL, data BLOB NOT NULL, PRIMARY KEY (project_id, chunk_index))'); }
 seedMalformedFragmentTable() { this.s.sql.exec('CREATE TABLE mapi_chunk_import_fragment_data (project_id TEXT NOT NULL, chunk_index INTEGER NOT NULL, data BLOB NOT NULL)'); }
 seedExtraControlObject(kind) {
  if (kind === 'index') this.s.sql.exec('CREATE INDEX mapi_test_control_index ON mapi_chunk_import_data(chunk_index)');
  else if (kind === 'trigger') this.s.sql.exec('CREATE TRIGGER mapi_test_control_trigger BEFORE INSERT ON mapi_chunk_import_data BEGIN SELECT 1; END');
  else throw Error('Invalid local control object');
 }
 removeExtraControlObject(kind) {
  if (kind === 'index') this.s.sql.exec('DROP INDEX mapi_test_control_index');
  else if (kind === 'trigger') this.s.sql.exec('DROP TRIGGER mapi_test_control_trigger');
  else throw Error('Invalid local control object');
 }
 seedForeignControl(table, id) {
  const statements = {
   mapi_relocation_project: "INSERT INTO mapi_relocation_project VALUES (?, 2, 'importing', 'foreign-move', NULL, 'foreign-object')",
   mapi_chunk_export: "INSERT INTO mapi_chunk_export (project_id,generation,move_id,tables,table_index,row_offset,next_chunk,chain,done) VALUES (?, 1, 'foreign-move', '[]', 0, 0, 0, '', 0)",
   mapi_chunk_export_data: "INSERT INTO mapi_chunk_export_data VALUES (?, 999999, 'foreign', NULL)",
   mapi_chunk_import: "INSERT INTO mapi_chunk_import VALUES (?, 1, 'foreign-move', 'foreign-object', '[]', 0, 0, 0, '', 0, 1)",
   mapi_chunk_import_data: "INSERT INTO mapi_chunk_import_data VALUES (?, 999999, 'foreign')",
   mapi_chunk_import_fragment: "INSERT INTO mapi_chunk_import_fragment VALUES (?, 'users', 0, 1, 0, '[]')",
   mapi_chunk_import_fragment_data: "INSERT INTO mapi_chunk_import_fragment_data VALUES (?, 999999, X'01')",
  };
  if (!Object.hasOwn(statements, table)) throw Error('Invalid local control table');
  this.s.sql.exec(statements[table], id);
 }
 removeForeignControl(table, id) {
  if (!['mapi_relocation_project', 'mapi_chunk_export', 'mapi_chunk_export_data', 'mapi_chunk_import', 'mapi_chunk_import_data', 'mapi_chunk_import_fragment', 'mapi_chunk_import_fragment_data'].includes(table)) throw Error('Invalid local control table');
  this.s.sql.exec(`DELETE FROM ${table} WHERE project_id IS ?`, id);
 }
 controlOwnershipPlans() {
  const tables = ['mapi_relocation_project', 'mapi_chunk_import', 'mapi_chunk_import_data', 'mapi_chunk_import_fragment', 'mapi_chunk_import_fragment_data'];
  return tables.flatMap(table => [...(!['mapi_chunk_import_data', 'mapi_chunk_import_fragment_data'].includes(table) ? ['project_id IS NULL'] : []), 'project_id < ?', 'project_id > ?'].map(predicate => ({ table, predicate, details: this.s.sql.exec(`EXPLAIN QUERY PLAN SELECT 1 FROM ${table} WHERE ${predicate} LIMIT 1`, ...(predicate.includes('?') ? ['p'] : [])).toArray().map(row => row.detail) })));
 }
 checkpointPlans() {
  const queries = [
   ['SELECT 1 FROM mapi_chunk_import_data WHERE project_id = ? AND chunk_index < 0 LIMIT 1', ['p']],
   ['SELECT 1 FROM mapi_chunk_import_data WHERE project_id = ? AND chunk_index >= ? LIMIT 1', ['p', 1]],
   ['SELECT digest FROM mapi_chunk_import_data WHERE project_id = ? AND chunk_index = ?', ['p', 1]],
   ['SELECT 1 FROM mapi_chunk_import_fragment WHERE project_id = ? LIMIT 1', ['p']],
   ['SELECT 1 FROM mapi_chunk_import_fragment_data WHERE project_id = ? LIMIT 1', ['p']],
   ['SELECT chunk_index, length(data) AS size FROM mapi_chunk_import_fragment_data WHERE project_id = ? ORDER BY chunk_index DESC LIMIT 1', ['p']],
  ];
  return queries.map(([sql, args]) => this.s.sql.exec(`EXPLAIN QUERY PLAN ${sql}`, ...args).toArray().map(row => row.detail));
 }
 removeLastHistory(id) {
  const row = this.s.sql.exec('SELECT chunk_index, digest FROM mapi_chunk_import_data WHERE project_id = ? ORDER BY chunk_index DESC LIMIT 1', id).one();
  this.s.sql.exec('DELETE FROM mapi_chunk_import_data WHERE project_id = ? AND chunk_index = ?', id, row.chunk_index);
  return row;
 }
 restoreHistory(id, row) { this.s.sql.exec('INSERT INTO mapi_chunk_import_data VALUES (?, ?, ?)', id, row.chunk_index, row.digest); }
 setImportDone(id, value) { this.s.sql.exec('UPDATE mapi_chunk_import SET done = ? WHERE project_id = ?', value, id); }
 setImportChain(id, value) { this.s.sql.exec('UPDATE mapi_chunk_import SET chain = ? WHERE project_id = ?', value, id); }
 removeExtraImportHistory(id) { this.s.sql.exec('DELETE FROM mapi_chunk_import_data WHERE project_id = ? AND chunk_index = 999999', id); }
 setHistoryForTest(id, index, digest) { this.s.sql.exec('INSERT INTO mapi_chunk_import_data VALUES (?, ?, ?)', id, index, digest); }
 removeHistoryForTest(id, index) { this.s.sql.exec('DELETE FROM mapi_chunk_import_data WHERE project_id = ? AND chunk_index = ?', id, index); }
 setImportDigestForTest(id, index, value) { if (value === 'invalid-utf8') this.s.sql.exec("UPDATE mapi_chunk_import_data SET digest = CAST(X'80' AS TEXT) WHERE project_id = ? AND chunk_index = ?", id, index); else this.s.sql.exec('UPDATE mapi_chunk_import_data SET digest = ? WHERE project_id = ? AND chunk_index = ?', value, id, index); }
 streamPieceForTest(id, column, offset) {
  return this.s.sql.exec('SELECT data FROM mapi_chunk_import_stream_data WHERE project_id = ? AND column_index = ? AND piece_offset = ?', id, column, offset).one().data;
 }
 setStreamPieceForTest(id, column, offset, data) {
  this.s.sql.exec('UPDATE mapi_chunk_import_stream_data SET data = ? WHERE project_id = ? AND column_index = ? AND piece_offset = ?', data, id, column, offset);
 }
 streamPieceCountForTest(id) {
  return this.s.sql.exec('SELECT COUNT(*) AS n FROM mapi_chunk_import_stream_data WHERE project_id = ?', id).one().n;
 }
 streamForTest(id) { return this.s.sql.exec('SELECT * FROM mapi_chunk_import_stream WHERE project_id = ?', id).one(); }
 setStreamForTest(id, field, value) { if (!['table_name', 'row_offset', 'last_chunk'].includes(field)) throw Error('Invalid local stream field'); this.s.sql.exec(`UPDATE mapi_chunk_import_stream SET ${field} = ? WHERE project_id = ?`, value, id); }
 fragmentForTest(id) { return this.s.sql.exec('SELECT * FROM mapi_chunk_import_fragment WHERE project_id = ?', id).one(); }
 setFragmentForTest(id, field, value) {
  if (!['table_name', 'row_offset', 'total', 'next_offset', 'cursor'].includes(field)) throw Error('Invalid local fragment field');
  this.s.sql.exec(`UPDATE mapi_chunk_import_fragment SET ${field} = ? WHERE project_id = ?`, value, id);
 }
 moveFragmentPieceForTest(id, from, to) { this.s.sql.exec('UPDATE mapi_chunk_import_fragment_data SET chunk_index = ? WHERE project_id = ? AND chunk_index = ?', to, id, from); }
 setFragmentPieceForTest(id, index, value) { this.s.sql.exec('UPDATE mapi_chunk_import_fragment_data SET data = ? WHERE project_id = ? AND chunk_index = ?', value, id, index); }
 addLegacyGarbage(id) { for (let i = -50; i < 0; i++) this.s.sql.exec('INSERT INTO mapi_chunk_import_fragment_data VALUES (?, ?, zeroblob(1))', id, i); }
 removeLegacyGarbage(id) { this.s.sql.exec('DELETE FROM mapi_chunk_import_fragment_data WHERE project_id = ? AND chunk_index < 0', id); }
 legacyPieceSummary(id) { return this.s.sql.exec('SELECT COUNT(*) AS n, SUM(length(data)) AS bytes FROM mapi_chunk_import_fragment_data WHERE project_id = ?', id).one(); }
 removeRelocationRow(id) { this.s.sql.exec('DELETE FROM mapi_relocation_project WHERE project_id = ?', id); }
 setRelocationField(id, field, value) {
  if (!['project_id', 'generation', 'move_id', 'object_name', 'state', 'digest'].includes(field)) throw Error('Invalid local test field');
  this.s.sql.exec(`UPDATE mapi_relocation_project SET ${field} = ? WHERE project_id = ?`, value, id);
 }
 convertToOwnerFence(id, name) {
  this.s.sql.exec('DELETE FROM mapi_relocation_project WHERE project_id = ?', id);
  initializeOwnerFence(this.s, { projectId: id, origin: 'https://active.example', objectName: name, generation: 2 });
 }
 ownerFence() { return this.s.sql.exec('SELECT * FROM mapi_owner_fence WHERE singleton = 1').one(); }
 status(id) { return projectFenceStatus(this.s, id); }
 activate(id, gen, move, route) { activateProject(this.s, id, gen, move, route); }
 retire(id, gen, move, route) { retireProject(this.s, id, gen, move, route); }
 evidence() { return { users: execute(this.s, { statement: 'SELECT id, precise, data FROM users ORDER BY id', args: [], query: true }).rows, sessions: this.s.sql.exec('SELECT COUNT(*) AS n FROM sessions').one().n, events: this.s.sql.exec('SELECT COUNT(*) AS n FROM events').one().n, fks: this.s.sql.exec('PRAGMA foreign_key_check').toArray() }; }
 evict() { this.ctx.abort('eviction test'); }
}
export class ChunkRegistry extends DurableObject {
 constructor(ctx, env) { super(ctx, env); this.s = ctx.storage; this.s.sql.exec('CREATE TABLE IF NOT EXISTS project_routes (project_id TEXT PRIMARY KEY, origin TEXT NOT NULL, object_name TEXT NOT NULL UNIQUE, state TEXT NOT NULL)'); initializeRouteGeneration(this.s); }
 register(id, name) { const origin = `https://${id}.test`; this.s.sql.exec("INSERT INTO project_routes VALUES (?, ?, ?, 'active')", id, origin, name); registerRouteGeneration(this.s, id, origin, name); }
 begin(id, source, target, generation, move) { return beginRelocation(this.s, id, source, target, generation, move); }
 commit(id, gen, move, frozen, staged) { return commitRelocation(this.s, id, gen, move, frozen, staged); }
 route(id) { return readRouteGeneration(this.s, id); }
}
export default { async fetch(request, env) {
 try {
  const n = crypto.randomUUID(), a = `source-${n}`, b = `destination-${n}`, r = `registry-${n}`; let source = env.PROJECT.getByName(a), target = env.PROJECT.getByName(b); const registry = env.REGISTRY.getByName(r);
  // A recovery epoch may change while asynchronous digesting yields. Verify
  // reservations, finalization and replay all check it inside transactions.
  let epochSource = env.PROJECT.getByName(`epoch-source-${n}`), epochTarget = env.PROJECT.getByName(`epoch-target-${n}`);
  await epochSource.init('epoch', `epoch-source-${n}`); await epochSource.seedMany('epoch'); await epochSource.freeze('epoch', 1, 'epoch-move');
  await epochSource.setAuthorityEpoch('stale');
  const sourceSchema = await epochSource.controlSchema();
  await rejectsWith(() => epochSource.beginGuardedExport('epoch', 1, 'epoch-move'), 'Stale synthetic recovery epoch');
  check(JSON.stringify(await epochSource.controlSchema()) === JSON.stringify(sourceSchema), 'Rejected source initialization changed state');
  await rejectsWith(() => epochSource.beginAsyncGuardedExport('epoch', 1, 'epoch-move'), 'Relocation authority check must be synchronous');
  check(JSON.stringify(await epochSource.controlSchema()) === JSON.stringify(sourceSchema), 'Async authority check changed source control state');
  await epochSource.setAuthorityEpoch('current'); await epochSource.beginGuardedExport('epoch', 1, 'epoch-move');
  await rejectsWith(() => epochSource.guardedExport('epoch', 1, 'epoch-move', true), 'Stale synthetic recovery epoch');
  const reserved = await epochSource.guardedState('epoch', 'source');
  check(reserved.checkpoint.next_chunk === 0 && reserved.journalRows === 1, 'Rejected export finalized its reservation');
  try { await epochSource.evict(); } catch {} epochSource = env.PROJECT.getByName(`epoch-source-${n}`);
  await rejectsWith(() => epochSource.guardedExport('epoch', 1, 'epoch-move'), 'Stale synthetic recovery epoch');
  check(JSON.stringify(await epochSource.guardedState('epoch', 'source')) === JSON.stringify(reserved), 'Stale source replay changed state');
  await epochSource.setAuthorityEpoch('current'); const epochChunk = await epochSource.guardedExport('epoch', 1, 'epoch-move');
  check(JSON.stringify(await epochSource.guardedExport('epoch', 1, 'epoch-move')) === JSON.stringify(epochChunk), 'Source reservation did not resume identically');
  await epochTarget.setAuthorityEpoch('stale'); const targetSchema = await epochTarget.controlSchema();
  await rejectsWith(() => epochTarget.beginGuardedImport('epoch', 1, 'epoch-move', `epoch-target-${n}`), 'Stale synthetic recovery epoch');
  check(JSON.stringify(await epochTarget.controlSchema()) === JSON.stringify(targetSchema), 'Rejected destination initialization changed state');
  await epochTarget.setAuthorityEpoch('current'); await epochTarget.beginGuardedImport('epoch', 1, 'epoch-move', `epoch-target-${n}`);
  const emptyImport = await epochTarget.guardedState('epoch', 'destination');
  await rejectsWith(() => epochTarget.guardedImport('epoch', epochChunk, true), 'Stale synthetic recovery epoch');
  check(JSON.stringify(await epochTarget.guardedState('epoch', 'destination')) === JSON.stringify(emptyImport), 'Stale import changed checkpoint or rows');
  try { await epochTarget.evict(); } catch {} epochTarget = env.PROJECT.getByName(`epoch-target-${n}`);
  await rejectsWith(() => epochTarget.guardedImport('epoch', epochChunk), 'Stale synthetic recovery epoch');
  await epochTarget.setAuthorityEpoch('current'); await epochTarget.guardedImport('epoch', epochChunk);
  const imported = await epochTarget.guardedState('epoch', 'destination');
  check(imported.checkpoint.next_chunk === 1 && imported.journalRows === 1 && imported.users > 0, 'Valid import did not resume');
  await epochTarget.setAuthorityEpoch('stale');
  await rejectsWith(() => epochTarget.guardedImport('epoch', epochChunk), 'Stale synthetic recovery epoch');
  check(JSON.stringify(await epochTarget.guardedState('epoch', 'destination')) === JSON.stringify(imported), 'Stale import replay changed state');
  await epochTarget.setAuthorityEpoch('current'); await epochTarget.guardedImport('epoch', epochChunk);
  check(JSON.stringify(await epochTarget.guardedState('epoch', 'destination')) === JSON.stringify(imported), 'Valid import replay changed state');
  const stale = env.PROJECT.getByName(`stale-${n}`); await stale.init('stale', `stale-${n}`);
  const beforeStale = await stale.controlSchema(), beforeState = await stale.status('stale'), beforeRows = await stale.evidence();
  await rejects(() => stale.beginExport('stale', 1, 'not-frozen'), 'unfrozen export initialization succeeded');
  check(JSON.stringify(await stale.controlSchema()) === JSON.stringify(beforeStale), 'rejected export initialization changed control schema');
  check(JSON.stringify(await stale.status('stale')) === JSON.stringify(beforeState) && JSON.stringify(await stale.evidence()) === JSON.stringify(beforeRows), 'rejected export initialization changed project state');
  await rejects(() => stale.beginImport('stale', 1, 'not-reserved', `stale-${n}`), 'nonempty import initialization succeeded');
  check(JSON.stringify(await stale.controlSchema()) === JSON.stringify(beforeStale), 'rejected import initialization changed control schema');
  check(JSON.stringify(await stale.status('stale')) === JSON.stringify(beforeState) && JSON.stringify(await stale.evidence()) === JSON.stringify(beforeRows), 'rejected import initialization changed project state');
  const legacy = env.PROJECT.getByName(`legacy-${n}`); await legacy.init('legacy', `legacy-${n}`); await legacy.seedLegacyExportMetadata();
  const beforeLegacy = await legacy.controlSchema();
  await rejects(() => legacy.beginExport('legacy', 1, 'not-frozen'), 'unfrozen legacy export initialization succeeded');
  check(JSON.stringify(await legacy.controlSchema()) === JSON.stringify(beforeLegacy), 'rejected legacy export altered its control schema');
  const active = env.PROJECT.getByName(`active-owner-${n}`); await active.seedActiveOwnerFence('active-owner', `active-owner-${n}`);
  const beforeActive = await active.controlSchema();
  await rejects(() => active.beginImport('active-owner', 1, 'unreserved', `active-owner-${n}`, ['users']), 'active empty owner accepted import initialization');
  check(JSON.stringify(await active.controlSchema()) === JSON.stringify(beforeActive), 'rejected active owner initialization changed control schema');
  const malformed = env.PROJECT.getByName(`malformed-${n}`); await malformed.seedMalformedImportMetadata();
  const malformedBefore = await malformed.controlSchema();
  await rejects(() => malformed.beginImport('malformed', 1, 'move', `malformed-${n}`, ['users']), 'fresh malformed control schema accepted');
  check(JSON.stringify(await malformed.controlSchema()) === JSON.stringify(malformedBefore), 'rejected malformed schema was changed');
  const orphan = env.PROJECT.getByName(`orphan-${n}`); await orphan.beginImport('old-project', 1, 'old-move', `orphan-${n}`, ['users']); await orphan.removeRelocationRow('old-project');
  const orphanSchema = await orphan.controlSchema(), orphanCheckpoint = await orphan.importStatus('old-project');
  await rejects(() => orphan.beginImport('new-project', 1, 'new-move', `orphan-${n}`, ['users']), 'orphan checkpoint accepted by new import');
  check(JSON.stringify(await orphan.controlSchema()) === JSON.stringify(orphanSchema) && JSON.stringify(await orphan.importStatus('old-project')) === JSON.stringify(orphanCheckpoint), 'rejected orphan import changed state');
  await source.init('p', a); await source.seed('p'); await registry.register('p', a); await registry.begin('p', a, b, 1, 'move'); await source.freeze('p', 1, 'move');
  await rejects(() => source.write('p', 1), 'frozen source writable'); await source.beginExport('p', 1, 'move'); await target.beginImport('p', 1, 'move', b); await target.beginImport('p', 1, 'move', b);
  await target.setImportDone('p', 1); await rejects(() => target.beginImport('p', 1, 'move', b), 'importing checkpoint with done flag accepted'); await target.setImportDone('p', 0);
  for (const table of ['mapi_chunk_import_fragment', 'mapi_chunk_import_fragment_data']) {
   await target.seedForeignControl(table, 'p');
   await rejects(() => target.beginImport('p', 1, 'move', b), `importing checkpoint accepted unmatched ${table}`);
   await target.removeForeignControl(table, 'p');
  }
  await rejects(() => source.chunk('p', 1, 'move', 2, false), 'out-of-order export accepted');
  await rejects(() => source.chunk('p', 1, 'move', 0, true), 'export interruption did not occur'); check((await source.exportStatus('p')).next_chunk === 0, 'export cursor advanced before hash');
  await rejects(() => source.evict(), 'source eviction must abort'); source = env.PROJECT.getByName(a);
  let total = 0, nChunks = 0, first;
  for (;;) {
   const part = await source.chunk('p', 1, 'move', nChunks, false); total += new TextEncoder().encode(part.content).length; const payload = JSON.parse(part.content);
   if (nChunks === 0) {
    first = part; await rejects(() => target.receive('p', { ...part, content: part.content + ' ' }, 0), 'tampered chunk accepted');
    const future = await source.chunk('p', 1, 'move', 1, false); await rejects(() => target.receive('p', future, 0), 'out-of-order import accepted');
    await rejects(() => target.receive('p', part, 1), 'import interruption did not occur'); check((await target.importStatus('p')).next_chunk === 0, 'failed chunk advanced checkpoint'); check((await target.evidence()).users.length === 0, 'failed chunk persisted rows');
   }
   await target.receive('p', part, 0); await target.receive('p', part, 0);
   if (nChunks === 0) { const altered = part.content + ' '; await rejects(async () => target.receive('p', { content: altered, digest: await hash(altered) }, 0), 'conflicting replay accepted'); }
   nChunks++;
   if (nChunks === 4) {
    await rejects(() => target.write('p', 2), 'partially imported destination writable');
    await rejects(() => target.evict(), 'target eviction must abort'); target = env.PROJECT.getByName(b);
    await rejects(() => source.evict(), 'source eviction must abort'); source = env.PROJECT.getByName(a);
    check((await target.importStatus('p')).next_chunk === nChunks && (await source.exportStatus('p')).next_chunk === nChunks, 'chunk checkpoints lost after eviction');
    await target.receive('p', first, 0);
   }
   if (payload.done) break;
   if (nChunks > 100) throw Error('Too many chunks');
  }
  check(total > 512 * 1024 && nChunks > 4, 'fixture did not exceed previous limit');
  for (const invalid of [false, true]) {
   const id = invalid ? 'invalid-text' : 'valid-text';
   const name = `${id}-${n}`, owner = env.PROJECT.getByName(name);
   await owner.init(id, name);
   await owner.seedRelocationText(id, invalid);
   await owner.freeze(id, 1, 'text-move');
   await owner.beginExport(id, 1, 'text-move', ['wide_text']);
   const before = await owner.relocationTextRows();
   if (invalid) {
    const checkpoint = await owner.exportStatus(id);
    await rejectsWith(() => owner.chunk(id, 1, 'text-move', 0, false), 'Invalid UTF-8 TEXT');
    check(JSON.stringify(await owner.exportStatus(id)) === JSON.stringify(checkpoint), 'invalid TEXT advanced export');
    check(JSON.stringify(await owner.relocationTextRows()) === JSON.stringify(before), 'invalid TEXT changed the source bytes');
   } else {
    const destinationName = `text-destination-${n}`, destination = env.PROJECT.getByName(destinationName);
    await destination.beginImport(id, 1, 'text-move', destinationName, ['wide_text']);
    const chunk = await owner.chunk(id, 1, 'text-move', 0, false);
    const unpaired = JSON.parse(chunk.content);
    unpaired.rows[0][1] = '\uD800';
    const content = JSON.stringify(unpaired);
    const unpairedChunk = { content, digest: await hash(content) };
    await rejectsWith(() => destination.receive(id, unpairedChunk, 0), 'Invalid UTF-8 TEXT');
    check((await destination.importStatus(id)).next_chunk === 0 && (await destination.relocationTextRows()).length === 0, 'invalid TEXT advanced import');
    await destination.receive(id, chunk, 0);
    check(JSON.stringify(await destination.relocationTextRows()) === JSON.stringify(before), 'valid multibyte or replacement character changed in relocation');
   }
  }
  const oldSourceName = `old-text-source-${n}`, oldTargetName = `old-text-target-${n}`;
  const oldSource = env.PROJECT.getByName(oldSourceName), oldTarget = env.PROJECT.getByName(oldTargetName);
  const oldId = 'legacy-text', oldMove = 'legacy-text-move';
  await oldSource.init(oldId, oldSourceName);
  await oldSource.seedRelocationText(oldId, false);
  await oldSource.freeze(oldId, 1, oldMove);
  await oldSource.beginExport(oldId, 1, oldMove, ['wide_text']);
  const guardedChunk = await oldSource.chunk(oldId, 1, oldMove, 0, false);
  await oldTarget.beginImport(oldId, 1, oldMove, oldTargetName, ['wide_text']);
  await oldTarget.clearTextGuardForTest('destination');
  const oldImport = await oldTarget.importStatus(oldId);
  await rejectsWith(() => oldTarget.beginImport(oldId, 1, oldMove, oldTargetName, ['wide_text']), 'Legacy relocation transfer');
  await rejectsWith(() => oldTarget.receive(oldId, guardedChunk, 0), 'Legacy relocation transfer');
  check(JSON.stringify(await oldTarget.importStatus(oldId)) === JSON.stringify(oldImport), 'legacy import advanced');
  await oldSource.clearTextGuardForTest('source');
  const oldExport = await oldSource.exportStatus(oldId);
  await rejectsWith(() => oldSource.beginExport(oldId, 1, oldMove, ['wide_text']), 'Legacy relocation transfer');
  await rejectsWith(() => oldSource.chunk(oldId, 1, oldMove, 0, false), 'Legacy relocation transfer');
  check(JSON.stringify(await oldSource.exportStatus(oldId)) === JSON.stringify(oldExport), 'legacy export advanced');
  const pendingName = `old-pending-${n}`, pending = env.PROJECT.getByName(pendingName);
  await pending.init(oldId, pendingName);
  await pending.seedRelocationText(oldId, false);
  await pending.freeze(oldId, 1, oldMove);
  await pending.beginExport(oldId, 1, oldMove, ['wide_text']);
  await rejectsWith(() => pending.chunk(oldId, 1, oldMove, 0, true), 'Injected export interruption');
  await pending.clearTextGuardForTest('source');
  const pendingExport = await pending.exportStatus(oldId);
  await rejectsWith(() => pending.chunk(oldId, 1, oldMove, 0, false), 'Legacy relocation transfer');
  check(JSON.stringify(await pending.exportStatus(oldId)) === JSON.stringify(pendingExport), 'legacy pending export advanced');
  // Persisted keysets are untrusted: malformed cursors must fail before a
  // row read, preserving source bytes and the exact stored checkpoint.
  const cursorName = `corrupt-cursor-${n}`, cursorOwner = env.PROJECT.getByName(cursorName);
  await cursorOwner.init('corrupt-cursor', cursorName); await cursorOwner.seedRelocationText('corrupt-cursor', false); await cursorOwner.freeze('corrupt-cursor', 1, 'move');
  await cursorOwner.beginExport('corrupt-cursor', 1, 'move', ['wide_text']);
  for (const value of ['', '[]', '["one","two"]', '[{"integer":"01"}]', '[{"integer":"-0"}]', '[{"integer":"9223372036854775808"}]', '[{"blob":"!"}]']) {
   await cursorOwner.setExportCursorForTest('corrupt-cursor', value);
   const before = { checkpoint: await cursorOwner.exportStatus('corrupt-cursor'), rows: await cursorOwner.relocationTextRows() };
   await rejectsWith(() => cursorOwner.chunk('corrupt-cursor', 1, 'move', 0, false), 'Invalid export cursor checkpoint');
   check(JSON.stringify(before) === JSON.stringify({ checkpoint: await cursorOwner.exportStatus('corrupt-cursor'), rows: await cursorOwner.relocationTextRows() }), 'invalid export cursor changed source or checkpoint');
  }
  // Historical guard-1 checkpoints must be rejected without modifying either
  // source bytes or destination rows and checkpoints.
  const guardSourceName = `guard1-source-${n}`, guardTargetName = `guard1-target-${n}`;
  const guardSource = env.PROJECT.getByName(guardSourceName), guardTarget = env.PROJECT.getByName(guardTargetName);
  await guardSource.init('guard1', guardSourceName); await guardSource.seedRelocationText('guard1', false); await guardSource.freeze('guard1', 1, 'guard1-move');
  await guardSource.beginExport('guard1', 1, 'guard1-move', ['wide_text']);
  const guardChunk = await guardSource.chunk('guard1', 1, 'guard1-move', 0, false);
  await guardTarget.beginImport('guard1', 1, 'guard1-move', guardTargetName, ['wide_text']);
  await guardTarget.setTextGuardForTest('destination', 'guard1', 1);
  const guardDestinationBefore = { status: await guardTarget.importStatus('guard1'), rows: await guardTarget.relocationTextRows() };
  await rejectsWith(() => guardTarget.beginImport('guard1', 1, 'guard1-move', guardTargetName, ['wide_text']), 'Legacy relocation transfer');
  await rejectsWith(() => guardTarget.receive('guard1', guardChunk, 0), 'Legacy relocation transfer');
  check(JSON.stringify(guardDestinationBefore) === JSON.stringify({ status: await guardTarget.importStatus('guard1'), rows: await guardTarget.relocationTextRows() }), 'guard-1 import rejection changed data');
  await guardSource.setTextGuardForTest('source', 'guard1', 1);
  const guardSourceBefore = { status: await guardSource.exportStatus('guard1'), rows: await guardSource.relocationTextRows() };
  await rejectsWith(() => guardSource.beginExport('guard1', 1, 'guard1-move', ['wide_text']), 'Legacy relocation transfer');
  await rejectsWith(() => guardSource.chunk('guard1', 1, 'guard1-move', 0, false), 'Legacy relocation transfer');
  check(JSON.stringify(guardSourceBefore) === JSON.stringify({ status: await guardSource.exportStatus('guard1'), rows: await guardSource.relocationTextRows() }), 'guard-1 export rejection changed data');

  // Guard-2 small legacy envelopes remain resumable. Corrupt persisted fields
  // and piece indexes must fail closed without erasing the original state.
  const smallLegacyName = `small-legacy-${n}`, smallLegacy = env.PROJECT.getByName(smallLegacyName), smallLegacyId = 'small-legacy';
  await smallLegacy.beginImport(smallLegacyId, 1, 'move', smallLegacyName, ['wide_text']);
  const legacyBytes = new TextEncoder().encode(JSON.stringify([{ text: new TextEncoder().encode('legacy').toBase64() }, { text: new TextEncoder().encode('x'.repeat(70_000)).toBase64() }]));
  const split = 80 * 1024;
  const oldPacket = { projectId: smallLegacyId, generation: 1, moveId: 'move', index: 0, prev: '', table: 'wide_text', columns: ['id', 'value'], offset: 0, rows: [], last: false, done: false, cursor: null, fragment: { offset: 0, total: legacyBytes.length, data: legacyBytes.subarray(0, split).toBase64(), cursor: ['legacy'] } };
  const oversizedPacket = { ...oldPacket, fragment: { ...oldPacket.fragment, total: 128 * 1024 + 1 } }, oversizedContent = JSON.stringify(oversizedPacket);
  const legacyBefore = { status: await smallLegacy.importStatus(smallLegacyId), rows: await smallLegacy.relocationTextRows(), controls: await smallLegacy.importControlCounts() };
  await rejects(async () => smallLegacy.receive(smallLegacyId, { content: oversizedContent, digest: await hash(oversizedContent) }, 0), 'oversized v1 envelope accepted');
  check(JSON.stringify(legacyBefore) === JSON.stringify({ status: await smallLegacy.importStatus(smallLegacyId), rows: await smallLegacy.relocationTextRows(), controls: await smallLegacy.importControlCounts() }), 'oversized v1 envelope changed state');
  const shortPacket = { ...oldPacket, fragment: { ...oldPacket.fragment, data: legacyBytes.subarray(0, split - 1).toBase64() } }, shortContent = JSON.stringify(shortPacket);
  await rejects(async () => smallLegacy.receive(smallLegacyId, { content: shortContent, digest: await hash(shortContent) }, 0), 'short nonfinal legacy fragment accepted');
  check(JSON.stringify(legacyBefore) === JSON.stringify({ status: await smallLegacy.importStatus(smallLegacyId), rows: await smallLegacy.relocationTextRows(), controls: await smallLegacy.importControlCounts() }), 'short nonfinal fragment changed state');
  const oldContent = JSON.stringify(oldPacket), oldDigest = await hash(oldContent), oldPart = { content: oldContent, digest: oldDigest };
  await smallLegacy.receive(smallLegacyId, oldPart, 0);
  const savedLegacy = await smallLegacy.fragmentForTest(smallLegacyId), savedStatus = await smallLegacy.importStatus(smallLegacyId);
  for (const [field, wrong] of [['table_name', 'events'], ['row_offset', 7], ['total', 0], ['next_offset', 0], ['cursor', '[]']]) {
   await smallLegacy.setFragmentForTest(smallLegacyId, field, wrong);
   await rejects(() => smallLegacy.beginImport(smallLegacyId, 1, 'move', smallLegacyName, ['wide_text']), `invalid small fragment ${field} accepted`);
   await smallLegacy.setFragmentForTest(smallLegacyId, field, savedLegacy[field]);
  }
  await smallLegacy.moveFragmentPieceForTest(smallLegacyId, 0, 99);
  await rejects(() => smallLegacy.beginImport(smallLegacyId, 1, 'move', smallLegacyName, ['wide_text']), 'invalid small fragment piece index accepted');
  await smallLegacy.moveFragmentPieceForTest(smallLegacyId, 99, 0);
  check(JSON.stringify(await smallLegacy.fragmentForTest(smallLegacyId)) === JSON.stringify(savedLegacy) && JSON.stringify(await smallLegacy.importStatus(smallLegacyId)) === JSON.stringify(savedStatus) && (await smallLegacy.relocationTextRows()).length === 0, 'legacy corruption test changed state');
  await smallLegacy.beginImport(smallLegacyId, 1, 'move', smallLegacyName, ['wide_text']);
  for (const invalid of ['x'.repeat(100_000), 'invalid-utf8']) {
   await smallLegacy.setImportDigestForTest(smallLegacyId, 0, invalid);
   await rejects(() => smallLegacy.beginImport(smallLegacyId, 1, 'move', smallLegacyName, ['wide_text']), 'invalid stored import digest accepted');
   check(JSON.stringify(await smallLegacy.fragmentForTest(smallLegacyId)) === JSON.stringify(savedLegacy) && JSON.stringify(await smallLegacy.importStatus(smallLegacyId)) === JSON.stringify(savedStatus) && (await smallLegacy.relocationTextRows()).length === 0, 'invalid stored digest changed data or checkpoint');
   await smallLegacy.setImportDigestForTest(smallLegacyId, 0, oldDigest);
  }
  const endPacket = { ...oldPacket, index: 1, prev: oldDigest, cursor: ['legacy'], fragment: { ...oldPacket.fragment, offset: split, data: legacyBytes.subarray(split).toBase64() } }, endContent = JSON.stringify(endPacket);
  const endPart = { content: endContent, digest: await hash(endContent) };
  await smallLegacy.addLegacyGarbage(smallLegacyId);
  let corruptBefore = { status: await smallLegacy.importStatus(smallLegacyId), fragment: await smallLegacy.fragmentForTest(smallLegacyId), pieces: await smallLegacy.legacyPieceSummary(smallLegacyId) };
  await rejects(() => smallLegacy.receive(smallLegacyId, endPart, 0), 'many legacy pieces accepted');
  check(JSON.stringify(corruptBefore) === JSON.stringify({ status: await smallLegacy.importStatus(smallLegacyId), fragment: await smallLegacy.fragmentForTest(smallLegacyId), pieces: await smallLegacy.legacyPieceSummary(smallLegacyId) }) && (await smallLegacy.relocationTextRows()).length === 0, 'many legacy pieces changed checkpoint or destination');
  await smallLegacy.removeLegacyGarbage(smallLegacyId);
  await smallLegacy.setFragmentPieceForTest(smallLegacyId, 0, new Uint8Array(128 * 1024 + 1).buffer);
  corruptBefore = { status: await smallLegacy.importStatus(smallLegacyId), fragment: await smallLegacy.fragmentForTest(smallLegacyId), pieces: await smallLegacy.legacyPieceSummary(smallLegacyId) };
  await rejects(() => smallLegacy.receive(smallLegacyId, endPart, 0), 'oversized stored legacy piece accepted');
  check(JSON.stringify(corruptBefore) === JSON.stringify({ status: await smallLegacy.importStatus(smallLegacyId), fragment: await smallLegacy.fragmentForTest(smallLegacyId), pieces: await smallLegacy.legacyPieceSummary(smallLegacyId) }) && (await smallLegacy.relocationTextRows()).length === 0, 'oversized legacy piece changed checkpoint or destination');
  await smallLegacy.setFragmentPieceForTest(smallLegacyId, 0, legacyBytes.subarray(0, split).buffer.slice(legacyBytes.byteOffset, legacyBytes.byteOffset + split));
  await smallLegacy.receive(smallLegacyId, endPart, 0);
  check(JSON.stringify(await smallLegacy.relocationTextRows()) === JSON.stringify([{ id: 'legacy', kind: 'text', bytes: '78'.repeat(70_000) }]), 'small legacy fragment changed bytes');
  for (const value of ['positive', 'negative']) {
   const owner = env.PROJECT.getByName(`nonfinite-${value}-${n}`);
   await owner.init(`nonfinite-${value}`, `nonfinite-${value}-${n}`); await owner.seedReal(`nonfinite-${value}`, value); await owner.freeze(`nonfinite-${value}`, 1, 'nonfinite-move');
   const state = await owner.realState(); check(state.kind === 'real' && state[value], 'non-finite REAL fixture was not stored');
   await owner.beginExport(`nonfinite-${value}`, 1, 'nonfinite-move', ['real_values']);
   await rejectsWith(() => owner.chunk(`nonfinite-${value}`, 1, 'nonfinite-move', 0, false), 'Non-finite REAL');
   check((await owner.exportStatus(`nonfinite-${value}`)).next_chunk === 0, 'rejected non-finite REAL advanced checkpoint');
  }
  const nullOwner = env.PROJECT.getByName(`real-null-${n}`);
  await nullOwner.init('real-null', `real-null-${n}`); await nullOwner.seedReal('real-null', 'null'); await nullOwner.freeze('real-null', 1, 'null-move');
  await nullOwner.beginExport('real-null', 1, 'null-move', ['real_values']);
  check(JSON.parse((await nullOwner.chunk('real-null', 1, 'null-move', 0, false)).content).rows[0][1] === null, 'SQL NULL was rejected or changed');
  // JSON numbers with large exponents parse to Infinity in JS. Ensure the
  // importer rejects them on both ordinary and fragmented row paths.
  for (const fragmented of [false, true]) for (const literal of ['1e999', '-1e999']) {
   const name = `nonfinite-import-${fragmented}-${literal}-${n}`, id = `nonfinite-import-${fragmented}-${literal}`;
   const object = env.PROJECT.getByName(name);
   await object.beginImport(id, 1, 'move', name, ['real_values']);
   const before = { rows: await object.realRows(), checkpoint: await object.importStatus(id), controls: await object.importControlCounts(), fence: await object.status(id) };
   const payload = { projectId: id, generation: 1, moveId: 'move', index: 0, prev: '', table: 'real_values', columns: ['id', 'value'], offset: 0, rows: [], last: false, done: false, cursor: ['value'] };
   if (fragmented) {
    const encoded = new TextEncoder().encode(`["value",${literal}]`);
    payload.fragment = { offset: 0, total: encoded.length, data: encoded.toBase64(), cursor: ['value'] };
   } else {
    payload.rows = [['value', '__NONFINITE__']]; payload.last = true; payload.done = true;
   }
   let content = JSON.stringify(payload);
   if (!fragmented) content = content.replace('"__NONFINITE__"', literal);
   const digest = await hash(content);
   await rejectsWith(() => object.receive(id, { content, digest }, 0), 'Non-finite REAL');
   const after = { rows: await object.realRows(), checkpoint: await object.importStatus(id), controls: await object.importControlCounts(), fence: await object.status(id) };
   check(JSON.stringify(after) === JSON.stringify(before), 'rejected non-finite import changed destination or checkpoint');
  }
  const finiteName = `finite-import-${n}`, finite = env.PROJECT.getByName(finiteName);
  await finite.beginImport('finite-import', 1, 'move', finiteName, ['real_values']);
  const finiteContent = JSON.stringify({ projectId: 'finite-import', generation: 1, moveId: 'move', index: 0, prev: '', table: 'real_values', columns: ['id', 'value'], offset: 0, rows: [['finite', 1.25], ['null', null]], last: true, done: true, cursor: ['null'] });
  await finite.receive('finite-import', { content: finiteContent, digest: await hash(finiteContent) }, 0);
  check(JSON.stringify(await finite.realRows()) === JSON.stringify([{ id: 'finite', kind: 'real', value: 1.25 }, { id: 'null', kind: 'null', value: null }]), 'finite REAL or NULL import changed');
  const frozen = await source.status('p'), staged = await target.status('p'); check(staged.state === 'staged' && staged.digest === frozen.digest, 'final digest mismatch');
  await target.beginImport('p', 1, 'move', b);
  const stagedReplayRows = await target.evidence(); await target.receive('p', first, 0);
  check(JSON.stringify(await target.evidence()) === JSON.stringify(stagedReplayRows), 'staged replay changed business state');
  await target.setImportDone('p', 0); await rejects(() => target.beginImport('p', 1, 'move', b), 'staged checkpoint without done flag accepted'); await target.setImportDone('p', 1);
  await target.dropImportFragmentTable();
  const missingSchema = await target.controlSchema(), stagedCheckpoint = await target.importStatus('p');
  await rejects(() => target.beginImport('p', 1, 'move', b), 'staged import silently recreated missing metadata');
  check(JSON.stringify(await target.controlSchema()) === JSON.stringify(missingSchema) && JSON.stringify(await target.importStatus('p')) === JSON.stringify(stagedCheckpoint), 'rejected incomplete checkpoint changed state');
  await target.restoreImportFragmentTable(); await target.beginImport('p', 1, 'move', b);
  await target.dropImportFragmentTable(); await target.seedMalformedFragmentTable();
  const alteredSchema = await target.controlSchema();
  await rejects(() => target.beginImport('p', 1, 'move', b), 'staged altered control constraints accepted');
  check(JSON.stringify(await target.controlSchema()) === JSON.stringify(alteredSchema), 'rejected altered schema was changed');
  await target.dropImportFragmentTable(); await target.restoreImportFragmentTable();
  for (const kind of ['index', 'trigger']) {
   await target.seedExtraControlObject(kind);
   const extraSchema = await target.controlSchema();
   await rejects(() => target.beginImport('p', 1, 'move', b), `extra control ${kind} accepted`);
   check(JSON.stringify(await target.controlSchema()) === JSON.stringify(extraSchema), `rejected control ${kind} changed schema`);
   await target.removeExtraControlObject(kind);
  }
  const indexed = await target.controlOwnershipPlans();
  const unindexed = indexed.filter(item => !item.details.some(detail => detail.includes('SEARCH') && detail.includes('INDEX')));
  check(!unindexed.length, `control ownership check did not use an index: ${JSON.stringify(unindexed)}`);
  check((await target.checkpointPlans()).every(details => details.some(detail => detail.includes('SEARCH') && detail.includes('INDEX'))), 'checkpoint lookup did not use an index');
  for (const table of ['mapi_relocation_project', 'mapi_chunk_export', 'mapi_chunk_export_data', 'mapi_chunk_import', 'mapi_chunk_import_data', 'mapi_chunk_import_fragment', 'mapi_chunk_import_fragment_data']) {
   for (const id of ['aaa-foreign', 'zzz-foreign']) {
    await target.seedForeignControl(table, id);
    await rejects(() => target.beginImport('p', 1, 'move', b), `foreign control row accepted in ${table}`);
    await rejects(() => target.receive('p', first, 0), `foreign control row accepted by replay in ${table}`);
    await target.removeForeignControl(table, id);
   }
  }
  for (const table of ['mapi_relocation_project', 'mapi_chunk_import', 'mapi_chunk_import_fragment']) {
   await target.seedForeignControl(table, null);
   await rejects(() => target.beginImport('p', 1, 'move', b), `NULL control row accepted in ${table}`);
   await target.removeForeignControl(table, null);
  }
  for (const table of ['mapi_chunk_import_data', 'mapi_chunk_import_fragment_data']) await rejects(() => target.seedForeignControl(table, null), `NULL project accepted in ${table}`);
  for (const table of ['mapi_relocation_project', 'mapi_chunk_import', 'mapi_chunk_import_data', 'mapi_chunk_import_fragment', 'mapi_chunk_import_fragment_data']) {
   const blobId = new Uint8Array([0x70]).buffer;
   await target.seedForeignControl(table, blobId);
   await rejects(() => target.beginImport('p', 1, 'move', b), `BLOB control identity accepted in ${table}`);
   await target.removeForeignControl(table, blobId);
  }
  for (const table of ['mapi_chunk_import_fragment', 'mapi_chunk_import_fragment_data']) {
   await target.seedForeignControl(table, 'p');
   await rejects(() => target.beginImport('p', 1, 'move', b), `staged import accepted leftover ${table}`);
   await rejects(() => target.receive('p', first, 0), `staged replay accepted leftover ${table}`);
   await target.removeForeignControl(table, 'p');
  }
  await target.seedForeignControl('mapi_chunk_import_data', 'p');
  await rejects(() => target.beginImport('p', 1, 'move', b), 'staged import accepted future history');
  await target.removeExtraImportHistory('p');
  const negativePayload = { ...JSON.parse(first.content), index: -1 }, negativeContent = JSON.stringify(negativePayload), negativeDigest = await hash(negativeContent);
  await target.setHistoryForTest('p', -1, negativeDigest);
  await rejects(() => target.beginImport('p', 1, 'move', b), 'staged import accepted negative history');
  await rejects(() => target.receive('p', { content: negativeContent, digest: negativeDigest }, 0), 'negative chunk replay accepted');
  await target.removeHistoryForTest('p', -1);
  const correctChain = (await target.importStatus('p')).chain;
  await target.setImportChain('p', '0'.repeat(64));
  await rejects(() => target.beginImport('p', 1, 'move', b), 'staged import accepted mismatched chain');
  await target.setImportChain('p', correctChain);
  await target.setRelocationField('p', 'digest', '0'.repeat(64));
  await rejects(() => target.beginImport('p', 1, 'move', b), 'staged import accepted mismatched digest');
  await target.setRelocationField('p', 'digest', staged.digest);
  const lastHistory = await target.removeLastHistory('p');
  await rejects(() => target.beginImport('p', 1, 'move', b), 'staged import accepted missing last history');
  await target.restoreHistory('p', lastHistory);
  await target.beginImport('p', 1, 'move', b);
  for (const [field, wrong, original] of [['project_id', 'foreign', 'p'], ['generation', 3, 2], ['move_id', 'other-move', 'move'], ['object_name', 'other-object', b], ['state', 'retired', 'staged']]) {
   await target.setRelocationField('p', field, wrong);
   await rejects(() => target.beginImport('p', 1, 'move', b), `mismatched ${field} accepted`);
   await target.setRelocationField(field === 'project_id' ? wrong : 'p', field, original);
  }
  check(JSON.stringify(await target.status('p')) === JSON.stringify(staged), 'local tuple test did not restore staged state');
  const evidence = await target.evidence(); check(evidence.users.length === 12 && evidence.sessions === 12 && evidence.events === 12 && !evidence.fks.length, 'missing data or invalid foreign keys');
  check(evidence.users[0][1].integer === '9223372036854775807' && evidence.users[1][1].integer === '-9223372036854775808', 'int64 changed');
  check(Uint8Array.fromBase64(evidence.users[4][2].blob).length === 50_000 && Uint8Array.fromBase64(evidence.users[4][2].blob)[0] === 4, 'blob changed');
  const pagedSource = env.PROJECT.getByName(`paged-source-${n}`), pagedTarget = env.PROJECT.getByName(`paged-target-${n}`);
  await pagedSource.init('paged', `paged-source-${n}`); await pagedSource.seedMany('paged'); await pagedSource.freeze('paged', 1, 'paged-move');
  await pagedSource.beginExport('paged', 1, 'paged-move', ['users']); await pagedTarget.beginImport('paged', 1, 'paged-move', `paged-target-${n}`, ['users']);
  const firstPage = await pagedSource.chunk('paged', 1, 'paged-move', 0, false); const firstRows = JSON.parse(firstPage.content).rows;
  check(firstRows.length === 64 && JSON.parse((await pagedSource.exportStatus('paged')).cursor)[0] === 'key-0063', 'keyset cursor did not checkpoint');
  await pagedTarget.receive('paged', firstPage, 0);
  const secondPage = await pagedSource.chunk('paged', 1, 'paged-move', 1, false); await pagedTarget.receive('paged', secondPage, 0);
  const lastPage = await pagedSource.chunk('paged', 1, 'paged-move', 2, false); await pagedTarget.receive('paged', lastPage, 0);
  check(JSON.parse(lastPage.content).done && (await pagedTarget.evidence()).users.length === 130, 'keyset pagination lost or duplicated rows');
  const compoundSource = env.PROJECT.getByName(`compound-source-${n}`), compoundTarget = env.PROJECT.getByName(`compound-target-${n}`);
  await compoundSource.init('compound', `compound-source-${n}`); await compoundSource.seedCompound('compound'); await compoundSource.freeze('compound', 1, 'compound-move');
  await compoundSource.beginExport('compound', 1, 'compound-move', ['compound']); await compoundTarget.beginImport('compound', 1, 'compound-move', `compound-target-${n}`, ['compound']);
  const compoundFirst = await compoundSource.chunk('compound', 1, 'compound-move', 0, false);
  const compoundCursor = JSON.parse((await compoundSource.exportStatus('compound')).cursor);
  check(compoundCursor[0].integer === '9223372036854775807' && compoundCursor[1] === 'key-0063', 'composite cursor lost int64 precision');
  await compoundTarget.receive('compound', compoundFirst, 0);
  const compoundLast = await compoundSource.chunk('compound', 1, 'compound-move', 1, false); await compoundTarget.receive('compound', compoundLast, 0);
  check(JSON.parse(compoundLast.content).done && await compoundTarget.compoundCount() === 70, 'composite keyset pagination lost rows');
  check((await compoundSource.compoundPlan()).some(detail => detail.includes('SEARCH') && detail.includes('INDEX')), 'composite keyset did not seek on an index');
  const caseSource = env.PROJECT.getByName(`case-source-${n}`), caseTarget = env.PROJECT.getByName(`case-target-${n}`);
  await caseSource.init('case', `case-source-${n}`); await caseSource.seedCaseKeys('case'); await caseSource.freeze('case', 1, 'case-move');
  await caseSource.beginExport('case', 1, 'case-move', ['case_keys']); await caseTarget.beginImport('case', 1, 'case-move', `case-target-${n}`, ['case_keys']);
  const caseFirst = await caseSource.chunk('case', 1, 'case-move', 0, false); await caseTarget.receive('case', caseFirst, 0);
  const caseLast = await caseSource.chunk('case', 1, 'case-move', 1, false); await caseTarget.receive('case', caseLast, 0);
  check(JSON.parse(caseLast.content).done && JSON.stringify(await caseSource.caseKeys()) === JSON.stringify(await caseTarget.caseKeys()), 'declared collation changed pagination');
  check((await caseSource.casePlan()).some(detail => detail.includes('INDEX')), 'declared collation query plan missing index');
  let huge = env.PROJECT.getByName(`huge-${n}`), hugeTarget = env.PROJECT.getByName(`huge-target-${n}`);
  await huge.init('huge', `huge-${n}`); await huge.oversized('huge'); await huge.freeze('huge', 1, 'big-move');
  await huge.beginExport('huge', 1, 'big-move', ['users']); await hugeTarget.beginImport('huge', 1, 'big-move', `huge-target-${n}`, ['users']);
  await rejects(() => huge.chunk('huge', 1, 'big-move', 0, true), 'fragment export interruption did not occur');
  check((await huge.exportStatus('huge')).next_chunk === 0, 'interrupted fragment advanced export');
  await rejects(() => huge.evict(), 'fragment source eviction must abort'); huge = env.PROJECT.getByName(`huge-${n}`);
  let fragments = 0, fragmentParts = 0, firstFragment;
  for (;;) {
   const part = await huge.chunk('huge', 1, 'big-move', fragments, false);
   const payload = JSON.parse(part.content);
   check(new TextEncoder().encode(part.content).length <= 128 * 1024, 'stream chunk exceeded size');
   check((await huge.chunk('huge', 1, 'big-move', fragments, false)).content === part.content, 'stream replay bytes changed');
   if (payload.stream) {
    fragmentParts++;
    if (fragments === 0) {
     firstFragment = part;
     const future = await huge.chunk('huge', 1, 'big-move', 1, false);
     await rejects(() => hugeTarget.receive('huge', future, 0), 'out-of-order stream accepted');
     const descriptors = payload.stream.types.map(type => type.kind === 'blob' ? { ...type, length: 8_388_609 } : type);
     const changed = { ...payload, stream: { ...payload.stream, types: descriptors } };
     const content = JSON.stringify(changed);
     const beforeOversized = { status: await hugeTarget.importStatus('huge'), rows: await hugeTarget.evidence(), controls: await hugeTarget.importControlCounts() };
     await rejects(async () => hugeTarget.receive('huge', { content, digest: await hash(content) }, 0), 'oversized stream accepted');
     check(JSON.stringify(beforeOversized) === JSON.stringify({ status: await hugeTarget.importStatus('huge'), rows: await hugeTarget.evidence(), controls: await hugeTarget.importControlCounts() }), 'oversized stream changed state');
    }
    if (fragments === 1) {
     const changed = { ...payload, stream: { ...payload.stream, cursor: ['wrong-key'] } };
     const content = JSON.stringify(changed);
     await rejects(async () => hugeTarget.receive('huge', { content, digest: await hash(content) }, 0), 'conflicting stream cursor accepted');
    }
    if (payload.stream.rowDone) {
     // Corrupt an already committed BLOB slice without changing its size.
     // The final frame must preserve the checkpoint and all durable pieces.
     const saved = await hugeTarget.streamPieceForTest('huge', 2, 0);
     const changed = new Uint8Array(saved.slice(0));
     changed[0] ^= 1;
     await hugeTarget.setStreamPieceForTest('huge', 2, 0, changed.buffer);
     const before = {
      checkpoint: await hugeTarget.importStatus('huge'),
      stream: await hugeTarget.streamForTest('huge'),
      pieces: await hugeTarget.streamPieceCountForTest('huge'),
      rows: await hugeTarget.evidence(),
     };
     await rejects(() => hugeTarget.receive('huge', part, 0), 'same-size corrupted stream piece accepted');
     const after = {
      checkpoint: await hugeTarget.importStatus('huge'),
      stream: await hugeTarget.streamForTest('huge'),
      pieces: await hugeTarget.streamPieceCountForTest('huge'),
      rows: await hugeTarget.evidence(),
     };
     check(JSON.stringify(before) === JSON.stringify(after), 'corrupted stream piece changed checkpoint or business rows');
     await hugeTarget.setStreamPieceForTest('huge', 2, 0, saved);
     await rejects(() => hugeTarget.receive('huge', part, 1), 'final stream rollback was not injected');
     check((await hugeTarget.importStatus('huge')).next_chunk === fragments && (await hugeTarget.evidence()).users.length === 0, 'failed final stream persisted row or checkpoint');
    }
   }
   await hugeTarget.receive('huge', part, 0); await hugeTarget.receive('huge', part, 0);
   if (fragments === 0) {
    await hugeTarget.beginImport('huge', 1, 'big-move', `huge-target-${n}`, ['users']);
    const saved = await hugeTarget.streamForTest('huge');
    for (const [field, wrong] of [['table_name', 'events'], ['row_offset', 7], ['last_chunk', 99]]) {
     await hugeTarget.setStreamForTest('huge', field, wrong);
     await rejects(() => hugeTarget.beginImport('huge', 1, 'big-move', `huge-target-${n}`, ['users']), `invalid stream ${field} accepted`);
     await hugeTarget.setStreamForTest('huge', field, saved[field]);
    }
    await hugeTarget.beginImport('huge', 1, 'big-move', `huge-target-${n}`, ['users']);
    const content = part.content + ' ';
    await rejects(async () => hugeTarget.receive('huge', { content, digest: await hash(content) }, 0), 'conflicting stream replay accepted');
   }
   fragments++;
   if (fragments === 2) {
    await rejects(() => hugeTarget.evict(), 'stream target eviction must abort'); hugeTarget = env.PROJECT.getByName(`huge-target-${n}`);
    await rejects(() => huge.evict(), 'stream source eviction must abort'); huge = env.PROJECT.getByName(`huge-${n}`);
    await hugeTarget.receive('huge', firstFragment, 0);
   }
   if (payload.done) break;
   if (fragments > 20) throw Error('Too many stream chunks');
  }
  const hugeRows = (await hugeTarget.evidence()).users;
  const hugeData = Uint8Array.fromBase64(hugeRows[0][2].blob);
  check(fragmentParts > 2 && hugeRows.length === 1 && hugeRows[0][1].integer === '9223372036854775807' && hugeData.length === 300_000 && hugeData.every((value, index) => value === index % 251), 'fragmented row changed');
  const textSource = env.PROJECT.getByName(`text-source-${n}`), textTarget = env.PROJECT.getByName(`text-target-${n}`);
  await textSource.init('text', `text-source-${n}`); await textSource.seedWideText('text'); await textSource.freeze('text', 1, 'text-move');
  await textSource.beginExport('text', 1, 'text-move', ['wide_text']); await textTarget.beginImport('text', 1, 'text-move', `text-target-${n}`, ['wide_text']);
  for (let index = 0; index < 20; index++) {
   const part = await textSource.chunk('text', 1, 'text-move', index, false); await textTarget.receive('text', part, 0);
   if (JSON.parse(part.content).done) break;
   if (index === 19) throw Error('Text transfer did not finish');
  }
  check(await textTarget.readWideText() === '\uFEFF' + 'é😀\n'.repeat(45_000), 'fragmented Unicode text changed');
  // Ordinary rows retain the prior wire shape. Oversized rows use the v2
  // stream and each bounded cell slice must replay with identical bytes.
  for (const fixture of ['below', 'at', 'above', 'long-ascii', 'escaped', 'unicode', 'unicode-fallback', 'blob', 'mixed']) {
   const id = `wire-${fixture}`, move = `${id}-move`, sourceName = `${id}-source-${n}`, targetName = `${id}-target-${n}`;
   const wireSource = env.PROJECT.getByName(sourceName), wireTarget = env.PROJECT.getByName(targetName);
   const base = { projectId: id, generation: 1, moveId: move, index: 0, prev: '', table: 'wide_text', columns: ['id', 'value'], offset: 0, rows: [['wide', '']], last: false, done: false, cursor: ['wide'] };
   const boundary = 64 * 1024 - 4; // The TEXT primary key contributes four bytes.
   const value = fixture === 'below' ? 'x'.repeat(boundary - 1) : fixture === 'at' ? 'x'.repeat(boundary) : fixture === 'above' ? 'x'.repeat(boundary + 1) : fixture === 'long-ascii' || fixture === 'mixed' ? 'x'.repeat(140_000) : fixture === 'escaped' ? '\n"\\'.repeat(50_000) : fixture === 'unicode' ? 'é😀'.repeat(50_000) : fixture === 'unicode-fallback' ? 'é'.repeat(70_000) : new Uint8Array(140_000).fill(42).buffer;
   const small = fixture === 'mixed';
   await wireSource.init(id, sourceName); await wireSource.seedWireRows(id, value, small); await wireSource.freeze(id, 1, move);
   await wireSource.beginExport(id, 1, move, ['wide_text']); await wireTarget.beginImport(id, 1, move, targetName, ['wide_text']);
   let index = 0, prev = '', sawStream = false, sawDone = false;
   const values = [new TextEncoder().encode('wide'), typeof value === 'string' ? new TextEncoder().encode(value) : new Uint8Array(value)];
   const offsets = [0, 0];
   for (; index < 20; index++) {
    const part = await wireSource.chunk(id, 1, move, index, false), payload = JSON.parse(part.content);
    check(part.digest === await hash(part.content) && (await wireSource.chunk(id, 1, move, index, false)).content === part.content, 'wire replay or digest changed');
    check(payload.prev === prev && new TextEncoder().encode(part.content).length <= 128 * 1024, 'wire chain or bound changed');
    if (payload.stream) {
     sawStream = true;
     const stream = payload.stream, expected = values[stream.column], data = Uint8Array.fromBase64(stream.data);
     check(stream.v === 2 && expected && stream.offset === offsets[stream.column] && stream.total === expected.length && data.length <= 64 * 1024, 'stream metadata or bound differs');
     check(data.every((byte, i) => byte === expected[stream.offset + i]), 'stream cell bytes changed');
     offsets[stream.column] += data.length;
     if (stream.rowDone) check(offsets.every((offset, i) => offset === values[i].length), 'stream completed before all cell bytes');
    } else if (fixture === 'below' || fixture === 'at') {
     const expected = { ...base, rows: [['wide', value]], last: true, done: true };
     check(part.content === JSON.stringify(expected), 'ordinary chunk wire bytes changed');
    }
    await wireTarget.receive(id, part, 0); await wireTarget.receive(id, part, 0);
    prev = part.digest;
    if (payload.done) { sawDone = true; break; }
   }
   check(sawDone && sawStream === !['below', 'at'].includes(fixture), 'wrong ordinary or streamed row decision');
   const copied = await wireTarget.readWideText();
   check(typeof value === 'string' ? copied === value : copied instanceof ArrayBuffer && new Uint8Array(copied).length === 140_000 && new Uint8Array(copied).every(byte => byte === 42), 'wire fixture changed during transfer');
  }
  const tooLarge = env.PROJECT.getByName(`too-large-${n}`);
  await tooLarge.init('too-large', `too-large-${n}`); await tooLarge.beyondRowLimit('too-large'); await tooLarge.freeze('too-large', 1, 'too-large-move');
  await tooLarge.beginExport('too-large', 1, 'too-large-move', ['users']);
  if (MAX_ROW_VALUE_BYTES < 8_385_013) {
   await rejects(() => tooLarge.chunk('too-large', 1, 'too-large-move', 0, false), 'row beyond configured limit accepted');
   check((await tooLarge.exportStatus('too-large')).next_chunk === 0, 'rejected row advanced export checkpoint');
  } else {
   const formerlyOversized = await tooLarge.chunk('too-large', 1, 'too-large-move', 0, false);
   check(JSON.parse(formerlyOversized.content).stream?.types.some(type => type.kind === 'blob' && type.length === 8_385_000), 'platform-valid row did not enter streamed export');
   check((await tooLarge.exportStatus('too-large')).next_chunk === 1, 'streamed row did not advance export checkpoint');
  }
  const badSource = env.PROJECT.getByName(`bad-source-${n}`), badTarget = env.PROJECT.getByName(`bad-target-${n}`); await badSource.init('bad', `bad-source-${n}`); await badSource.seed('bad'); await badSource.freeze('bad', 1, 'bad-move');
  const reverse = ['events', 'sessions', 'users']; await badSource.beginExport('bad', 1, 'bad-move', reverse); await badTarget.beginImport('bad', 1, 'bad-move', `bad-target-${n}`, reverse);
  const invalidOrder = await badSource.chunk('bad', 1, 'bad-move', 0, false); await rejects(() => badTarget.receive('bad', invalidOrder, 0), 'foreign-key dependency violation accepted');
  check((await badTarget.importStatus('bad')).next_chunk === 0 && (await badTarget.evidence()).events === 0, 'foreign-key failure persisted rows or checkpoint');
  const route = await registry.commit('p', 1, 'move', frozen, staged); await target.activate('p', 2, 'move', route); await source.retire('p', 1, 'move', route);
  const retiredSchema = await source.controlSchema(), retiredState = await source.status('p'), retiredRows = await source.evidence();
  await rejects(() => source.beginExport('p', 1, 'move'), 'retired source accepted old export initializer');
  check(JSON.stringify(await source.controlSchema()) === JSON.stringify(retiredSchema) && JSON.stringify(await source.status('p')) === JSON.stringify(retiredState) && JSON.stringify(await source.evidence()) === JSON.stringify(retiredRows), 'rejected retired export changed state');
  await target.dropImportFragmentTable();
  const activeSchema = await target.controlSchema(), activeState = await target.status('p'), activeRows = await target.evidence();
  await rejects(() => target.beginImport('p', 1, 'move', b), 'active destination accepted old import initializer');
  await rejects(() => target.receive('p', first, 0), 'active destination accepted old chunk replay');
  check(JSON.stringify(await target.controlSchema()) === JSON.stringify(activeSchema), 'rejected active import changed control schema');
  check(JSON.stringify(await target.status('p')) === JSON.stringify(activeState) && JSON.stringify(await target.evidence()) === JSON.stringify(activeRows), 'rejected active import changed project state');
  await rejects(() => source.write('p', 1), 'retired source writable'); await rejects(() => target.write('p', 1), 'stale generation accepted'); await target.write('p', 2);
  await target.convertToOwnerFence('p', b);
  const ownerSchema = await target.controlSchema(), ownerState = await target.ownerFence(), ownerRows = await target.evidence();
  await rejects(() => target.beginImport('p', 1, 'move', b), 'activated owner accepted old import initializer');
  await rejects(() => target.receive('p', first, 0), 'activated owner accepted old chunk replay');
  check(JSON.stringify(await target.controlSchema()) === JSON.stringify(ownerSchema) && JSON.stringify(await target.ownerFence()) === JSON.stringify(ownerState) && JSON.stringify(await target.evidence()) === JSON.stringify(ownerRows), 'rejected activated-owner import changed state');
  return Response.json({ ok: true, bytes: total, chunks: nChunks });
 } catch (error) { return Response.json({ ok: false, error: String(error), stack: error?.stack }, { status: 500 }); }
}};
