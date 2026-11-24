// Native helper-level control-trigger regression. This does not run an owner,
// real relocation, transfer history, or any deferred boundary suite.
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { initializeProjectFence, freezeProject } from '../worker/relocation.js';
import { beginChunkExport, exportChunk, beginChunkImport, importChunk } from '../worker/relocation-chunks.js';

function fixture() {
  const db=new DatabaseSync(':memory:');
  db.exec('CREATE TABLE projects(id TEXT PRIMARY KEY, name TEXT NOT NULL)');
  const storage={ transactionSync(fn) {db.exec('BEGIN');try{const v=fn();db.exec('COMMIT');return v;}catch(e){db.exec('ROLLBACK');throw e;}},
    sql:{exec(sql,...args){const stmt=db.prepare(sql), binds=args.map(v=>v instanceof ArrayBuffer?new Uint8Array(v):v); const cols=stmt.columns().map(c=>c.name);const rows=cols.length?stmt.all(...binds):(stmt.run(...binds),[]);return {columnNames:cols,toArray:()=>rows,one:()=>rows[0],raw:()=>{const r=rows.map(row=>cols.map(c=>row[c]));r.toArray=()=>r;return r;}};}}};
  return {db,storage};
}
const source=fixture(), destination=fixture();
try {
  source.db.exec("INSERT INTO projects VALUES ('p','source')");
  initializeProjectFence(source.storage,'p','source'); freezeProject(source.storage,'p',1,'move');
  beginChunkExport(source.storage,'p',1,'move',['projects']);
  beginChunkImport(destination.storage,'p',1,'move','destination',['projects']);
  const chunk=await exportChunk(source.storage,'p',1,'move',0);
  destination.db.exec('CREATE TABLE marker(n INTEGER)');
  destination.db.exec('CREATE TRIGGER control_side_effect AFTER UPDATE ON MAPI_CHUNK_IMPORT BEGIN INSERT INTO marker VALUES (1); END');
  const target=destination.db.prepare("SELECT tbl_name FROM sqlite_schema WHERE name='control_side_effect'").get();
  assert.equal(target.tbl_name,'MAPI_CHUNK_IMPORT');
  await assert.rejects(importChunk(destination.storage,'p',chunk),/Import control schema is incomplete or changed/);
  assert.equal(destination.db.prepare('SELECT COUNT(*) AS n FROM marker').get().n,0);
  assert.equal(destination.db.prepare('SELECT COUNT(*) AS n FROM projects').get().n,0);
  assert.equal(destination.db.prepare('SELECT next_chunk FROM mapi_chunk_import').get().next_chunk,0);
  destination.db.exec('DROP TRIGGER control_side_effect');
  await importChunk(destination.storage,'p',chunk);
  assert.equal(destination.db.prepare('SELECT name FROM projects').get().name,'source');
  console.log('Native relocation control trigger case guard passed');
} finally { source.db.close(); destination.db.close(); }
