// Local authority-only test. Does not invoke archive, registry, recovery,
// Woven, live KMS, or any prior combined integration.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

const root=await mkdtemp(path.join(tmpdir(),'mapi-synthetic-authority-'));
const source=await readFile('worker/synthetic-archive-authority.js','utf8');
const sha = text => createHash('sha256').update(text).digest('hex');
const objectName = archiveId => `mapi-synthetic-authority-v1/${archiveId}`;
const sealJob='1'.repeat(32), verifyJob='2'.repeat(32), otherJob='3'.repeat(32);
const ids={archiveId:'a'.repeat(32),sealingIdentityDigest:'b'.repeat(64),verificationIdentityDigest:'c'.repeat(64),basePolicyDigest:'d'.repeat(64),sealingJobId:sealJob};
const verifierPolicy=(config,job) => sha(JSON.stringify(['mapi-synthetic-verifier-policy-v1',config.basePolicyDigest,job,config.verificationIdentityDigest]));
const sealing=(jobId,revision,parentDigest,terminal,nonce,identity=ids.sealingIdentityDigest) => ({version:1,jobId,identityDigest:identity,revision,parentDigest,terminal,role:`sealing-${jobId}-${nonce.repeat(32)}`,digest:'d'.repeat(64),recordDigest:'e'.repeat(64)});
const verification=(jobId,revision,parentDigest,terminal,nonce,sealingHeadDigest,identity=ids.verificationIdentityDigest) => ({version:2,jobId,identityDigest:identity,sealDigest:'f'.repeat(64),revision,parentDigest,terminal,role:`verify-${jobId}-${nonce.repeat(32)}`,digest:'4'.repeat(64),recordDigest:'5'.repeat(64),sealingHeadDigest});
function runtime(mode='authority') {
  const fixtureClass=mode==='authority' ? `import { SyntheticArchiveAuthority } from './authority.mjs';
      export class AuthorityFixture extends SyntheticArchiveAuthority {
        async inject(statement, ...args) { this.ctx.storage.sql.exec(statement, ...args); }
        async sideEffects() { return this.ctx.storage.sql.exec('SELECT COUNT(*) AS n FROM side_effects').one().n; }
        async evict() { await this.ctx.storage.sync(); this.ctx.abort('test-only eviction'); }
        async errorDetails(method, ...args) {
          try { await this[method](...args); return null; }
          catch (error) { return {message:String(error?.message??error), stack:String(error?.stack??''), hasCause:'cause' in error}; }
        }
      }` : `import { DurableObject } from 'cloudflare:workers';
      export class AuthorityFixture extends DurableObject {
        async seedOld() {
          this.ctx.storage.sql.exec('CREATE TABLE authority_config (singleton INTEGER PRIMARY KEY CHECK(singleton=1), archive_id TEXT NOT NULL, seal_identity TEXT NOT NULL, verify_identity TEXT NOT NULL)');
          this.ctx.storage.sql.exec("INSERT INTO authority_config VALUES (1,'old-archive','old-seal','old-verify')");
          this.ctx.storage.sql.exec("CREATE TABLE authority_jobs (job_id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('sealing','verification')), head TEXT NOT NULL)");
          this.ctx.storage.sql.exec("CREATE UNIQUE INDEX authority_single_sealing ON authority_jobs(kind) WHERE kind='sealing'");
          this.ctx.storage.sql.exec("INSERT INTO authority_jobs VALUES ('old-job','sealing','old-head')");
          return this.inspect();
        }
        async seedUnrelated() {
          this.ctx.storage.sql.exec('CREATE TABLE unrelated (value TEXT)');
          this.ctx.storage.sql.exec("INSERT INTO unrelated VALUES ('preserve')");
          return this.inspect();
        }
        async seedResidual() {
          this.ctx.storage.sql.exec('CREATE TABLE temp_owner (id INTEGER PRIMARY KEY AUTOINCREMENT)');
          this.ctx.storage.sql.exec('INSERT INTO temp_owner DEFAULT VALUES');
          this.ctx.storage.sql.exec('DROP TABLE temp_owner');
          return this.inspect();
        }
        async inspect() {
          const schema=this.ctx.storage.sql.exec('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name').toArray();
          const tables=new Set(schema.filter(x=>x.type==='table').map(x=>x.name));
          return {schema,config:tables.has('authority_config')?this.ctx.storage.sql.exec('SELECT * FROM authority_config').toArray():null,
            jobs:tables.has('authority_jobs')?this.ctx.storage.sql.exec('SELECT * FROM authority_jobs ORDER BY job_id').toArray():null,
            unrelated:tables.has('unrelated')?this.ctx.storage.sql.exec('SELECT * FROM unrelated').toArray():null,
            sequences:tables.has('sqlite_sequence')?this.ctx.storage.sql.exec('SELECT * FROM sqlite_sequence').toArray():null};
        }
      }`;
  const options=convertV4MiniflareOptions({workers:[{name:'synthetic-archive-authority-test',compatibilityDate:'2026-11-19',modules:[
    {type:'ESModule',path:'main.mjs',contents:`${fixtureClass}
      export default { async fetch(request,env) {
        try {
          const {archiveId,method,args}=await request.json();
          if (!['initialize','registerVerification','assertPolicy','read','create','compareAndSwap','inject','sideEffects','evict','errorDetails','seedOld','seedUnrelated','seedResidual','inspect'].includes(method)) return new Response(null,{status:404});
          const stub=env.ARCHIVE_AUTH.get(env.ARCHIVE_AUTH.idFromName('mapi-synthetic-authority-v1/'+archiveId));
          return Response.json({value:await stub[method](...args)});
        } catch (error) { return Response.json({error:String(error?.message??error).slice(0,200)}, {status:400}); }
      } };`},
    {type:'ESModule',path:'authority.mjs',contents:source}],durableObjects:{ARCHIVE_AUTH:{className:'AuthorityFixture',useSQLite:true}}}],host:'127.0.0.1',port:0,telemetry:{enabled:false}});
  options.resourcePersistencePath=root;
  return new Miniflare(options);
}

let mf=runtime('seed');
function fixture(archiveId) {
  const call=async (method,...args)=>{
    const response=await mf.dispatchFetch('http://synthetic-authority.local/',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({archiveId,method,args})});
    const result=await response.json();
    if (!response.ok) throw Error(result.error);
    return result.value;
  };
  return Object.fromEntries(['initialize','registerVerification','assertPolicy','read','create','compareAndSwap','inject','sideEffects','evict','errorDetails','seedOld','seedUnrelated','seedResidual','inspect'].map(method=>[method,(...args)=>call(method,...args)]));
}
try {
  // Prepare three disposable objects with the old schema, unrelated user
  // data, or a residual internal sequence after dropping a low-ID table.
  const oldId='a1'.repeat(16), unrelatedId='a2'.repeat(16), residualId='a3'.repeat(16);
  const oldBefore=await fixture(oldId).seedOld(), unrelatedBefore=await fixture(unrelatedId).seedUnrelated(), residualBefore=await fixture(residualId).seedResidual();
  await mf.dispose(); mf=runtime();
  await assert.rejects(()=>fixture(oldId).read(sealJob));
  await assert.rejects(()=>fixture(unrelatedId).read(sealJob));
  await assert.rejects(()=>fixture(residualId).read(sealJob));
  await mf.dispose(); mf=runtime('inspect');
  assert.deepEqual(await fixture(oldId).inspect(),oldBefore);
  assert.deepEqual(await fixture(unrelatedId).inspect(),unrelatedBefore);
  assert.deepEqual(await fixture(residualId).inspect(),residualBefore);
  await mf.dispose(); mf=runtime();
  let stub=fixture(ids.archiveId);
  const wrong=fixture('0'.repeat(32));
  await assert.rejects(()=>wrong.initialize(ids));
  await assert.rejects(()=>stub.initialize({...ids,archiveId:ids.archiveId+'\n'}));
  await assert.rejects(()=>stub.initialize({...ids,sealingIdentityDigest:ids.sealingIdentityDigest+'\n'}));
  assert.deepEqual(await stub.initialize(ids),{initialized:true});
  assert.deepEqual(await stub.initialize(ids),{initialized:true});
  await assert.rejects(()=>stub.initialize({...ids,verificationIdentityDigest:'9'.repeat(64)}));
  await assert.rejects(()=>stub.initialize({...ids,sealingJobId:otherJob}));
  await assert.rejects(()=>stub.initialize({...ids,basePolicyDigest:'0'.repeat(64)}));
  assert.deepEqual(await stub.assertPolicy(sealJob,ids.basePolicyDigest,null),{allowed:true});
  await assert.rejects(()=>stub.assertPolicy(sealJob,'0'.repeat(64),null));
  await assert.rejects(()=>stub.read(verifyJob));
  await assert.rejects(()=>stub.registerVerification(verifyJob,'0'.repeat(64)));
  assert.deepEqual(await stub.registerVerification(verifyJob,verifierPolicy(ids,verifyJob)),{registered:true});
  assert.deepEqual(await stub.registerVerification(verifyJob,verifierPolicy(ids,verifyJob)),{registered:true});
  await assert.rejects(()=>stub.registerVerification(sealJob,verifierPolicy(ids,sealJob)));
  await assert.rejects(()=>stub.assertPolicy(verifyJob,ids.basePolicyDigest,'0'.repeat(64)));
  assert.equal(await stub.read(sealJob),null);
  await assert.rejects(()=>stub.read(sealJob+'\n'));
  const seal0=sealing(sealJob,0,'',false,'1');
  await assert.rejects(()=>stub.create(sealJob,{...seal0,identityDigest:'9'.repeat(64)}));
  await assert.rejects(()=>stub.create(sealJob,{...seal0,role:[seal0.role]}));
  await assert.rejects(()=>stub.create(sealJob,{...seal0,role:{value:seal0.role}}));
  await assert.rejects(()=>stub.create(sealJob+'\n',{...seal0,jobId:sealJob+'\n'}));
  await assert.rejects(()=>stub.create(sealJob,{...seal0,role:seal0.role+'\n'}));
  await assert.rejects(()=>stub.create(sealJob,{...seal0,digest:seal0.digest+'\n'}));
  assert.equal(await stub.read(sealJob),null);
  const unsealed=verification(verifyJob,0,'',false,'1','0'.repeat(64));
  await assert.rejects(()=>stub.create(verifyJob,unsealed));
  await assert.rejects(()=>stub.read(otherJob));
  assert.deepEqual(await stub.create(sealJob,seal0),{created:true});
  await assert.rejects(()=>stub.create(otherJob,sealing(otherJob,0,'',false,'1')));
  await assert.rejects(()=>stub.create(sealJob,seal0));
  await assert.rejects(()=>stub.create(sealJob,{...seal0,unexpected:'x'}));
  const badInitial=sealing(otherJob,1,'0'.repeat(64),false,'1');
  await assert.rejects(()=>stub.create(otherJob,badInitial));
  const sealA=sealing(sealJob,1,sha(JSON.stringify(seal0)),false,'2'), sealB=sealing(sealJob,1,sha(JSON.stringify(seal0)),false,'3');
  await assert.rejects(()=>stub.compareAndSwap(sealJob,seal0,{...sealA,role:[sealA.role]}));
  await assert.rejects(()=>stub.compareAndSwap(sealJob,seal0,{...sealA,role:{value:sealA.role}}));
  await assert.rejects(()=>stub.compareAndSwap(sealJob,seal0,{...sealA,role:sealA.role+'\n'}));
  await assert.rejects(()=>stub.compareAndSwap(sealJob,seal0,{...sealA,parentDigest:sealA.parentDigest+'\n'}));
  assert.deepEqual(await stub.read(sealJob),seal0);
  const racing=await Promise.allSettled([stub.compareAndSwap(sealJob,seal0,sealA),stub.compareAndSwap(sealJob,seal0,sealB)]);
  assert.equal(racing.filter(x=>x.status==='fulfilled').length,1);
  assert.equal(racing.filter(x=>x.status==='rejected').length,1);
  const current=await stub.read(sealJob);
  assert([JSON.stringify(sealA),JSON.stringify(sealB)].includes(JSON.stringify(current)));
  await assert.rejects(()=>stub.compareAndSwap(sealJob,seal0,sealA));
  await assert.rejects(()=>stub.compareAndSwap(sealJob,current,sealing(sealJob,2,'0'.repeat(64),false,'4')));
  const terminal=sealing(sealJob,2,sha(JSON.stringify(current)),true,'4');
  // Model an acknowledgement lost only after the real transaction commits.
  await assert.rejects(async()=>{await stub.compareAndSwap(sealJob,current,terminal);throw Error('injected lost acknowledgement');});
  assert.deepEqual(await stub.read(sealJob),terminal);
  await assert.rejects(()=>stub.compareAndSwap(sealJob,terminal,sealing(sealJob,3,sha(JSON.stringify(terminal)),false,'5')));
  const terminalDigest=sha(JSON.stringify(terminal));
  await assert.rejects(()=>stub.create(verifyJob,verification(verifyJob,0,'',false,'1','0'.repeat(64))));
  const verify0=verification(verifyJob,0,'',false,'1',terminalDigest);
  assert.deepEqual(await stub.create(verifyJob,verify0),{created:true});
  const verify1=verification(verifyJob,1,sha(JSON.stringify(verify0)),false,'2',terminalDigest);
  await assert.rejects(()=>stub.compareAndSwap(verifyJob,verify0,{...verify1,sealDigest:'0'.repeat(64)}));
  await assert.rejects(()=>stub.compareAndSwap(verifyJob,verify0,{...verify1,sealingHeadDigest:'0'.repeat(64)}));
  assert.deepEqual(await stub.compareAndSwap(verifyJob,verify0,verify1),{updated:true});
  const verifyDone=verification(verifyJob,2,sha(JSON.stringify(verify1)),true,'3',terminalDigest);
  assert.deepEqual(await stub.compareAndSwap(verifyJob,verify1,verifyDone),{updated:true});
  await assert.rejects(()=>stub.compareAndSwap(verifyJob,verifyDone,verification(verifyJob,3,sha(JSON.stringify(verifyDone)),false,'4',terminalDigest)));
  // A separately registered later verifier can rescan without changing the
  // terminal first verifier. Conflicting registration must not win.
  const registrations=await Promise.allSettled([stub.registerVerification(otherJob,verifierPolicy(ids,otherJob)),stub.registerVerification(otherJob,'0'.repeat(64))]);
  assert.equal(registrations.filter(x=>x.status==='fulfilled').length,1);
  const identicalJob='5'.repeat(32), identicalPolicy=verifierPolicy(ids,identicalJob);
  const identical=await Promise.all([stub.registerVerification(identicalJob,identicalPolicy),stub.registerVerification(identicalJob,identicalPolicy)]);
  assert.deepEqual(identical,[{registered:true},{registered:true}]);
  const later=verification(otherJob,0,'',false,'7',terminalDigest);
  assert.deepEqual(await stub.create(otherJob,later),{created:true});
  assert.deepEqual(await stub.read(verifyJob),verifyDone);
  const secondIds={archiveId:'6'.repeat(32),sealingIdentityDigest:'7'.repeat(64),verificationIdentityDigest:'8'.repeat(64),basePolicyDigest:'9'.repeat(64),sealingJobId:sealJob};
  let second=fixture(secondIds.archiveId);
  await second.initialize(secondIds);
  const secondHead=sealing(sealJob,0,'',false,'6',secondIds.sealingIdentityDigest);
  await second.create(sealJob,secondHead);
  assert.deepEqual(await second.read(sealJob),secondHead);
  assert.deepEqual(await stub.read(sealJob),terminal);
  await assert.rejects(()=>second.compareAndSwap(sealJob,seal0,sealA));
  const raceIds={archiveId:'d'.repeat(32),sealingIdentityDigest:'e'.repeat(64),verificationIdentityDigest:'f'.repeat(64),basePolicyDigest:'9'.repeat(64),sealingJobId:'a'.repeat(32)};
  const race=fixture(raceIds.archiveId);
  const initRace=await Promise.allSettled([race.initialize(raceIds),race.initialize({...raceIds,sealingIdentityDigest:'0'.repeat(64)})]);
  assert.equal(initRace.filter(x=>x.status==='fulfilled').length,1);
  const chosen=initRace[0].status==='fulfilled'?raceIds:{...raceIds,sealingIdentityDigest:'0'.repeat(64)};
  await race.initialize(chosen);
  const contenders=[sealing(chosen.sealingJobId,0,'',false,'a',chosen.sealingIdentityDigest),sealing(chosen.sealingJobId,0,'',false,'b',chosen.sealingIdentityDigest)];
  const createRace=await Promise.allSettled(contenders.map(h=>race.create(h.jobId,h)));
  assert.equal(createRace.filter(x=>x.status==='fulfilled').length,1);
  assert.equal(createRace.filter(x=>x.status==='rejected').length,1);
  // Test-only SQL fault injection into a disposable object. These controls are
  // not part of the unmounted authority class or a deployed entry point.
  const faultIds={archiveId:'9'.repeat(32),sealingIdentityDigest:'a'.repeat(64),verificationIdentityDigest:'b'.repeat(64),basePolicyDigest:'c'.repeat(64),sealingJobId:otherJob};
  const fault=fixture(faultIds.archiveId);
  await fault.inject('CREATE TRIGGER ignore_config BEFORE INSERT ON authority_config BEGIN SELECT RAISE(IGNORE); END');
  await assert.rejects(()=>fault.initialize(faultIds));
  await fault.inject('DROP TRIGGER ignore_config');
  await fault.initialize(faultIds);
  const faultHead=sealing(otherJob,0,'',false,'7',faultIds.sealingIdentityDigest);
  // SQLite records the spelling used in ON, and resolves table identifiers
  // case-insensitively. A case-sensitive catalog filter misses this trigger.
  await fault.inject('CREATE TABLE side_effects (value INTEGER)');
  await fault.inject('CREATE TRIGGER uppercase_side_effect AFTER INSERT ON AUTHORITY_JOBS BEGIN INSERT INTO side_effects VALUES (1); END');
  await assert.rejects(()=>fault.create(otherJob,faultHead));
  assert.equal(await fault.sideEffects(),0);
  await fault.inject('DROP TRIGGER uppercase_side_effect');
  assert.equal(await fault.read(otherJob),null);
  await fault.inject('CREATE TRIGGER ignore_insert BEFORE INSERT ON authority_jobs BEGIN SELECT RAISE(IGNORE); END');
  await assert.rejects(()=>fault.create(otherJob,faultHead));
  await fault.inject('DROP TRIGGER ignore_insert');
  assert.equal(await fault.read(otherJob),null);
  await fault.inject("CREATE TRIGGER sqliteXautoindexYevil BEFORE INSERT ON authority_jobs BEGIN SELECT RAISE(IGNORE); END");
  await assert.rejects(()=>fault.create(otherJob,faultHead));
  await fault.inject('DROP TRIGGER sqliteXautoindexYevil');
  assert.equal(await fault.read(otherJob),null);
  await fault.inject("CREATE TRIGGER mutate_insert AFTER INSERT ON authority_jobs BEGIN UPDATE authority_jobs SET head='{}' WHERE job_id=NEW.job_id; END");
  await assert.rejects(()=>fault.create(otherJob,faultHead));
  await fault.inject('DROP TRIGGER mutate_insert');
  assert.equal(await fault.read(otherJob),null);
  await fault.create(otherJob,faultHead);
  const faultNext=sealing(otherJob,1,sha(JSON.stringify(faultHead)),false,'8',faultIds.sealingIdentityDigest);
  await fault.inject("CREATE TRIGGER mutate_update AFTER UPDATE ON authority_jobs BEGIN UPDATE authority_jobs SET head='{}' WHERE job_id=NEW.job_id; END");
  await assert.rejects(()=>fault.compareAndSwap(otherJob,faultHead,faultNext));
  await fault.inject('DROP TRIGGER mutate_update');
  assert.deepEqual(await fault.read(otherJob),faultHead);
  await fault.inject('UPDATE authority_jobs SET head=? WHERE job_id=?','x'.repeat(4096),otherJob);
  await assert.rejects(()=>fault.read(otherJob));
  // Parser diagnostics can echo a corrupt stored value; do not disclose it
  // through the authority RPC or its error stack.
  const marker='synthetic-private-head';
  await fault.inject('UPDATE authority_jobs SET head=? WHERE job_id=?',marker,otherJob);
  await assert.rejects(()=>fault.read(otherJob),error=>{
    assert.match(error.message,/Invalid authority job/);
    assert.equal(String(error.stack).includes(marker),false);
    return true;
  });
  const readError=await fault.errorDetails('read',otherJob);
  assert.equal(readError.message,'Invalid authority job');
  assert.equal(readError.hasCause,false);
  assert.equal(readError.stack.includes(marker),false);
  await assert.rejects(()=>fault.compareAndSwap(otherJob,faultHead,faultNext));
  await fault.inject('UPDATE authority_jobs SET head=? WHERE job_id=?',JSON.stringify(faultHead),otherJob);
  await fault.inject('UPDATE authority_config SET archive_id=? WHERE singleton=1','e'.repeat(32));
  await assert.rejects(()=>fault.read(otherJob));
  await assert.rejects(()=>fault.compareAndSwap(otherJob,faultHead,faultNext));
  await fault.inject('UPDATE authority_config SET archive_id=? WHERE singleton=1',faultIds.archiveId);
  await fault.inject('UPDATE authority_config SET seal_identity=? WHERE singleton=1','x'.repeat(4096));
  await assert.rejects(()=>fault.read(otherJob));
  await fault.inject('UPDATE authority_config SET seal_identity=? WHERE singleton=1',faultIds.sealingIdentityDigest);
  assert.deepEqual(await fault.read(otherJob),faultHead);
  const faultFinal=sealing(otherJob,1,sha(JSON.stringify(faultHead)),true,'8',faultIds.sealingIdentityDigest);
  await fault.compareAndSwap(otherJob,faultHead,faultFinal);
  const forged=sealing(otherJob,1,sha(JSON.stringify(faultHead)),true,'8','f'.repeat(64));
  await fault.inject('UPDATE authority_jobs SET head=? WHERE job_id=?',JSON.stringify(forged),otherJob);
  const faultVerify=verification('c'.repeat(32),0,'',false,'9',sha(JSON.stringify(forged)),faultIds.verificationIdentityDigest);
  await fault.registerVerification(faultVerify.jobId,verifierPolicy(faultIds,faultVerify.jobId));
  await assert.rejects(()=>fault.create(faultVerify.jobId,faultVerify));
  await fault.inject('UPDATE authority_jobs SET head=? WHERE job_id=?',marker,otherJob);
  await assert.rejects(()=>fault.create(faultVerify.jobId,{...faultVerify,sealingHeadDigest:sha(marker)}),error=>{
    assert.match(error.message,/Invalid stored sealing head/);
    assert.equal(String(error.stack).includes(marker),false);
    return true;
  });
  const sealingError=await fault.errorDetails('create',faultVerify.jobId,{...faultVerify,sealingHeadDigest:sha(marker)});
  assert.equal(sealingError.message,'Invalid stored sealing head');
  assert.equal(sealingError.hasCause,false);
  assert.equal(sealingError.stack.includes(marker),false);
  await fault.inject('UPDATE authority_jobs SET head=? WHERE job_id=?',JSON.stringify(faultFinal),otherJob);
  assert.equal(await fault.read(faultVerify.jobId),null);
  // A valid-shaped but incorrect stored registration must fail even for
  // direct authority calls, not just the gateway's policy check.
  await fault.inject('UPDATE authority_verifiers SET policy_digest=? WHERE job_id=?','0'.repeat(64),faultVerify.jobId);
  await assert.rejects(()=>fault.read(faultVerify.jobId));
  await assert.rejects(()=>fault.create(faultVerify.jobId,{...faultVerify,sealingHeadDigest:sha(JSON.stringify(faultFinal))}));
  await fault.inject('UPDATE authority_verifiers SET policy_digest=? WHERE job_id=?',verifierPolicy(faultIds,faultVerify.jobId),faultVerify.jobId);
  assert.equal(await fault.read(faultVerify.jobId),null);
  const wrongSealJob='d'.repeat(32), wrongStored=sealing(wrongSealJob,1,'1'.repeat(64),true,'9',faultIds.sealingIdentityDigest);
  await fault.inject('UPDATE authority_jobs SET job_id=?,head=? WHERE job_id=?',wrongSealJob,JSON.stringify(wrongStored),otherJob);
  await assert.rejects(()=>fault.create(faultVerify.jobId,{...faultVerify,sealingHeadDigest:sha(JSON.stringify(wrongStored))}));
  await fault.inject('UPDATE authority_jobs SET job_id=?,head=? WHERE job_id=?',otherJob,JSON.stringify(faultFinal),wrongSealJob);
  await assert.rejects(()=>second.evict());
  second=fixture(secondIds.archiveId);
  assert.deepEqual(await second.read(sealJob),secondHead);
  await mf.dispose(); mf=runtime(); stub=fixture(ids.archiveId);
  assert.deepEqual(await stub.initialize(ids),{initialized:true});
  assert.deepEqual(await stub.read(sealJob),terminal);
  assert.deepEqual(await stub.read(verifyJob),verifyDone);
  second=fixture(secondIds.archiveId);
  assert.deepEqual(await second.read(sealJob),secondHead);
  await assert.rejects(()=>stub.compareAndSwap(verifyJob,verifyDone,verification(verifyJob,3,sha(JSON.stringify(verifyDone)),false,'4',terminalDigest)));
  console.log('Synthetic archive authority: transactional CAS, unique seal, terminal heads, isolation, lost acknowledgement and restart passed');
} finally { await mf.dispose(); await rm(root,{recursive:true,force:true}); }
