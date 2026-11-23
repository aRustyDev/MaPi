// Native SQLite comparison using the pinned Nextgen credential tables and the
// actual chunk exporter/importer. This does not exercise a real owner or a
// hosted deployment; it checks small credential values and NULL separately.
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import baseline from '../worker/generated/baseline.json' with { type: 'json' };
import { initializeProjectFence, freezeProject } from '../worker/relocation.js';
import { beginChunkExport, exportChunk, beginChunkImport, importChunk, chunkExportStatus, chunkImportStatus } from '../worker/relocation-chunks.js';

function sqlite() {
 const db = new DatabaseSync(':memory:');
 db.exec('PRAGMA foreign_keys = ON');
 const storage = {
  transactionSync(fn) {
   db.exec('BEGIN');
   try { const value = fn(); db.exec('COMMIT'); return value; }
   catch (error) { db.exec('ROLLBACK'); throw error; }
  },
  sql: { exec(sql, ...args) {
   const statement = db.prepare(sql);
   const binds = args.map(value => value instanceof ArrayBuffer ? new Uint8Array(value) : value);
   const columns = statement.columns().map(column => column.name);
   let rows;
   if (columns.length) rows = statement.all(...binds);
   else { statement.run(...binds); rows = []; }
   return { columnNames: columns, toArray: () => rows, one: () => rows[0], raw: () => {
    const values = rows.map(row => columns.map(column => row[column]));
    values.toArray = () => values;
    return values;
   } };
  } },
 };
 return { db, storage };
}

const tables = ['projects', 'users', 'user_attributes', 'auth_attempts', 'user_totp', 'user_passkeys'];
const source = sqlite(), destination = sqlite(), sourceOther = sqlite(), destinationOther = sqlite();
try {
 for (const table of tables) {
  const ddl = baseline.statements.find(sql => new RegExp(`^CREATE TABLE ${table}\\s`, 'i').test(sql));
  assert.ok(ddl, `Missing pinned schema: ${table}`);
  for (const object of [source, destination, sourceOther, destinationOther]) object.db.exec(ddl);
 }
 source.db.exec(`
  INSERT INTO projects(id,name,created_at,updated_at) VALUES ('p','project',1,1);
  INSERT INTO users(project_id,id,schema_url,created_at,updated_at) VALUES ('p','u','schema',1,1);
  INSERT INTO user_attributes(project_id,user_id,key,value,value_hash) VALUES
   ('p','u','empty','value',X''), ('p','u','null','value',NULL), ('p','u','bytes','value',X'0001FF80');
  INSERT INTO auth_attempts(project_id,id,handoff_token,created_at) VALUES
   ('p','empty',X'',1), ('p','null',NULL,1), ('p','bytes',X'0001FF80',1);
  INSERT INTO user_totp(project_id,id,user_id,secret,created_at,updated_at) VALUES ('p','totp','u',X'0001FF80',1,1);
  INSERT INTO user_passkeys(project_id,id,user_id,credential_id,public_key,aaguid,transports,created_at,updated_at)
   VALUES ('p','passkey','u','credential',X'0001FF80',X'', '[]',1,1);
 `);
 // A second isolated object deliberately reuses local user and credential
 // identifiers with different bytes. Interleaving transfers must never mix
 // the two projects' records or checkpoints.
 sourceOther.db.exec(`
  INSERT INTO projects(id,name,created_at,updated_at) VALUES ('q','other project',1,1);
  INSERT INTO users(project_id,id,schema_url,created_at,updated_at) VALUES ('q','u','schema',1,1);
  INSERT INTO user_attributes(project_id,user_id,key,value,value_hash) VALUES ('q','u','bytes','other',X'AA55');
  INSERT INTO auth_attempts(project_id,id,handoff_token,created_at) VALUES ('q','bytes',X'AA55',1);
  INSERT INTO user_totp(project_id,id,user_id,secret,created_at,updated_at) VALUES ('q','totp','u',X'AA55',1,1);
  INSERT INTO user_passkeys(project_id,id,user_id,credential_id,public_key,aaguid,transports,created_at,updated_at)
   VALUES ('q','passkey','u','credential',X'AA55',X'AB', '[]',1,1);
 `);
 initializeProjectFence(source.storage, 'p', 'source');
 freezeProject(source.storage, 'p', 1, 'move');
 beginChunkExport(source.storage, 'p', 1, 'move', tables);
 beginChunkImport(destination.storage, 'p', 1, 'move', 'destination', tables);
 initializeProjectFence(sourceOther.storage, 'q', 'source-other');
 freezeProject(sourceOther.storage, 'q', 1, 'move-other');
 beginChunkExport(sourceOther.storage, 'q', 1, 'move-other', tables);
 beginChunkImport(destinationOther.storage, 'q', 1, 'move-other', 'destination-other', tables);
 let credentialChunkTested = false;
 let otherIndex = 0;
 for (let index = 0; !chunkExportStatus(source.storage, 'p').done; index++) {
  if (!chunkExportStatus(sourceOther.storage, 'q').done) {
   const otherChunk = await exportChunk(sourceOther.storage, 'q', 1, 'move-other', otherIndex++);
   await importChunk(destinationOther.storage, 'q', otherChunk);
  }
  const chunk = await exportChunk(source.storage, 'p', 1, 'move', index);
  const payload = JSON.parse(chunk.content);
  if (!credentialChunkTested && payload.table === 'user_attributes' && payload.rows.length) {
   // Exercise rollback after a real credential-table row write. The import
   // checkpoint and every previously committed credential remain unchanged.
   const before = chunkImportStatus(destination.storage, 'p');
   const rows = destination.db.prepare('SELECT key, typeof(value_hash) AS type, hex(value_hash) AS bytes FROM user_attributes ORDER BY key').all();
   await assert.rejects(importChunk(destination.storage, 'p', chunk, 1), /Injected chunk failure/);
   assert.deepEqual(chunkImportStatus(destination.storage, 'p'), before);
   assert.deepEqual(destination.db.prepare('SELECT key, typeof(value_hash) AS type, hex(value_hash) AS bytes FROM user_attributes ORDER BY key').all(), rows);
   await importChunk(destination.storage, 'p', chunk);
   const committed = chunkImportStatus(destination.storage, 'p');
   const committedRows = destination.db.prepare('SELECT key, typeof(value_hash) AS type, hex(value_hash) AS bytes FROM user_attributes ORDER BY key').all();
   // The acknowledgement is treated as lost: replaying the identical chunk
   // must not advance the checkpoint or insert a second set of rows.
   await importChunk(destination.storage, 'p', chunk);
   assert.deepEqual(chunkImportStatus(destination.storage, 'p'), committed);
   assert.deepEqual(destination.db.prepare('SELECT key, typeof(value_hash) AS type, hex(value_hash) AS bytes FROM user_attributes ORDER BY key').all(), committedRows);
   credentialChunkTested = true;
   continue;
  }
  await importChunk(destination.storage, 'p', chunk);
 }
 while (!chunkExportStatus(sourceOther.storage, 'q').done) {
  const otherChunk = await exportChunk(sourceOther.storage, 'q', 1, 'move-other', otherIndex++);
  await importChunk(destinationOther.storage, 'q', otherChunk);
 }
 assert.equal(credentialChunkTested, true, 'Credential-table rollback and replay were not exercised');
 for (const [table, id, column] of [
  ['user_attributes','key','value_hash'], ['auth_attempts','id','handoff_token'],
  ['user_totp','id','secret'], ['user_passkeys','id','public_key'], ['user_passkeys','id','aaguid'],
 ]) {
  const query = `SELECT ${id} AS id, typeof(${column}) AS storage_type, length(${column}) AS size, hex(${column}) AS hex FROM ${table} ORDER BY ${id}`;
  assert.deepEqual(destination.db.prepare(query).all(), source.db.prepare(query).all(), `${table}.${column}`);
  assert.deepEqual(destinationOther.db.prepare(query).all(), sourceOther.db.prepare(query).all(), `other ${table}.${column}`);
 }
 for (const table of tables) {
  const projectColumn = table === 'projects' ? 'id' : 'project_id';
  assert.equal(destination.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${projectColumn} <> 'p'`).get().n, 0, table);
  assert.equal(destinationOther.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${projectColumn} <> 'q'`).get().n, 0, `other ${table}`);
 }
 assert.equal(destination.db.prepare("SELECT hex(secret) AS value FROM user_totp WHERE id='totp'").get().value, '0001FF80');
 assert.equal(destinationOther.db.prepare("SELECT hex(secret) AS value FROM user_totp WHERE id='totp'").get().value, 'AA55');
 assert.deepEqual(destination.db.prepare('PRAGMA foreign_key_check').all(), []);
 assert.deepEqual(destinationOther.db.prepare('PRAGMA foreign_key_check').all(), []);
 console.log('Pinned credential BLOB and NULL values survive interleaved native chunk rollback, replay and transfer');
} finally { for (const object of [source, destination, sourceOther, destinationOther]) object.db.close(); }
