import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, link, unlink, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { mintSyntheticArchiveKey } from '../worker/synthetic-archive-key-provider.js';
import { archiveSyntheticChunk, sealSyntheticArchive, verifySyntheticArchive, restoreSyntheticArchive, beginSyntheticVerification, advanceSyntheticVerification } from '../worker/synthetic-relocation-archive.js';

const KEY='arn:aws:kms:us-east-1:646535719915:key/7614cff5-444e-4615-a785-4192dd150c2f';
const RUN='mapi-p1-syn-20261123T074636Z-bef5970113984cf34aa5c70e9d0a2c9a';
const encoder=new TextEncoder();
const sha=async s => [...new Uint8Array(await crypto.subtle.digest('SHA-256',encoder.encode(s)))].map(v=>v.toString(16).padStart(2,'0')).join('');
const signal=()=>new AbortController().signal;
const root=await mkdtemp(path.join(tmpdir(),'mapi-archive-test-'));
class Bucket {
  lostNonceAck=false;
  lostSelectorAck=false;
  failAttemptOnce=false;
  reads=[];
  path(k) { if (!/^[a-zA-Z0-9/_.-]+$/.test(k) || k.includes('..')) throw Error('invalid test key'); return path.join(root,k); }
  async put(k,v,opts) {
    assert.equal(opts.onlyIf.get('If-None-Match'),'*');
    if (this.failAttemptOnce && k.includes('/attempt/')) { this.failAttemptOnce=false; throw Error('injected failure'); }
    const dest=this.path(k), temp=dest+'.'+crypto.randomUUID()+'.tmp'; await mkdir(path.dirname(dest),{recursive:true});
    await writeFile(temp,v,{flag:'wx'});
    try { await link(temp,dest); } catch(e) { if(e.code==='EEXIST') return null; throw e; } finally { await unlink(temp); }
    if (this.lostNonceAck && k.includes('/nonce/')) { this.lostNonceAck=false; throw Error('injected lost acknowledgement'); }
    if (this.lostSelectorAck && k.includes('-selector/')) { this.lostSelectorAck=false; throw Error('injected lost selector acknowledgement'); }
    return {key:k};
  }
  async list(options) {
    const dir=this.path(options.prefix); let names; try { names=await readdir(dir); } catch(e) { if(e.code==='ENOENT') names=[]; else throw e; }
    const items=names.sort().map(name=>({key:options.prefix+name}));
    const offset=options.cursor ? Number(options.cursor) : 0, page=items.slice(offset,offset+options.limit);
    return {objects:page,truncated:offset+page.length<items.length,...(offset+page.length<items.length?{cursor:String(offset+page.length)}:{})};
  }
  async get(k) {
    this.reads.push(k);
    let data; try { data=await readFile(this.path(k)); } catch(e) { if(e.code==='ENOENT') return null; throw e; }
    return {size:data.length,body:new ReadableStream({start(c){c.enqueue(new Uint8Array(data));c.close();}})};
  }
}
class KMS {
  keys=new Map();
  async generateDataKey(r) {
    assert.equal(r.KeyId,KEY); const key=crypto.getRandomValues(new Uint8Array(32)), wrapped=crypto.getRandomValues(new Uint8Array(32));
    this.keys.set(wrapped.toBase64(),new Uint8Array(key)); return {KeyId:KEY,Plaintext:key,CiphertextBlob:wrapped};
  }
  async decrypt(r) { const key=this.keys.get(r.CiphertextBlob.toBase64()); if(!key) throw Error('wrong key'); return {KeyId:KEY,Plaintext:new Uint8Array(key)}; }
}
try {
  const source=new DatabaseSync(':memory:');
  source.exec("CREATE TABLE users(id TEXT PRIMARY KEY, name TEXT); CREATE TABLE events(id INTEGER PRIMARY KEY, payload TEXT); INSERT INTO users VALUES('u1','secret-synthetic-user'),('u2','other user'); INSERT INTO events VALUES(1,'synthetic-audit-a'),(2,'synthetic-audit-b')");
  const tables=['users','events'], manifest=JSON.stringify({projectId:'p',origin:'https://p.example',objectName:'source',generation:1,moveId:'move',tables});
  const scope={keyArn:KEY,runId:RUN,archiveId:'9'.repeat(32),manifestDigest:await sha(manifest)};
  const chunks=[]; let previous='';
  for(const [i,t] of tables.entries()) {
    const rows=source.prepare(`SELECT * FROM ${t} ORDER BY id`).all().map(r=>Object.values(r));
    const content=JSON.stringify({projectId:'p',generation:1,moveId:'move',index:i,prev:previous,table:t,columns:Object.keys(source.prepare(`SELECT * FROM ${t} LIMIT 1`).get()),offset:0,rows,last:true,done:i===tables.length-1,cursor:null});
    previous=await sha(content); chunks.push(content);
  }
  const commitment={projectId:'p',origin:'https://p.example',objectName:'source',generation:1,moveId:'move',manifestDigest:scope.manifestDigest,tables,chunkCount:chunks.length,finalDigest:previous};
  const kms=new KMS(); let bucket=new Bucket();
  const {provisionalEnvelopeDigest:envelope}=await mintSyntheticArchiveKey(bucket,kms,scope,signal());
  const write=(i,content=chunks[i])=>archiveSyntheticChunk(bucket,kms,scope,commitment,envelope,i,content,signal());
  await assert.rejects(()=>write(1));
  bucket.lostNonceAck=true; bucket.failAttemptOnce=true;
  await assert.rejects(()=>write(0));
  bucket=new Bucket(); // restart with the same durable store and independently held KMS
  await Promise.all([write(0),write(0)]);
  const nonces=await readdir(path.join(root,`mapi-p1-synthetic-archive-v1/${RUN}/${scope.archiveId}/nonce`));
  assert(nonces.length>=3); assert.equal(new Set(nonces).size,nonces.length);
  const modified=JSON.parse(chunks[0]); modified.rows[0][1]='different';
  await assert.rejects(()=>write(0,JSON.stringify(modified)));
  await assert.rejects(()=>sealSyntheticArchive(bucket,kms,scope,commitment,envelope,signal()));
  bucket.lostSelectorAck=true; await write(1); await sealSyntheticArchive(bucket,kms,scope,commitment,envelope,signal());
  const verified=await verifySyntheticArchive(bucket,kms,scope,commitment,envelope,signal());
  assert.equal(verified.finalDigest,previous); assert.equal(verified.chunkCount,2);
  await assert.rejects(()=>verifySyntheticArchive(bucket,new KMS(),scope,commitment,envelope,signal()));
  await assert.rejects(()=>verifySyntheticArchive(bucket,kms,scope,{...commitment,projectId:'wrong'},envelope,signal()));
  await assert.rejects(()=>verifySyntheticArchive(bucket,kms,scope,{...commitment,projectId:'bad\ud800'},envelope,signal()));
  await assert.rejects(()=>verifySyntheticArchive(bucket,kms,scope,{...commitment,finalDigest:'0'.repeat(64)},envelope,signal()));
  // Synthetic independent-head stand-in only: real authority nonrollback,
  // authentication, writer isolation and durable custody remain unproven.
  class Authority {
    jobs=new Map(); lost=false; failNextReread=false; failRead=false; failBeforeCas=false;
    async read(id) { if(this.failRead){this.failRead=false;throw Error('independent authority unavailable');} return structuredClone(this.jobs.get(id) ?? null); }
    async create(id,head) { assert(!this.jobs.has(id)); assert.equal(head.revision,0); assert.equal(head.parentDigest,''); this.jobs.set(id,structuredClone(head)); }
    async compareAndSwap(id,old,next) {
      assert.deepEqual(this.jobs.get(id),old); if(this.failBeforeCas){this.failBeforeCas=false;throw Error('injected before CAS');} assert.equal(next.revision,old.revision+1); assert.equal(next.parentDigest,await sha(JSON.stringify(old)));
      this.jobs.set(id,structuredClone(next)); if(this.failNextReread){this.failNextReread=false;this.failRead=true;throw Error('uncertain authority acknowledgement');} if(this.lost){this.lost=false;throw Error('lost authority acknowledgement');}
    }
  }
  const authority=new Authority(), job='7'.repeat(32);
  await assert.rejects(()=>beginSyntheticVerification(bucket,kms,scope,commitment,envelope,signal(),null,job));
  let head=await beginSyntheticVerification(bucket,kms,scope,commitment,envelope,signal(),authority,job), old=structuredClone(head);
  authority.lost=true;
  let advance=await advanceSyntheticVerification(bucket,kms,scope,commitment,envelope,signal(),authority,job,head,1); head=advance.head;
  assert.equal(head.revision,1); await assert.rejects(()=>advanceSyntheticVerification(bucket,kms,scope,commitment,envelope,signal(),authority,job,old,1));
  const savedHead=structuredClone(head); authority.jobs.set(job,old);
  await assert.rejects(()=>advanceSyntheticVerification(bucket,kms,scope,commitment,envelope,signal(),authority,job,savedHead,1)); authority.jobs.set(job,savedHead);
  await assert.rejects(()=>advanceSyntheticVerification(bucket,kms,scope,{...commitment,projectId:'foreign'},envelope,signal(),authority,job,head,1));
  const vprefix=`mapi-p1-synthetic-archive-v1/${RUN}/${scope.archiveId}`;
  const verifySelector=JSON.parse(await readFile(bucket.path(`${vprefix}/${head.role}-selector/${String(0).padStart(16,'0')}`),'utf8'));
  const verifyAttempt=bucket.path(`${vprefix}/attempt/${verifySelector[4]}`), savedAttempt=await readFile(verifyAttempt);
  const damagedCheckpoint=new Uint8Array(savedAttempt); damagedCheckpoint[damagedCheckpoint.length-3]^=1; await writeFile(verifyAttempt,damagedCheckpoint);
  await assert.rejects(()=>advanceSyntheticVerification(bucket,kms,scope,commitment,envelope,signal(),authority,job,head,1)); await writeFile(verifyAttempt,savedAttempt);
  bucket.reads=[]; authority.failNextReread=true;
  await assert.rejects(()=>advanceSyntheticVerification(bucket,kms,scope,commitment,envelope,signal(),authority,job,head,1),/outcome uncertain/);
  assert(!bucket.reads.some(k=>k.endsWith('/chunk-selector/0000000000000000')));
  const current=await authority.read(job); assert.equal(current.revision,head.revision+1); assert.equal(current.parentDigest,await sha(JSON.stringify(head)));
  await assert.rejects(()=>advanceSyntheticVerification(bucket,kms,scope,commitment,envelope,signal(),authority,job,head,1));
  // Test-only manual reconciliation: no competing writer exists in this mock.
  head=current; advance={head,complete:false};
  const realList=bucket.list.bind(bucket); let duplicate=true;
  bucket.list=async options=>{const page=await realList(options); if(duplicate && options.prefix.includes('/chunk-selector/')) {duplicate=false; return {...page,objects:[page.objects[0],page.objects[0]]};} return page;};
  await assert.rejects(()=>advanceSyntheticVerification(bucket,kms,scope,commitment,envelope,signal(),authority,job,head,1));
  duplicate=true; await assert.rejects(()=>verifySyntheticArchive(bucket,kms,scope,commitment,envelope,signal()));
  bucket.list=realList;
  for(let steps=0;steps<10 && !advance.complete;steps++){ advance=await advanceSyntheticVerification(bucket,kms,scope,commitment,envelope,signal(),authority,job,head,1); head=advance.head; }
  assert.equal(advance.complete,true); assert.equal(advance.inventoryDigest,verified.inventoryDigest);
  const completed=await advanceSyntheticVerification(bucket,kms,scope,commitment,envelope,signal(),authority,job,head,1); assert.equal(completed.complete,true);
  // Untrusted, foreign, incomplete and corrupted verifier inputs fail before
  // the destination is even initialized.
  let destinationCalls=0; const untouched={load:async()=>{destinationCalls++;return null},begin:async()=>{destinationCalls++},apply:async()=>{destinationCalls++},finish:async()=>{destinationCalls++}};
  const incompleteJob='4'.repeat(32), incompleteHead=await beginSyntheticVerification(bucket,kms,scope,commitment,envelope,signal(),authority,incompleteJob);
  const verifiedOptions={authority,jobId:job,head,maxChunks:1};
  await assert.rejects(()=>restoreSyntheticArchive(bucket,kms,scope,commitment,envelope,signal(),untouched,{authority,jobId:incompleteJob,head:incompleteHead}));
  await assert.rejects(()=>restoreSyntheticArchive(bucket,kms,scope,commitment,envelope,signal(),untouched,{authority,jobId:job,head:old}));
  await assert.rejects(()=>restoreSyntheticArchive(bucket,kms,scope,{...commitment,projectId:'foreign'},envelope,signal(),untouched,verifiedOptions));
  await assert.rejects(()=>restoreSyntheticArchive(bucket,kms,scope,commitment,envelope,signal(),untouched,{authority:null,jobId:job,head}));
  const completeSelector=JSON.parse(await readFile(bucket.path(`${vprefix}/${head.role}-selector/${String(0).padStart(16,'0')}`),'utf8'));
  const completeAttempt=bucket.path(`${vprefix}/attempt/${completeSelector[4]}`), completeBytes=await readFile(completeAttempt), changedComplete=new Uint8Array(completeBytes);
  changedComplete[changedComplete.length-3]^=1; await writeFile(completeAttempt,changedComplete);
  await assert.rejects(()=>restoreSyntheticArchive(bucket,kms,scope,commitment,envelope,signal(),untouched,verifiedOptions));
  await writeFile(completeAttempt,completeBytes); assert.equal(destinationCalls,0);
  // Cross-page listing errors must not advance the independently pinned head.
  const listJob=async id=>{
    let h=await beginSyntheticVerification(bucket,kms,scope,commitment,envelope,signal(),authority,id);
    return (await advanceSyntheticVerification(bucket,kms,scope,commitment,envelope,signal(),authority,id,h,2)).head;
  };
  const beforeList=await listJob('6'.repeat(32));
  authority.failBeforeCas=true; await assert.rejects(()=>advanceSyntheticVerification(bucket,kms,scope,commitment,envelope,signal(),authority,'6'.repeat(32),beforeList,1),/outcome uncertain/);
  assert.deepEqual(await authority.read('6'.repeat(32)),beforeList);
  const ordered=await realList({prefix:`${vprefix}/chunk-selector/`,limit:1000});
  bucket.list=async options=>({...await realList(options),objects:[],truncated:false});
  await assert.rejects(()=>advanceSyntheticVerification(bucket,kms,scope,commitment,envelope,signal(),authority,'6'.repeat(32),beforeList,1));
  assert.deepEqual(await authority.read('6'.repeat(32)),beforeList);
  bucket.list=async options=>({...await realList(options),objects:[{key:`${options.prefix}${String(2).padStart(16,'0')}`}],truncated:false});
  await assert.rejects(()=>advanceSyntheticVerification(bucket,kms,scope,commitment,envelope,signal(),authority,'6'.repeat(32),beforeList,1));
  assert.deepEqual(await authority.read('6'.repeat(32)),beforeList);
  bucket.list=async options=>options.cursor ? {objects:[ordered.objects[0]],truncated:false} : {objects:[ordered.objects[0]],truncated:true,cursor:'page-2'};
  const afterFirst=(await advanceSyntheticVerification(bucket,kms,scope,commitment,envelope,signal(),authority,'6'.repeat(32),beforeList,1)).head;
  await assert.rejects(()=>advanceSyntheticVerification(bucket,kms,scope,commitment,envelope,signal(),authority,'6'.repeat(32),afterFirst,1));
  assert.deepEqual(await authority.read('6'.repeat(32)),afterFirst);
  const loopHead=await listJob('5'.repeat(32));
  bucket.list=async options=>({objects:[],truncated:true,cursor:'same-cursor'});
  const firstLoop=(await advanceSyntheticVerification(bucket,kms,scope,commitment,envelope,signal(),authority,'5'.repeat(32),loopHead,1)).head;
  await assert.rejects(()=>advanceSyntheticVerification(bucket,kms,scope,commitment,envelope,signal(),authority,'5'.repeat(32),firstLoop,1));
  assert.deepEqual(await authority.read('5'.repeat(32)),firstLoop); bucket.list=realList;
  const reordered={recordDigest:head.recordDigest,digest:head.digest,role:head.role,parentDigest:head.parentDigest,revision:head.revision,sealDigest:head.sealDigest,identityDigest:head.identityDigest,jobId:head.jobId,version:head.version};
  await assert.rejects(()=>advanceSyntheticVerification(bucket,kms,scope,commitment,envelope,signal(),authority,job,reordered,1));
  const stagedPath=path.join(root,'staged.sqlite'); let staged=new DatabaseSync(stagedPath);
  staged.exec("CREATE TABLE users(id TEXT PRIMARY KEY,name TEXT); CREATE TABLE events(id INTEGER PRIMARY KEY,payload TEXT); CREATE TABLE import_history(idx INTEGER PRIMARY KEY,digest TEXT NOT NULL); CREATE TABLE checkpoint(singleton INTEGER PRIMARY KEY,state TEXT NOT NULL)");
  let inserted=0, crash=true;
  const target={
    async load() { const row=staged.prepare('SELECT state FROM checkpoint WHERE singleton=1').get(); return row ? JSON.parse(row.state) : null; },
    async begin(cp) {
      staged.exec('BEGIN IMMEDIATE'); try {
        assert.equal(staged.prepare('SELECT count(*) n FROM users').get().n,0); assert.equal(staged.prepare('SELECT count(*) n FROM events').get().n,0);
        staged.prepare('INSERT INTO checkpoint VALUES(1,?)').run(JSON.stringify(cp)); staged.exec('COMMIT');
      } catch(e) { staged.exec('ROLLBACK'); throw e; }
    },
    async apply({expected,next,content,index,digest}) {
      assert.equal(await sha(content),digest); staged.exec('BEGIN IMMEDIATE');
      try {
        const current=JSON.parse(staged.prepare('SELECT state FROM checkpoint WHERE singleton=1').get().state);
        assert.deepEqual(current,expected); assert.equal(index,current.next);
        const p=JSON.parse(content); assert.equal(p.index,index); assert.equal(p.projectId,'p');
        assert.deepEqual(p.columns,p.table==='users'?['id','name']:['id','payload']);
        const insert=staged.prepare(`INSERT INTO ${p.table} VALUES(?,?)`); for(const row of p.rows) { insert.run(...row); inserted++; }
        if(index===1 && crash) { crash=false; throw Error('injected interruption after row writes'); }
        staged.prepare('INSERT INTO import_history VALUES(?,?)').run(index,digest);
        staged.prepare('UPDATE checkpoint SET state=? WHERE singleton=1').run(JSON.stringify(next)); staged.exec('COMMIT');
      } catch(e) { staged.exec('ROLLBACK'); throw e; }
    },
    async finish(cp) { staged.exec('BEGIN IMMEDIATE'); try { assert.deepEqual(await this.load(),cp); staged.prepare('UPDATE checkpoint SET state=? WHERE singleton=1').run(JSON.stringify({...cp,complete:true})); staged.exec('COMMIT'); } catch(e) { staged.exec('ROLLBACK'); throw e; } }
  };
  await assert.rejects(()=>restoreSyntheticArchive(bucket,kms,scope,commitment,envelope,signal(),target));
  assert.equal((await target.load()).next,1); assert.equal(staged.prepare('SELECT count(*) n FROM events').get().n,0);
  staged.close(); staged=new DatabaseSync(stagedPath); const beforeRetry=inserted; bucket.reads=[];
  await restoreSyntheticArchive(bucket,kms,scope,commitment,envelope,signal(),target);
  assert.equal(inserted-beforeRetry,2); // committed users were not reinserted
  assert(!bucket.reads.some(k=>k.endsWith('/chunk-selector/0000000000000000'))); // no committed-row rescan
  assert.equal((await target.load()).next,2); assert.equal((await target.load()).complete,true);
  assert.deepEqual(staged.prepare('SELECT * FROM users ORDER BY id').all(),source.prepare('SELECT * FROM users ORDER BY id').all());
  assert.deepEqual(staged.prepare('SELECT * FROM events ORDER BY id').all(),source.prepare('SELECT * FROM events ORDER BY id').all());
  // Simulate authority changing while an awaited destination transaction is
  // in flight. The write may commit, but the target stays staged and the
  // driver fails until the independent authority is reconciled.
  staged.close(); staged=new DatabaseSync(path.join(root,'verified-stage.sqlite'));
  staged.exec("CREATE TABLE users(id TEXT PRIMARY KEY,name TEXT); CREATE TABLE events(id INTEGER PRIMARY KEY,payload TEXT); CREATE TABLE import_history(idx INTEGER PRIMARY KEY,digest TEXT NOT NULL); CREATE TABLE checkpoint(singleton INTEGER PRIMARY KEY,state TEXT NOT NULL)");
  crash=false; const racingTarget={...target,async apply(step){await target.apply(step); if(step.index===0) authority.jobs.set(job,old);}};
  bucket.reads=[];
  await assert.rejects(()=>restoreSyntheticArchive(bucket,kms,scope,commitment,envelope,signal(),racingTarget,verifiedOptions),/requires reconciliation/);
  const partiallyStaged=await target.load(); assert.equal(partiallyStaged.next,1); assert.equal(partiallyStaged.complete,false);
  assert.equal(partiallyStaged.verificationHeadDigest,await sha(JSON.stringify(head))); assert.equal(staged.prepare('SELECT count(*) n FROM users').get().n,2);
  await assert.rejects(()=>restoreSyntheticArchive(bucket,kms,scope,commitment,envelope,signal(),target,verifiedOptions));
  assert.equal((await target.load()).next,1); authority.jobs.set(job,structuredClone(head)); bucket.reads=[];
  const resumed=await restoreSyntheticArchive(bucket,kms,scope,commitment,envelope,signal(),target,verifiedOptions);
  assert.equal(resumed.complete,true); assert(!bucket.reads.some(k=>k.endsWith('/chunk-selector/0000000000000000')));
  assert.equal((await target.load()).complete,true); assert.equal(staged.prepare('SELECT count(*) n FROM users').get().n,2); assert.equal(staged.prepare('SELECT count(*) n FROM events').get().n,2);
  await assert.rejects(()=>restoreSyntheticArchive(bucket,kms,scope,commitment,envelope,signal(),target)); // no mode downgrade
  staged.close(); staged=new DatabaseSync(path.join(root,'bounded-stage.sqlite'));
  staged.exec("CREATE TABLE users(id TEXT PRIMARY KEY,name TEXT); CREATE TABLE events(id INTEGER PRIMARY KEY,payload TEXT); CREATE TABLE import_history(idx INTEGER PRIMARY KEY,digest TEXT NOT NULL); CREATE TABLE checkpoint(singleton INTEGER PRIMARY KEY,state TEXT NOT NULL)");
  const partial=await restoreSyntheticArchive(bucket,kms,scope,commitment,envelope,signal(),target,verifiedOptions);
  assert.deepEqual(partial,{complete:false,next:1,chunkCount:2}); assert.equal((await target.load()).complete,false);
  bucket.reads=[]; const finished=await restoreSyntheticArchive(bucket,kms,scope,commitment,envelope,signal(),target,verifiedOptions);
  assert.equal(finished.complete,true); assert(!bucket.reads.some(k=>k.endsWith('/chunk-selector/0000000000000000')));
  // A same-isolate adapter must not be able to change the driver's intended
  // checkpoint by retaining and mutating the object passed to apply().
  let maliciousCheckpoint=null, maliciousApplies=0;
  const mutatingTarget={
    async load(){return maliciousCheckpoint && structuredClone(maliciousCheckpoint);},
    async begin(cp){maliciousCheckpoint=structuredClone(cp);},
    async apply({next}){
      maliciousApplies++;
      next.next=commitment.chunkCount; next.previous=commitment.finalDigest;
      next.inventory=next.inventoryDigest; next.table=commitment.tables.length;
      maliciousCheckpoint=structuredClone(next);
    },
    async finish(cp){maliciousCheckpoint={...cp,complete:true};},
  };
  await assert.rejects(()=>restoreSyntheticArchive(bucket,kms,scope,commitment,envelope,signal(),mutatingTarget,verifiedOptions),/Archive restore checkpoint differs/);
  assert.equal(maliciousApplies,1); assert.equal(maliciousCheckpoint.complete,false);
  const completedCheckpoint=await target.load();
  let unexpectedWrites=0;
  for (const malformed of [{...completedCheckpoint,unexpected:'x'}, {...completedCheckpoint,previous:'x'.repeat(65)}, {...completedCheckpoint,next:{value:1}}]) {
    const invalidTarget={load:async()=>malformed,begin:async()=>{unexpectedWrites++;},apply:async()=>{unexpectedWrites++;},finish:async()=>{unexpectedWrites++;}};
    await assert.rejects(()=>restoreSyntheticArchive(bucket,kms,scope,commitment,envelope,signal(),invalidTarget,verifiedOptions),/Archive destination unavailable/);
  }
  assert.equal(unexpectedWrites,0);
  // A checkpoint read can stall after begin committed. Abort must end the
  // wait, discard a late failure, and leave the durable target resumable.
  staged.close(); staged=new DatabaseSync(path.join(root,'cancel-read-stage.sqlite'));
  staged.exec("CREATE TABLE users(id TEXT PRIMARY KEY,name TEXT); CREATE TABLE events(id INTEGER PRIMARY KEY,payload TEXT); CREATE TABLE import_history(idx INTEGER PRIMARY KEY,digest TEXT NOT NULL); CREATE TABLE checkpoint(singleton INTEGER PRIMARY KEY,state TEXT NOT NULL)");
  let reads=0, enteredRead, rejectRead;
  const entered=new Promise(resolve=>{enteredRead=resolve;});
  const pendingRead=new Promise((resolve,reject)=>{rejectRead=reject;});
  const stalledTarget={...target,async load(){ if(++reads===2){enteredRead(); return pendingRead;} return target.load(); }};
  const controller=new AbortController();
  const blockedRestore=restoreSyntheticArchive(bucket,kms,scope,commitment,envelope,controller.signal,stalledTarget,verifiedOptions);
  await entered; controller.abort();
  await assert.rejects(blockedRestore,/Archive operation canceled/);
  assert.equal((await target.load()).next,0); assert.equal(staged.prepare('SELECT count(*) n FROM users').get().n,0);
  rejectRead(Error('late synthetic checkpoint read failure')); await new Promise(resolve=>setImmediate(resolve));
  assert.equal((await restoreSyntheticArchive(bucket,kms,scope,commitment,envelope,signal(),target,verifiedOptions)).next,1);
  assert.equal((await restoreSyntheticArchive(bucket,kms,scope,commitment,envelope,signal(),target,verifiedOptions)).complete,true);
  assert.deepEqual(staged.prepare('SELECT * FROM users ORDER BY id').all(),source.prepare('SELECT * FROM users ORDER BY id').all());
  assert.deepEqual(staged.prepare('SELECT * FROM events ORDER BY id').all(),source.prepare('SELECT * FROM events ORDER BY id').all());
  const prefix=`mapi-p1-synthetic-archive-v1/${RUN}/${scope.archiveId}`, selectorPath=bucket.path(`${prefix}/chunk-selector/${String(0).padStart(16,'0')}`);
  const selectorBytes=await readFile(selectorPath), secondSelectorPath=bucket.path(`${prefix}/chunk-selector/${String(1).padStart(16,'0')}`);
  await writeFile(selectorPath,await readFile(secondSelectorPath)); await assert.rejects(()=>verifySyntheticArchive(bucket,kms,scope,commitment,envelope,signal())); await writeFile(selectorPath,selectorBytes);
  const partPath=bucket.path(`${prefix}/part-selector/${String(0).padStart(16,'0')}`), partSaved=await readFile(partPath);
  await writeFile(partPath,await readFile(bucket.path(`${prefix}/part-selector/${String(1).padStart(16,'0')}`)));
  await assert.rejects(()=>verifySyntheticArchive(bucket,kms,scope,commitment,envelope,signal())); await writeFile(partPath,partSaved);
  await unlink(partPath); await assert.rejects(()=>verifySyntheticArchive(bucket,kms,scope,commitment,envelope,signal())); await writeFile(partPath,partSaved);
  const extraPart=bucket.path(`${prefix}/part-selector/${String(4).padStart(16,'0')}`); await writeFile(extraPart,'unexpected');
  await assert.rejects(()=>verifySyntheticArchive(bucket,kms,scope,commitment,envelope,signal())); await unlink(extraPart);
  const selector=JSON.parse(selectorBytes.toString('utf8')), attemptPath=bucket.path(`${prefix}/attempt/${selector[4]}`), original=await readFile(attemptPath);
  const damaged=new Uint8Array(original); damaged[damaged.length-3]^=1; await writeFile(attemptPath,damaged);
  let writes=0; const fresh={load:async()=>null,begin:async()=>{writes++},apply:async()=>{writes++},finish:async()=>{writes++}}; await assert.rejects(()=>restoreSyntheticArchive(bucket,kms,scope,commitment,envelope,signal(),fresh)); assert.equal(writes,0);
  await writeFile(attemptPath,original); const deleted=selectorPath+'.removed'; await link(selectorPath,deleted); await unlink(selectorPath);
  await assert.rejects(()=>verifySyntheticArchive(bucket,kms,scope,commitment,envelope,signal())); await link(deleted,selectorPath); await unlink(deleted);
  const sealPath=bucket.path(`${prefix}/seal-selector/${String(0).padStart(16,'0')}`), savedSeal=sealPath+'.removed'; await link(sealPath,savedSeal); await unlink(sealPath);
  await assert.rejects(()=>verifySyntheticArchive(bucket,kms,scope,commitment,envelope,signal())); await link(savedSeal,sealPath); await unlink(savedSeal);
  assert.equal((await verifySyntheticArchive(bucket,kms,scope,commitment,envelope,signal())).chunkCount,2);
  const extra=bucket.path(`${prefix}/chunk-selector/${String(2).padStart(16,'0')}`); await writeFile(extra,'unexpected');
  await assert.rejects(()=>verifySyntheticArchive(bucket,kms,scope,commitment,envelope,signal())); await unlink(extra);
  const files=await readdir(path.join(root,prefix,'attempt')); for(const f of files) assert(!String(await readFile(path.join(root,prefix,'attempt',f))).includes('secret-synthetic-user'));
  // Test the archive transport bound using synthetic JSON bytes, not a
  // platform-maximum SQLite row or the separate RETURNING bridge scenario.
  const largeScope={...scope,archiveId:'8'.repeat(32)};
  const largeBase={projectId:'p',generation:1,moveId:'move',index:0,prev:'',table:'users',columns:['id','name'],offset:0,rows:[['u','']],last:true,done:true,cursor:null};
  const overhead=encoder.encode(JSON.stringify(largeBase)).length; largeBase.rows[0][1]='x'.repeat(128*1024-overhead);
  const largeContent=JSON.stringify(largeBase); assert.equal(encoder.encode(largeContent).length,128*1024);
  const largeCommitment={...commitment,tables:['users'],chunkCount:1,finalDigest:await sha(largeContent)};
  const largeEnvelope=(await mintSyntheticArchiveKey(bucket,kms,largeScope,signal())).provisionalEnvelopeDigest;
  await archiveSyntheticChunk(bucket,kms,largeScope,largeCommitment,largeEnvelope,0,largeContent,signal());
  await sealSyntheticArchive(bucket,kms,largeScope,largeCommitment,largeEnvelope,signal());
  await verifySyntheticArchive(bucket,kms,largeScope,largeCommitment,largeEnvelope,signal());
  const largePrefix=`mapi-p1-synthetic-archive-v1/${RUN}/${largeScope.archiveId}`;
  const attemptNames=await readdir(path.join(root,largePrefix,'attempt'));
  const encodedSizes=[]; for(const attemptName of attemptNames) encodedSizes.push((await readFile(path.join(root,largePrefix,'attempt',attemptName))).length);
  const largest=Math.max(...encodedSizes); assert(attemptNames.length>=3 && largest<=128*1024);
  const p0=JSON.parse(await readFile(bucket.path(`${largePrefix}/part-selector/${String(0).padStart(16,'0')}`),'utf8'));
  const p1=JSON.parse(await readFile(bucket.path(`${largePrefix}/part-selector/${String(1).padStart(16,'0')}`),'utf8'));
  assert.notEqual(p0[4],p1[4]);
  console.log(`Maximum-source fixture: ${encoder.encode(largeContent).length} bytes; largest encrypted object: ${largest} bytes`);
  source.close(); staged.close();
  console.log('Synthetic encrypted archive and restore tests passed');
} finally { await rm(root,{recursive:true,force:true}); }
