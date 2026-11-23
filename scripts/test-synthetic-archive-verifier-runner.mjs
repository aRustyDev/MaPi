// Distinct synthetic verifier-runner check. No target importer, Workerd
// combined harness, hosted resource, scale fixture, Woven or AWS access.
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mintSyntheticArchiveKey } from '../worker/synthetic-archive-key-provider.js';
import { archiveSyntheticChunk, beginSyntheticSealing, advanceSyntheticSealing } from '../worker/synthetic-relocation-archive.js';
import { advanceConfiguredSyntheticVerifier } from '../worker/synthetic-archive-verifier-runner.js';

const sha = value => createHash('sha256').update(value).digest('hex');
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
  jobs=new Map(); loseCreate=false; loseSwap=false;
  async read(job) { return structuredClone(this.jobs.get(job)??null); }
  async create(job,head) {
    if(this.jobs.has(job)) throw Error('conflict');
    this.jobs.set(job,structuredClone(head));
    if(this.loseCreate) { this.loseCreate=false; throw Error('lost acknowledgement'); }
  }
  async compareAndSwap(job,expected,next) {
    assert.deepEqual(this.jobs.get(job),expected);
    if(expected.terminal) throw Error('terminal');
    this.jobs.set(job,structuredClone(next));
    if(this.loseSwap) { this.loseSwap=false; throw Error('lost acknowledgement'); }
  }
}

const bucket=new Bucket(), kms=new KMS(), sealing=new Authority(), verification=new Authority();
const scope={keyArn,runId,archiveId:'a'.repeat(32),manifestDigest:'b'.repeat(64)};
const first=JSON.stringify({projectId:'p',generation:1,moveId:'move',index:0,prev:'',table:'users',columns:['id'],offset:0,rows:[['u1']],last:false,done:false,cursor:null});
const second=JSON.stringify({projectId:'p',generation:1,moveId:'move',index:1,prev:sha(first),table:'users',columns:['id'],offset:1,rows:[['u2']],last:true,done:true,cursor:null});
const commitment={projectId:'p',origin:'https://p.example',objectName:'source',generation:1,moveId:'move',manifestDigest:scope.manifestDigest,tables:['users'],chunkCount:2,finalDigest:sha(second)};
const envelopeDigest=(await mintSyntheticArchiveKey(bucket,kms,scope,signal())).provisionalEnvelopeDigest;
await archiveSyntheticChunk(bucket,kms,scope,commitment,envelopeDigest,0,first,signal());
await archiveSyntheticChunk(bucket,kms,scope,commitment,envelopeDigest,1,second,signal());
const sealingJobId='1'.repeat(32), verificationJobId='2'.repeat(32);
const config={scope,commitment,envelopeDigest,sealingJobId,verificationJobId};
const badSignal=new AbortController(); badSignal.abort();
await assert.rejects(()=>advanceConfiguredSyntheticVerifier(config,bucket,kms,sealing,verification,badSignal.signal),/Archive verifier canceled/);
await assert.rejects(()=>advanceConfiguredSyntheticVerifier(config,bucket,kms,{read:async()=>{throw Error('synthetic-private-marker');}},verification,signal()),error=>{
  assert.equal(error.message,'Archive authority unavailable');
  assert.equal(error.cause,undefined); assert.equal(String(error.stack).includes('synthetic-private-marker'),false); return true;
});
await assert.rejects(()=>advanceConfiguredSyntheticVerifier(config,bucket,kms,sealing,verification,signal()),/Sealing authorization incomplete/);
assert.equal(verification.jobs.size,0);
// Cancellation while an initial read is stalled must not create an authority
// head; a late rejected RPC must be consumed without an unhandled rejection.
let unblockInitial, initialEntered;
const initialPending = new Promise((_, reject) => { unblockInitial = reject; });
const initialStarted = new Promise(resolve => { initialEntered = resolve; });
const initialController = new AbortController();
const stalledInitial = { read() { initialEntered(); return initialPending; },
  create: (...args) => sealing.create(...args), compareAndSwap: (...args) => sealing.compareAndSwap(...args) };
const initialRun = beginSyntheticSealing(bucket,kms,scope,commitment,envelopeDigest,initialController.signal,stalledInitial,sealingJobId);
await initialStarted;
initialController.abort();
await assert.rejects(initialRun, /Archive operation canceled/);
assert.equal(sealing.jobs.size,0);
unblockInitial(Error('late private authority error'));
await new Promise(resolve => setImmediate(resolve));

// If create has committed, cancellation while its readback is stalled cannot
// assert rollback. The persisted head is recovered independently and resumed.
let unblockReadback, readbackEntered, created=false;
const readbackPending = new Promise((_, reject) => { unblockReadback = reject; });
const readbackStarted = new Promise(resolve => { readbackEntered = resolve; });
const readbackController = new AbortController();
const stalledReadback = {
  read: (...args) => { if (created) { readbackEntered(); return readbackPending; } return sealing.read(...args); },
  create: async (...args) => { await sealing.create(...args); created=true; },
  compareAndSwap: (...args) => sealing.compareAndSwap(...args),
};
const createRun = beginSyntheticSealing(bucket,kms,scope,commitment,envelopeDigest,readbackController.signal,stalledReadback,sealingJobId);
await readbackStarted;
readbackController.abort();
await assert.rejects(createRun, /Verification authority outcome uncertain/);
assert.equal(sealing.jobs.size,1);
unblockReadback(Error('late private authority error'));
await new Promise(resolve => setImmediate(resolve));
let head=await sealing.read(sealingJobId);
let sealed;
for(let i=0;i<12 && !sealed?.complete;i++) {
  sealed=await advanceSyntheticSealing(bucket,kms,scope,commitment,envelopeDigest,signal(),sealing,sealingJobId,head,1);
  head=sealed.head;
}
assert.equal(sealed.complete,true);
await assert.rejects(()=>advanceConfiguredSyntheticVerifier(config,bucket,kms,sealing,{read:async()=>{throw Error('synthetic-private-marker');},create:async()=>{},compareAndSwap:async()=>{}},signal()),error=>{
  assert.equal(error.message,'Archive authority unavailable');
  assert.equal(error.cause,undefined); assert.equal(String(error.stack).includes('synthetic-private-marker'),false); return true;
});

// A committed but unacknowledged create is resolved by authoritative readback.
verification.loseCreate=true;
const firstStep=advanceConfiguredSyntheticVerifier(config,bucket,kms,sealing,verification,signal());
commitment.projectId='other'; // The running step retains its privileged snapshot.
const started=await firstStep;
commitment.projectId='p';
assert.equal(started.complete,false);
verification.loseSwap=true;
let result;
for(let i=0;i<12 && !result?.complete;i++) result=await advanceConfiguredSyntheticVerifier(config,bucket,kms,sealing,verification,signal());
assert.equal(result.complete,true);
assert.equal((await advanceConfiguredSyntheticVerifier(config,bucket,kms,sealing,verification,signal())).complete,true);
assert.equal(verification.jobs.size,1);

const foreign={...config,commitment:{...commitment,projectId:'foreign'}};
await assert.rejects(()=>advanceConfiguredSyntheticVerifier(foreign,bucket,kms,sealing,verification,signal()));
assert.equal((await verification.read(verificationJobId)).terminal,true);
console.log('Synthetic configured archive verifier runner passed');
