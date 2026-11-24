// Focused read-only capability test. This uses no real owner/importer, Woven,
// AWS, combined workerd harness, or representative/scale fixture.
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mintSyntheticArchiveKey } from '../worker/synthetic-archive-key-provider.js';
import { archiveSyntheticChunk, beginSyntheticSealing, advanceSyntheticSealing, beginSyntheticVerification, advanceSyntheticVerification, verifySyntheticAuthorizedArchive, restoreSyntheticArchive } from '../worker/synthetic-relocation-archive.js';

const sha = text => createHash('sha256').update(text).digest('hex');
const signal = () => new AbortController().signal;
const keyArn='arn:aws:kms:us-east-1:646535719915:key/7614cff5-444e-4615-a785-4192dd150c2f';
const runId='mapi-p1-syn-20261123T074636Z-bef5970113984cf34aa5c70e9d0a2c9a';
class Bucket {
  objects=new Map();
  async put(key,value,options) {
    assert.equal(options.onlyIf.get('If-None-Match'),'*');
    if (this.objects.has(key)) return null;
    this.objects.set(key,new Uint8Array(value)); return {key};
  }
  async get(key) {
    if (this.onGet) this.onGet(key);
    const value=this.objects.get(key); if (!value) return null;
    const copy=new Uint8Array(value);
    return {size:copy.length,body:new ReadableStream({start(c){c.enqueue(copy);c.close();}})};
  }
  async list({prefix,limit,cursor}) {
    const all=[...this.objects.keys()].filter(k=>k.startsWith(prefix)).sort();
    const start=cursor?Number(cursor):0, objects=all.slice(start,start+limit).map(key=>({key})), end=start+objects.length;
    return {objects,truncated:end<all.length,...(end<all.length?{cursor:String(end)}:{})};
  }
}
class KMS {
  keys=new Map();
  async generateDataKey() {
    const raw=new Uint8Array(randomBytes(32)), wrapped=new Uint8Array(randomBytes(32));
    this.keys.set(wrapped.toBase64(),new Uint8Array(raw));
    return {KeyId:keyArn,Plaintext:raw,CiphertextBlob:wrapped};
  }
  async decrypt(request) {
    const raw=this.keys.get(request.CiphertextBlob.toBase64());
    if (!raw) throw Error('synthetic key unavailable');
    return {KeyId:keyArn,Plaintext:new Uint8Array(raw)};
  }
}
class Authority {
  jobs=new Map();
  async read(job) { const value=structuredClone(this.jobs.get(job)??null); this.afterRead?.(job,value); return value; }
  async create(job,head) { if(this.jobs.has(job))throw Error('conflict');this.jobs.set(job,structuredClone(head)); }
  async compareAndSwap(job,expected,next) {
    assert.deepEqual(this.jobs.get(job),expected);
    if(expected.terminal)throw Error('terminal');
    this.jobs.set(job,structuredClone(next));
    this.afterSwap?.(job,next);
  }
}
const bucket=new Bucket(), kms=new KMS(), sealingAuthority=new Authority(), verificationAuthority=new Authority();
const scope={keyArn,runId,archiveId:'a'.repeat(32),manifestDigest:'b'.repeat(64)};
const content=JSON.stringify({projectId:'p',generation:1,moveId:'move',index:0,prev:'',table:'users',columns:['id'],offset:0,rows:[['u']],last:true,done:true,cursor:null});
const commitment={projectId:'p',origin:'https://p.example',objectName:'source',generation:1,moveId:'move',manifestDigest:scope.manifestDigest,tables:['users'],chunkCount:1,finalDigest:sha(content)};
const envelope=(await mintSyntheticArchiveKey(bucket,kms,scope,signal())).provisionalEnvelopeDigest;
await archiveSyntheticChunk(bucket,kms,scope,commitment,envelope,0,content,signal());
const sealJob='1'.repeat(32), verifyJob='2'.repeat(32);
let sealHead=await beginSyntheticSealing(bucket,kms,scope,commitment,envelope,signal(),sealingAuthority,sealJob), firstSealHead=structuredClone(sealHead), sealed;
for(let steps=0;steps<10 && !sealed?.complete;steps++) { sealed=await advanceSyntheticSealing(bucket,kms,scope,commitment,envelope,signal(),sealingAuthority,sealJob,sealHead,1); sealHead=sealed.head; }
assert.equal(sealed.complete,true);
const readSealing=Object.freeze({read:job=>sealingAuthority.read(job)});
const readVerification=Object.freeze({read:job=>verificationAuthority.read(job)});
assert.equal(readSealing.create,undefined); assert.equal(readVerification.compareAndSwap,undefined);
const seal={authority:readSealing,jobId:sealJob,head:sealHead};
assert.equal((await verifySyntheticAuthorizedArchive(bucket,kms,scope,commitment,envelope,signal(),readSealing,sealJob,sealHead)).chunkCount,1);
await assert.rejects(()=>verifySyntheticAuthorizedArchive(bucket,kms,scope,commitment,envelope,signal(),{},sealJob,sealHead),/authority required/);
await assert.rejects(()=>verifySyntheticAuthorizedArchive(bucket,kms,scope,commitment,envelope,signal(),readSealing,sealJob,firstSealHead));
await assert.rejects(()=>beginSyntheticSealing(bucket,kms,scope,commitment,envelope,signal(),readSealing,'3'.repeat(32)),/authority required/);
await assert.rejects(()=>advanceSyntheticSealing(bucket,kms,scope,commitment,envelope,signal(),readSealing,sealJob,sealHead,1),/authority required/);
await assert.rejects(()=>beginSyntheticVerification(bucket,kms,scope,commitment,envelope,signal(),readVerification,verifyJob,seal),/authority required/);
let verifyHead=await beginSyntheticVerification(bucket,kms,scope,commitment,envelope,signal(),verificationAuthority,verifyJob,seal), firstVerifyHead=structuredClone(verifyHead), verified;
await assert.rejects(()=>advanceSyntheticVerification(bucket,kms,scope,commitment,envelope,signal(),readVerification,verifyJob,verifyHead,1,seal),/authority required/);
for(let steps=0;steps<10 && !verified?.complete;steps++) { verified=await advanceSyntheticVerification(bucket,kms,scope,commitment,envelope,signal(),verificationAuthority,verifyJob,verifyHead,1,seal);verifyHead=verified.head; }
assert.equal(verified.complete,true);
let checkpoint=null, calls=0, rows=[];
const target={
  async load(){calls++;return structuredClone(checkpoint);},
  async begin(cp){calls++;assert.equal(checkpoint,null);checkpoint=structuredClone(cp);},
  async apply({expected,next,content:chunk}){calls++;assert.deepEqual(checkpoint,expected);rows.push(chunk);checkpoint=structuredClone(next);},
  async finish(cp){calls++;assert.deepEqual(checkpoint,cp);checkpoint={...cp,complete:true};},
};
const options={authority:readVerification,jobId:verifyJob,head:verifyHead,maxChunks:1,sealing:seal};
const incompleteJob='4'.repeat(32), incompleteHead=await beginSyntheticVerification(bucket,kms,scope,commitment,envelope,signal(),verificationAuthority,incompleteJob,seal);
await assert.rejects(()=>restoreSyntheticArchive(bucket,kms,scope,commitment,envelope,signal(),target,{...options,authority:{}}),/authority required/);
await assert.rejects(()=>restoreSyntheticArchive(bucket,kms,scope,commitment,envelope,signal(),target,{...options,sealing:{...seal,authority:{}}}),/authority required/);
await assert.rejects(()=>restoreSyntheticArchive(bucket,kms,scope,commitment,envelope,signal(),target,{...options,jobId:incompleteJob,head:incompleteHead}),/incomplete/);
await assert.rejects(()=>restoreSyntheticArchive(bucket,kms,scope,commitment,envelope,signal(),target,{...options,head:firstVerifyHead}));
await assert.rejects(()=>restoreSyntheticArchive(bucket,kms,scope,commitment,envelope,signal(),target,{...options,sealing:{...seal,head:firstSealHead}}));
assert.equal(calls,0);
const restored=await restoreSyntheticArchive(bucket,kms,scope,commitment,envelope,signal(),target,options);
assert.equal(restored.complete,true); assert.deepEqual(rows,[content]); assert.equal(checkpoint.complete,true);

// A destination callback can commit before a caller learns that the pinned
// authority changed.  The destination in this test remains private; the
// caller must not treat the failed attempt as permission to activate it.
// Test both authority heads around each callback, including the terminal
// checkpoint. These mutations model rollback or administrative tampering of
// a fake authority, not an operation supported by the real terminal head.
for (const stage of ['begin','apply','finish']) for (const authorityKind of ['sealing','verification']) {
  let saved=null, applied=0, injected=false;
  const changedAuthority=authorityKind==='sealing'?sealingAuthority:verificationAuthority;
  const changedJob=authorityKind==='sealing'?sealJob:verifyJob;
  const oldHead=authorityKind==='sealing'?firstSealHead:firstVerifyHead;
  const terminalHead=authorityKind==='sealing'?sealHead:verifyHead;
  function changeAt(name) {
    if (!injected && stage===name) {
      injected=true;
      changedAuthority.jobs.set(changedJob,structuredClone(oldHead));
    }
  }
  const privateTarget={
    async load(){return structuredClone(saved);},
    async begin(cp){assert.equal(saved,null);saved=structuredClone(cp);changeAt('begin');},
    async apply({expected,next,content:chunk}){
      assert.deepEqual(saved,expected);assert.equal(chunk,content);applied++;
      saved=structuredClone(next);changeAt('apply');
    },
    async finish(cp){assert.deepEqual(saved,cp);saved={...structuredClone(cp),complete:true};changeAt('finish');},
  };
  try {
    const expectedError=authorityKind==='sealing'?/Sealing authority head differs/:/Verification authority head changed; destination requires reconciliation/;
    await assert.rejects(()=>restoreSyntheticArchive(bucket,kms,scope,commitment,envelope,signal(),privateTarget,options),expectedError);
    assert.equal(injected,true);
    assert.equal(saved!==null,true);
    assert.equal(saved.complete,stage==='finish');
  } finally { changedAuthority.jobs.set(changedJob,structuredClone(terminalHead)); }
  const retry=await restoreSyntheticArchive(bucket,kms,scope,commitment,envelope,signal(),privateTarget,options);
  assert.equal(retry.complete,true);
  assert.equal(saved.complete,true);
  assert.equal(applied,1);
}

// A deliberately rewindable fake authority demonstrates the cross-await
// boundary only; real monotonic, independently administered authority and
// nonrollback storage remain mandatory. A mode read triggers the injected
// change after the previous authority observation.
const isMode=key=>key.endsWith('/sealing-mode/0000000000000000');
function changeAtNextMode(authority,job,stale) {
  bucket.onGet=key=>{if(isMode(key)){bucket.onGet=null;authority.jobs.set(job,structuredClone(stale));}};
}
try {
  let calls=0;
  verificationAuthority.afterRead=(job)=>{if(job===verifyJob && ++calls===1) changeAtNextMode(verificationAuthority,verifyJob,firstVerifyHead);};
  await assert.rejects(()=>advanceSyntheticVerification(bucket,kms,scope,commitment,envelope,signal(),verificationAuthority,verifyJob,verifyHead,1,seal),/outcome uncertain; reconciliation required/);
} finally { verificationAuthority.afterRead=null; bucket.onGet=null; verificationAuthority.jobs.set(verifyJob,structuredClone(verifyHead)); }
assert.equal((await advanceSyntheticVerification(bucket,kms,scope,commitment,envelope,signal(),verificationAuthority,verifyJob,verifyHead,1,seal)).complete,true);

let committed;
try {
  verificationAuthority.afterSwap=(job,next)=>{if(job===incompleteJob){committed=structuredClone(next);changeAtNextMode(verificationAuthority,incompleteJob,incompleteHead);}};
  await assert.rejects(()=>advanceSyntheticVerification(bucket,kms,scope,commitment,envelope,signal(),verificationAuthority,incompleteJob,incompleteHead,1,seal),/outcome uncertain; reconciliation required/);
  assert.ok(committed);
} finally { verificationAuthority.afterSwap=null; bucket.onGet=null; if(committed) verificationAuthority.jobs.set(incompleteJob,committed); }
assert.equal((await advanceSyntheticVerification(bucket,kms,scope,commitment,envelope,signal(),verificationAuthority,incompleteJob,committed,1,seal)).head.revision,committed.revision+1);

try {
  let calls=0;
  sealingAuthority.afterRead=(job)=>{if(job===sealJob && ++calls===2) changeAtNextMode(sealingAuthority,sealJob,firstSealHead);};
  await assert.rejects(()=>advanceSyntheticSealing(bucket,kms,scope,commitment,envelope,signal(),sealingAuthority,sealJob,sealHead,1),/outcome uncertain; reconciliation required/);
} finally { sealingAuthority.afterRead=null; bucket.onGet=null; sealingAuthority.jobs.set(sealJob,structuredClone(sealHead)); }
assert.equal((await advanceSyntheticSealing(bucket,kms,scope,commitment,envelope,signal(),sealingAuthority,sealJob,sealHead,1)).complete,true);

try {
  let calls=0;
  verificationAuthority.afterRead=(job)=>{if(job===verifyJob && ++calls===2) changeAtNextMode(verificationAuthority,verifyJob,firstVerifyHead);};
  await assert.rejects(()=>restoreSyntheticArchive(bucket,kms,scope,commitment,envelope,signal(),target,options),/Verification authority head changed; destination requires reconciliation/);
} finally { verificationAuthority.afterRead=null; bucket.onGet=null; verificationAuthority.jobs.set(verifyJob,structuredClone(verifyHead)); }
assert.equal((await restoreSyntheticArchive(bucket,kms,scope,commitment,envelope,signal(),target,options)).complete,true);

// The sealer can change during the final mode read inside verification's
// protection check. The verifier head can remain unchanged, so checking
// only that head cannot detect this distinct stale-sealer observation.
for (const operation of ['verification','restore','authorized-archive']) {
  let reads=0, injected=false;
  try {
    sealingAuthority.afterRead=job=>{
      if(job===sealJob && ++reads===4) {
        bucket.onGet=key=>{if(isMode(key)){bucket.onGet=null;injected=true;sealingAuthority.jobs.set(sealJob,structuredClone(firstSealHead));}};
      }
    };
    const call=operation==='verification'
      ? ()=>advanceSyntheticVerification(bucket,kms,scope,commitment,envelope,signal(),verificationAuthority,verifyJob,verifyHead,1,seal)
      : operation==='restore'
        ? ()=>restoreSyntheticArchive(bucket,kms,scope,commitment,envelope,signal(),target,options)
        : ()=>verifySyntheticAuthorizedArchive(bucket,kms,scope,commitment,envelope,signal(),readSealing,sealJob,sealHead);
    await assert.rejects(call,/authority outcome uncertain; reconciliation required/);
    assert.equal(injected,true);
  } finally { sealingAuthority.afterRead=null; bucket.onGet=null; sealingAuthority.jobs.set(sealJob,structuredClone(sealHead)); }
}
const canceled=new AbortController();
try {
  let reads=0;
  sealingAuthority.afterRead=job=>{if(job===sealJob && ++reads===3) canceled.abort();};
  await assert.rejects(()=>advanceSyntheticVerification(bucket,kms,scope,commitment,envelope,canceled.signal,verificationAuthority,verifyJob,verifyHead,1,seal),/authority outcome uncertain; reconciliation required/);
} finally { sealingAuthority.afterRead=null; }
assert.deepEqual(await verificationAuthority.read(verifyJob),verifyHead);
console.log('Synthetic archive read-only authority contract passed');
