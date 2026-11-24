// Synthetic authority class with native SQLite and a test Durable Object base.
// No archive, registry, hosted service, AWS, or production owner is used.
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const db=new DatabaseSync(':memory:');
const sql={exec(query,...args) {
  const s=db.prepare(query), values=s.columns().length?s.all(...args):(s.run(...args),[]);
  return {toArray:()=>values,one:()=>values[0]};
}};
const storage={sql,transactionSync(fn){db.exec('BEGIN');try{const v=fn();db.exec('COMMIT');return v;}catch(e){db.exec('ROLLBACK');throw e;}}};
const context=vm.createContext({crypto,TextEncoder,Uint8Array,console});
const module=new vm.SourceTextModule(await readFile('worker/synthetic-archive-authority.js','utf8'),{context});
await module.link(specifier=>{
  assert.equal(specifier,'cloudflare:workers');
  return new vm.SyntheticModule(['DurableObject'],function(){this.setExport('DurableObject',class {constructor(ctx,env){this.ctx=ctx;this.env=env;}});},{context});
});
await module.evaluate();
const archiveId='a'.repeat(32), job='1'.repeat(32);
const owner=new module.namespace.SyntheticArchiveAuthority({storage,id:{toString:()=>archiveId}},
  {ARCHIVE_AUTH:{idFromName:()=>({toString:()=>archiveId})}});
try {
  await owner.initialize({archiveId,basePolicyDigest:'d'.repeat(64),sealingIdentityDigest:'b'.repeat(64),verificationIdentityDigest:'c'.repeat(64),sealingJobId:job});
  db.exec('CREATE TABLE side_effects(value INTEGER)');
  db.exec('CREATE TEMP TRIGGER fault AFTER INSERT ON main.AUTHORITY_JOBS BEGIN INSERT INTO side_effects VALUES (1); END');
  const head={version:1,jobId:job,identityDigest:'b'.repeat(64),revision:0,parentDigest:'',terminal:false,role:`sealing-${job}-${'e'.repeat(32)}`,digest:'f'.repeat(64),recordDigest:'9'.repeat(64)};
  await assert.rejects(owner.create(job,head),/Authority schema differs/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM side_effects').get().n,0);
  db.exec('DROP TRIGGER temp.fault');
  db.exec('CREATE TEMP TABLE AUTHORITY_JOBS(job_id TEXT,kind TEXT,head TEXT)');
  await assert.rejects(owner.read(job),/Authority schema differs/);
  db.exec('DROP TABLE temp.AUTHORITY_JOBS');
  await owner.create(job,head);
  assert.deepEqual(JSON.parse(JSON.stringify(await owner.read(job))),head);
  console.log('Synthetic authority TEMP trigger and shadow native checks passed');
} finally { db.close(); }
