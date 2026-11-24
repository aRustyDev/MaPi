// Native same-isolate caller test for mutable chunk envelopes. The production
// source-owner RPC normally returns a detached value; this does not establish
// that a deployed caller can mutate that RPC result or prove a real move.
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { initializeProjectFence, freezeProject } from '../worker/relocation.js';
import { beginChunkExport, exportChunk, beginChunkImport, importChunk, chunkImportStatus } from '../worker/relocation-chunks.js';

function make() {
 const db=new DatabaseSync(':memory:');
 db.exec('CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL)');
 const storage={
  transactionSync(fn) {db.exec('BEGIN');try {const result=fn();db.exec('COMMIT');return result;}catch(e){db.exec('ROLLBACK');throw e;}},
  sql:{exec(sql,...args) {
   const stmt=db.prepare(sql), binds=args.map(v=>v instanceof ArrayBuffer?new Uint8Array(v):v);
   const columns=stmt.columns().map(column=>column.name), rows=columns.length?stmt.all(...binds):(stmt.run(...binds),[]);
   return {columnNames:columns,toArray:()=>rows,one:()=>rows[0],raw:()=>{const r=rows.map(row=>columns.map(c=>row[c]));r.toArray=()=>r;return r;}};
  }},
 };
 return {db,storage};
}
const source=make(), target=make();
try {
 source.db.exec("INSERT INTO projects VALUES ('p','original')");
 initializeProjectFence(source.storage,'p','source'); freezeProject(source.storage,'p',1,'move');
 beginChunkExport(source.storage,'p',1,'move',['projects']); beginChunkImport(target.storage,'p',1,'move','target',['projects']);
 const chunk=await exportChunk(source.storage,'p',1,'move',0);
 const altered=JSON.parse(chunk.content);
 assert.equal(altered.rows.length,1);
 const name=altered.columns.indexOf('name'); assert.ok(name>=0);
 altered.rows[0][name]='changed during digest';
 const {content,digest}=chunk;
 const pending=importChunk(target.storage,'p',chunk);
 chunk.content=JSON.stringify(altered);
 await pending;
 assert.equal(target.db.prepare('SELECT name FROM projects').get().name,'original');
 assert.equal(chunkImportStatus(target.storage,'p').chain,digest);
 const before=chunkImportStatus(target.storage,'p'), replay={content,digest};
 const pendingReplay=importChunk(target.storage,'p',replay);
 replay.digest='0'.repeat(64);
 await pendingReplay;
 assert.deepEqual(chunkImportStatus(target.storage,'p'),before);
 assert.equal(target.db.prepare('SELECT name FROM projects').get().name,'original');
 console.log('Native importer snapshots mutable envelope before hashing');
} finally { source.db.close(); target.db.close(); }
