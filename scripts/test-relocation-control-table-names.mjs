// Small native SQLite test of control-table name admission only; no real
// owner, move, complete history, or deferred size/sequence cases.
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { initializeProjectFence, freezeProject } from '../worker/relocation.js';
import { beginChunkExport, beginChunkImport } from '../worker/relocation-chunks.js';

function fixture(source) {
  const db=new DatabaseSync(':memory:');
  db.exec('CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL)');
  const storage={ transactionSync(fn) { db.exec('BEGIN'); try { const value=fn(); db.exec('COMMIT'); return value; } catch(e) { db.exec('ROLLBACK'); throw e; } },
    sql:{ exec(sql,...args) { const stmt=db.prepare(sql); const result=stmt.columns().length?stmt.all(...args):(stmt.run(...args),[]); return {toArray:()=>result,one:()=>result[0]}; } } };
  if(source) { initializeProjectFence(storage,'p','source'); freezeProject(storage,'p',1,'move'); }
  return { db,storage };
}
for(const source of [true,false]) {
  const {db,storage}=fixture(source);
  try {
    const begin=tables=>source?beginChunkExport(storage,'p',1,'move',tables):beginChunkImport(storage,'p',1,'move','destination',tables);
    assert.throws(()=>begin(['MAPI_CHUNK_EXPORT']),/Invalid chunk table list/);
    assert.throws(()=>begin(['MaPi_Relocation_Project']),/Invalid chunk table list/);
    assert.throws(()=>begin(['projects','PROJECTS']),/Invalid chunk table list/);
    begin(['projects']);
  } finally {db.close();}
}
console.log('Native relocation control and duplicate table name checks passed');
