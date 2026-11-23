import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, link, unlink, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { mintSyntheticArchiveKey } from '../worker/synthetic-archive-key-provider.js';
import { archiveSyntheticChunk, beginSyntheticSealing, advanceSyntheticSealing, verifySyntheticArchive, verifySyntheticAuthorizedArchive, beginSyntheticVerification, advanceSyntheticVerification, restoreSyntheticArchive, sealSyntheticArchive } from '../worker/synthetic-relocation-archive.js';

// Synthetic-only, disposable filesystem store and KMS/authority doubles.
// Their guarantees are not evidence of independent custody or retention.
const KEY='arn:aws:kms:us-east-1:646535719915:key/7614cff5-444e-4615-a785-4192dd150c2f';
const RUN='mapi-p1-syn-20261123T074636Z-bef5970113984cf34aa5c70e9d0a2c9a';
const encoder=new TextEncoder(), signal=()=>new AbortController().signal;
const sha=async s=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',encoder.encode(s)))].map(v=>v.toString(16).padStart(2,'0')).join('');
const root=await mkdtemp(path.join(tmpdir(),'mapi-sealing-test-'));
class Bucket {
  reads=[]; pageSize=2; loseSealAck=false; afterSeal=null; afterPut=null;
  path(k) { if(!/^[a-zA-Z0-9/_.-]+$/.test(k) || k.includes('..')) throw Error('invalid key'); return path.join(root,k); }
  async put(k,v,opts) {
    assert.equal(opts.onlyIf.get('If-None-Match'),'*');
    const dest=this.path(k), temp=dest+'.'+crypto.randomUUID()+'.tmp'; await mkdir(path.dirname(dest),{recursive:true}); await writeFile(temp,v,{flag:'wx'});
    try { await link(temp,dest); } catch(e) { if(e.code==='EEXIST') return null; throw e; } finally { await unlink(temp); }
    if(this.afterPut) await this.afterPut(k);
    if(k.includes('/seal-selector/') && this.afterSeal) {const callback=this.afterSeal;this.afterSeal=null;await callback();}
    if(this.loseSealAck && k.includes('/seal-selector/')) {this.loseSealAck=false;throw Error('lost seal acknowledgement');}
    return {key:k};
  }
  async get(k) { this.reads.push(k); let data; try {data=await readFile(this.path(k));} catch(e) {if(e.code==='ENOENT')return null;throw e;}
    return {size:data.length,body:new ReadableStream({start(c){c.enqueue(new Uint8Array(data));c.close();}})}; }
  async list(opts) { let names; try { names=await readdir(this.path(opts.prefix)); } catch(e) {if(e.code==='ENOENT')names=[];else throw e;}
    const items=names.sort().map(name=>({key:opts.prefix+name})), start=opts.cursor?Number(opts.cursor):0, page=items.slice(start,start+Math.min(opts.limit,this.pageSize));
    return {objects:page,truncated:start+page.length<items.length,...(start+page.length<items.length?{cursor:String(start+page.length)}:{})}; }
}
class KMS {
  keys=new Map();
  async generateDataKey(r) {assert.equal(r.KeyId,KEY);const key=crypto.getRandomValues(new Uint8Array(32)),wrapped=crypto.getRandomValues(new Uint8Array(32));this.keys.set(wrapped.toBase64(),new Uint8Array(key));return {KeyId:KEY,Plaintext:key,CiphertextBlob:wrapped};}
  async decrypt(r) {const key=this.keys.get(r.CiphertextBlob.toBase64());if(!key)throw Error('wrong key');return {KeyId:KEY,Plaintext:new Uint8Array(key)};}
}
class Authority {
  jobs=new Map(); identities=new Map(); loseAck=false; failBefore=false; failReadOnce=false; failReadAfterWrite=false;
  async read(id) {if(this.failReadOnce){this.failReadOnce=false;throw Error('authority unavailable');}return structuredClone(this.jobs.get(id)??null);}
  async create(id,head) {assert(!this.jobs.has(id));assert(!this.identities.has(head.identityDigest));assert.equal(head.revision,0);assert.equal(head.parentDigest,'');assert.equal(head.terminal,false);this.identities.set(head.identityDigest,id);this.jobs.set(id,structuredClone(head));}
  async compareAndSwap(id,old,next) {
    if(this.failBefore){this.failBefore=false;throw Error('failed before compare and swap');}
    assert.deepEqual(this.jobs.get(id),old);assert.equal(old.terminal,false);assert.equal(next.identityDigest,old.identityDigest);assert.equal(next.revision,old.revision+1);assert.equal(next.parentDigest,await sha(JSON.stringify(old)));
    this.jobs.set(id,structuredClone(next));if(this.failReadAfterWrite){this.failReadAfterWrite=false;this.failReadOnce=true;throw Error('lost compare and swap acknowledgement');}if(this.loseAck){this.loseAck=false;throw Error('lost compare and swap acknowledgement');}
  }
}
try {
  const bucket=new Bucket(), kms=new KMS(), authority=new Authority(), job='7'.repeat(32), tables=['users'];
  const manifest=JSON.stringify({projectId:'synthetic-project',tables});
  const scope={keyArn:KEY,runId:RUN,archiveId:'4'.repeat(32),manifestDigest:await sha(manifest)};
  const chunks=[];let previous='';
  for(let i=0;i<6;i++) {const content=JSON.stringify({projectId:'synthetic-project',generation:1,moveId:'synthetic-move',index:i,prev:previous,table:'users',columns:['id','name'],offset:i,rows:[[String(i),'user-'+i]],last:i===5,done:i===5,cursor:null});previous=await sha(content);chunks.push(content);}
  const commitment={projectId:'synthetic-project',origin:'https://synthetic.example',objectName:'synthetic-source',generation:1,moveId:'synthetic-move',manifestDigest:scope.manifestDigest,tables,chunkCount:chunks.length,finalDigest:previous};
  const envelope=(await mintSyntheticArchiveKey(bucket,kms,scope,signal())).provisionalEnvelopeDigest;
  for(let i=0;i<chunks.length;i++) await archiveSyntheticChunk(bucket,kms,scope,commitment,envelope,i,chunks[i],signal());
  const run=head=>advanceSyntheticSealing(bucket,kms,scope,commitment,envelope,signal(),authority,job,head,2);
  await assert.rejects(()=>beginSyntheticSealing(bucket,kms,scope,commitment,envelope,signal(),null,job));
  const prefix=`mapi-p1-synthetic-archive-v1/${RUN}/${scope.archiveId}`;
  const extraSealPath=bucket.path(`${prefix}/seal-selector/${String(1).padStart(16,'0')}`);
  await mkdir(path.dirname(extraSealPath),{recursive:true});await writeFile(extraSealPath,'unexpected');
  await assert.rejects(()=>beginSyntheticSealing(bucket,kms,scope,commitment,envelope,signal(),authority,job));
  await unlink(extraSealPath);
  let head=await beginSyntheticSealing(bucket,kms,scope,commitment,envelope,signal(),authority,job), stale=structuredClone(head);
  await assert.rejects(()=>beginSyntheticSealing(bucket,kms,scope,commitment,envelope,signal(),authority,'8'.repeat(32)));
  authority.loseAck=true;let result=await run(head);head=result.head;assert.equal(head.revision,1);assert.equal(result.complete,false);
  await assert.rejects(()=>run(stale));
  await assert.rejects(()=>advanceSyntheticSealing(bucket,kms,scope,{...commitment,projectId:'foreign'},envelope,signal(),authority,job,head,2));
  const selectorPath=bucket.path(`${prefix}/${head.role}-selector/${String(0).padStart(16,'0')}`), selector=JSON.parse(await readFile(selectorPath,'utf8'));
  const attemptPath=bucket.path(`${prefix}/attempt/${selector[4]}`), original=await readFile(attemptPath), damaged=new Uint8Array(original);damaged[damaged.length-3]^=1;
  await writeFile(attemptPath,damaged);await assert.rejects(()=>run(head));await writeFile(attemptPath,original);
  bucket.reads=[];result=await run(head);head=result.head;
  assert(!bucket.reads.some(k=>k.endsWith('/chunk-selector/0000000000000000')));
  result=await run(head);head=result.head; // six chunks scanned
  const ordinary=await bucket.list({prefix:`${prefix}/chunk-selector/`,limit:1000});const savedList=bucket.list.bind(bucket);
  bucket.list=async opts=>opts.cursor?{objects:[ordinary.objects[0]],truncated:false}:{objects:[ordinary.objects[0]],truncated:true,cursor:'1'};
  result=await run(head);head=result.head;await assert.rejects(()=>run(head));bucket.list=savedList;
  // Continue with the durable checkpoint on page 2; no prior page rescan.
  let finishedParts=false;
  bucket.list=async opts=>{const page=await savedList(opts);if(opts.prefix.includes('/part-selector/') && !page.truncated)finishedParts=true;return page;};
  for(let i=0;i<20 && !finishedParts;i++){result=await run(head);head=result.head;}
  assert(finishedParts);bucket.list=savedList;
  const sealKey=`${prefix}/seal-selector/${String(0).padStart(16,'0')}`;
  // A failed or ambiguous terminal compare-and-swap cannot publish a seal.
  authority.failBefore=true;await assert.rejects(()=>run(head));assert.deepEqual(await authority.read(job),head);assert.equal(await bucket.get(sealKey),null);
  const readyHead=structuredClone(head);authority.failReadAfterWrite=true;await assert.rejects(()=>run(head),/outcome uncertain/);
  head=await authority.read(job);assert.equal(head.terminal,true);assert.equal(head.revision,readyHead.revision+1);assert.equal(await bucket.get(sealKey),null);
  assert.equal(await bucket.get(sealKey),null); // authority committed before publication
  await assert.rejects(()=>verifySyntheticArchive(bucket,kms,scope,commitment,envelope,signal()));
  await assert.rejects(()=>verifySyntheticAuthorizedArchive(bucket,kms,scope,commitment,envelope,signal(),authority,job,head));
  // Violate the required terminal-authority contract during publication. The
  // driver detects it after the write, and the mode marker rejects legacy
  // readers; an operator must reconcile the authority before any use.
  bucket.afterSeal=()=>authority.jobs.set(job,structuredClone(readyHead));bucket.loseSealAck=true;
  await assert.rejects(()=>run(head),/reconciliation/);assert.notEqual(await bucket.get(sealKey),null);
  await assert.rejects(()=>verifySyntheticArchive(bucket,kms,scope,commitment,envelope,signal()));
  await assert.rejects(()=>verifySyntheticAuthorizedArchive(bucket,kms,scope,commitment,envelope,signal(),authority,job,head));
  await assert.rejects(()=>run(head));authority.jobs.set(job,structuredClone(head)); // fixture-only reconciliation
  result=await run(head);assert.equal(result.complete,true);assert.equal(result.head.terminal,true);
  const sealBytes=await readFile(bucket.path(sealKey));result=await run(head);assert.equal(result.complete,true);assert.deepEqual(await readFile(bucket.path(sealKey)),sealBytes);
  await assert.rejects(()=>verifySyntheticArchive(bucket,kms,scope,commitment,envelope,signal()));
  await assert.rejects(()=>sealSyntheticArchive(bucket,kms,scope,commitment,envelope,signal()));
  await assert.rejects(()=>archiveSyntheticChunk(bucket,kms,scope,commitment,envelope,0,chunks[0],signal()));
  const authorized=await verifySyntheticAuthorizedArchive(bucket,kms,scope,commitment,envelope,signal(),authority,job,head);
  assert.equal(authorized.inventoryDigest,result.inventoryDigest);assert.equal(authorized.sealDigest,result.sealDigest);
  await writeFile(extraSealPath,'unexpected');
  await assert.rejects(()=>run(head));await assert.rejects(()=>verifySyntheticAuthorizedArchive(bucket,kms,scope,commitment,envelope,signal(),authority,job,head));
  await unlink(extraSealPath);
  class VerificationAuthority {
    jobs=new Map();
    async read(id) {return structuredClone(this.jobs.get(id)??null);}
    async create(id,value) {assert(!this.jobs.has(id));this.jobs.set(id,structuredClone(value));}
    async compareAndSwap(id,old,next) {assert.deepEqual(this.jobs.get(id),old);if(old.terminal)throw Error('terminal verification head');assert.equal(next.revision,old.revision+1);assert.equal(next.parentDigest,await sha(JSON.stringify(old)));this.jobs.set(id,structuredClone(next));}
  }
  const verifier=new VerificationAuthority(), vjob='a'.repeat(32), sealing={authority,jobId:job,head};
  await assert.rejects(()=>beginSyntheticVerification(bucket,kms,scope,commitment,envelope,signal(),verifier,vjob));
  await assert.rejects(()=>beginSyntheticVerification(bucket,kms,scope,commitment,envelope,signal(),verifier,vjob,{...sealing,head:readyHead}));
  let vhead=await beginSyntheticVerification(bucket,kms,scope,commitment,envelope,signal(),verifier,vjob,sealing), vresult={complete:false,head:vhead};
  assert.equal(vhead.sealingHeadDigest,await sha(JSON.stringify(head)));
  await assert.rejects(()=>advanceSyntheticVerification(bucket,kms,scope,commitment,envelope,signal(),verifier,vjob,vhead,2));
  for(let i=0;i<30 && !vresult.complete;i++){vresult=await advanceSyntheticVerification(bucket,kms,scope,commitment,envelope,signal(),verifier,vjob,vhead,2,sealing);vhead=vresult.head;}
  assert(vresult.complete);assert.equal(vhead.terminal,true);assert.equal(vresult.inventoryDigest,authorized.inventoryDigest);
  await assert.rejects(()=>verifier.compareAndSwap(vjob,vhead,{...vhead,revision:vhead.revision+1}));
  const replay=await advanceSyntheticVerification(bucket,kms,scope,commitment,envelope,signal(),verifier,vjob,vhead,2,sealing);assert.equal(replay.complete,true);assert.deepEqual(replay.head,vhead);
  const options={authority:verifier,jobId:vjob,head:vhead,maxChunks:2,sealing};
  let checkpoint=null, staged=[], callbacks=0, changeSealing=true, changeVerification=false;
  const target={
    async load(){callbacks++;return structuredClone(checkpoint)},
    async begin(cp){callbacks++;assert.equal(checkpoint,null);checkpoint=structuredClone(cp)},
    async apply({expected,next,content}){callbacks++;assert.deepEqual(checkpoint,expected);staged.push(...JSON.parse(content).rows);checkpoint=structuredClone(next);
      if(changeSealing){changeSealing=false;authority.jobs.set(job,structuredClone(readyHead));}
      else if(changeVerification){changeVerification=false;verifier.jobs.set(vjob,{...vhead,revision:vhead.revision+1});}},
    async finish(cp){callbacks++;assert.deepEqual(checkpoint,cp);checkpoint={...cp,complete:true}}
  };
  let touched=callbacks;await assert.rejects(()=>restoreSyntheticArchive(bucket,kms,scope,commitment,envelope,signal(),target,{...options,sealing:{...sealing,head:readyHead}}));assert.equal(callbacks,touched);
  await assert.rejects(()=>restoreSyntheticArchive(bucket,kms,scope,commitment,envelope,signal(),target,{...options,sealing:null}));assert.equal(callbacks,touched);
  await assert.rejects(()=>restoreSyntheticArchive(bucket,kms,scope,commitment,envelope,signal(),target,options));
  assert.equal(checkpoint.next,1);assert.equal(checkpoint.complete,false);assert.equal(staged.length,1);
  touched=callbacks;await assert.rejects(()=>restoreSyntheticArchive(bucket,kms,scope,commitment,envelope,signal(),target,options));assert.equal(callbacks,touched);
  authority.jobs.set(job,structuredClone(head)); // fixture-only authority reconciliation
  changeVerification=true;await assert.rejects(()=>restoreSyntheticArchive(bucket,kms,scope,commitment,envelope,signal(),target,options));
  assert.equal(checkpoint.next,2);assert.equal(checkpoint.complete,false);assert.equal(staged.length,2);
  verifier.jobs.set(vjob,structuredClone(vhead)); // fixture-only authority reconciliation
  for(let i=0;i<8 && !checkpoint.complete;i++) await restoreSyntheticArchive(bucket,kms,scope,commitment,envelope,signal(),target,options);
  assert.equal(checkpoint.complete,true);assert.equal(staged.length,6);
  await assert.rejects(()=>restoreSyntheticArchive(bucket,kms,scope,commitment,envelope,signal(),target)); // no downgrade
  let finishCheckpoint=null;
  const finishTarget={async load(){return structuredClone(finishCheckpoint)},async begin(cp){finishCheckpoint=structuredClone(cp)},async apply({expected,next}){assert.deepEqual(finishCheckpoint,expected);finishCheckpoint=structuredClone(next)},async finish(cp){finishCheckpoint={...cp,complete:true};authority.jobs.set(job,structuredClone(readyHead))}};
  await assert.rejects(()=>restoreSyntheticArchive(bucket,kms,scope,commitment,envelope,signal(),finishTarget,{...options,maxChunks:8}));
  assert.equal(finishCheckpoint.complete,true); // completion is not activation or authorization
  await assert.rejects(()=>restoreSyntheticArchive(bucket,kms,scope,commitment,envelope,signal(),finishTarget,{...options,maxChunks:8}));
  authority.jobs.set(job,structuredClone(head)); // fixture-only reconciliation; no production activation
  // Rollback/deletion of the required marker breaks this protection: this is a
  // negative demonstration, not an acceptable storage guarantee.
  const modePath=bucket.path(`${prefix}/sealing-mode/${String(0).padStart(16,'0')}`), savedMode=await readFile(modePath);
  await unlink(modePath);touched=callbacks;await assert.rejects(()=>restoreSyntheticArchive(bucket,kms,scope,commitment,envelope,signal(),target,options));assert.equal(callbacks,touched);
  assert.equal((await verifySyntheticArchive(bucket,kms,scope,commitment,envelope,signal())).finalDigest,previous);
  await writeFile(modePath,savedMode);
  // Legacy calls can be overtaken by marker creation across an await. Rechecks
  // detect the change but cannot undo already committed data; a real move must
  // drain old code and calls before creating the marker.
  async function newLegacyFixture(id) {
    const s={...scope,archiveId:id.repeat(32)}, content=JSON.stringify({projectId:'synthetic-project',generation:1,moveId:'synthetic-move',index:0,prev:'',table:'users',columns:['id','name'],offset:0,rows:[['u','legacy']],last:true,done:true,cursor:null});
    const c={...commitment,chunkCount:1,finalDigest:await sha(content)}, d=(await mintSyntheticArchiveKey(bucket,kms,s,signal())).provisionalEnvelopeDigest;
    const p=`mapi-p1-synthetic-archive-v1/${RUN}/${s.archiveId}`, marker=bucket.path(`${p}/sealing-mode/${String(0).padStart(16,'0')}`);
    const addMarker=async()=>{await mkdir(path.dirname(marker),{recursive:true});await writeFile(marker,'test-only-interleaving-marker');};
    return {s,c,d,content,marker,addMarker};
  }
  const oldWriter=await newLegacyFixture('1');
  bucket.afterPut=async key=>{if(key.includes('/part-selector/')){bucket.afterPut=null;await oldWriter.addMarker();}};
  await assert.rejects(()=>archiveSyntheticChunk(bucket,kms,oldWriter.s,oldWriter.c,oldWriter.d,0,oldWriter.content,signal()),/requires sealing authority/);
  const oldSealer=await newLegacyFixture('2');await archiveSyntheticChunk(bucket,kms,oldSealer.s,oldSealer.c,oldSealer.d,0,oldSealer.content,signal());
  bucket.afterPut=async key=>{if(key.includes('/seal-selector/')){bucket.afterPut=null;await oldSealer.addMarker();}};
  await assert.rejects(()=>sealSyntheticArchive(bucket,kms,oldSealer.s,oldSealer.c,oldSealer.d,signal()),/requires sealing authority/);
  const oldRestore=await newLegacyFixture('3');await archiveSyntheticChunk(bucket,kms,oldRestore.s,oldRestore.c,oldRestore.d,0,oldRestore.content,signal());
  await sealSyntheticArchive(bucket,kms,oldRestore.s,oldRestore.c,oldRestore.d,signal());
  const legacyAuthority=new VerificationAuthority(), legacyJob='b'.repeat(32);
  let legacyHead=await beginSyntheticVerification(bucket,kms,oldRestore.s,oldRestore.c,oldRestore.d,signal(),legacyAuthority,legacyJob), legacyResult={complete:false};
  assert.equal(legacyHead.version,2);assert.equal(legacyHead.terminal,false);
  await assert.rejects(()=>advanceSyntheticVerification(bucket,kms,oldRestore.s,oldRestore.c,oldRestore.d,signal(),legacyAuthority,legacyJob,{...legacyHead,version:1},1));
  await assert.rejects(()=>advanceSyntheticVerification(bucket,kms,oldRestore.s,oldRestore.c,oldRestore.d,signal(),legacyAuthority,legacyJob,{...legacyHead,terminal:true},1));
  for(let i=0;i<10 && !legacyResult.complete;i++){legacyResult=await advanceSyntheticVerification(bucket,kms,oldRestore.s,oldRestore.c,oldRestore.d,signal(),legacyAuthority,legacyJob,legacyHead,1);legacyHead=legacyResult.head;}
  assert.equal(legacyHead.terminal,true);await assert.rejects(()=>legacyAuthority.compareAndSwap(legacyJob,legacyHead,{...legacyHead,revision:legacyHead.revision+1}));
  let oldCheckpoint=null;
  const oldTarget={async load(){return structuredClone(oldCheckpoint)},async begin(cp){oldCheckpoint=structuredClone(cp)},async apply({next}){oldCheckpoint=structuredClone(next);await oldRestore.addMarker()},async finish(cp){oldCheckpoint={...cp,complete:true}}};
  await assert.rejects(()=>restoreSyntheticArchive(bucket,kms,oldRestore.s,oldRestore.c,oldRestore.d,signal(),oldTarget),/requires sealing authority/);
  assert.equal(oldCheckpoint.next,1);assert.equal(oldCheckpoint.complete,false);
  const deletionFixture=await newLegacyFixture('5');
  await archiveSyntheticChunk(bucket,kms,deletionFixture.s,deletionFixture.c,deletionFixture.d,0,deletionFixture.content,signal());
  const deletionAuthority=new Authority(), deletionJob='c'.repeat(32);
  let deletionHead=await beginSyntheticSealing(bucket,kms,deletionFixture.s,deletionFixture.c,deletionFixture.d,signal(),deletionAuthority,deletionJob), deletionResult={};
  for(let i=0;i<10 && !deletionResult.readyToPublish;i++){deletionResult=await advanceSyntheticSealing(bucket,kms,deletionFixture.s,deletionFixture.c,deletionFixture.d,signal(),deletionAuthority,deletionJob,deletionHead,1);deletionHead=deletionResult.head;}
  assert(deletionResult.readyToPublish);const protectedMarker=await readFile(deletionFixture.marker);
  bucket.afterSeal=async()=>unlink(deletionFixture.marker);
  await assert.rejects(()=>advanceSyntheticSealing(bucket,kms,deletionFixture.s,deletionFixture.c,deletionFixture.d,signal(),deletionAuthority,deletionJob,deletionHead,1));
  // A missing marker lets a legacy verifier accept the published seal. This is
  // exactly why nonrollback storage and exclusive closure remain hard gates.
  assert.equal((await verifySyntheticArchive(bucket,kms,deletionFixture.s,deletionFixture.c,deletionFixture.d,signal())).finalDigest,deletionFixture.c.finalDigest);
  await writeFile(deletionFixture.marker,protectedMarker); // fixture-only reconciliation
  assert.equal((await advanceSyntheticSealing(bucket,kms,deletionFixture.s,deletionFixture.c,deletionFixture.d,signal(),deletionAuthority,deletionJob,deletionHead,1)).complete,true);
  await assert.rejects(()=>beginSyntheticSealing(bucket,kms,scope,commitment,envelope,signal(),new Authority(),'9'.repeat(32)));
  console.log('Bounded synthetic archive sealing passed: staged scan, short-page inventory, terminal-before-publication, lost acknowledgements, integrity and retry');
} finally {await rm(root,{recursive:true,force:true});}
