// Focused local input/error boundary test. No owner, Workerd, Woven, AWS, or
// interrupted archive integration harness is used.
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mintSyntheticArchiveKey } from '../worker/synthetic-archive-key-provider.js';
import { archiveSyntheticChunk, sealSyntheticArchive, restoreSyntheticArchive, beginSyntheticVerification } from '../worker/synthetic-relocation-archive.js';

const keyArn = 'arn:aws:kms:us-east-1:646535719915:key/7614cff5-444e-4615-a785-4192dd150c2f';
const runId = 'mapi-p1-syn-20261123T074636Z-bef5970113984cf34aa5c70e9d0a2c9a';
const scope = {keyArn,runId,archiveId:'d'.repeat(32),manifestDigest:'e'.repeat(64)};
const signal = new AbortController().signal;
class Bucket {
  objects = new Map();
  async put(key,value,options) {
    assert.equal(options.onlyIf.get('If-None-Match'),'*');
    if (this.objects.has(key)) return null;
    this.objects.set(key,new Uint8Array(value)); return {key};
  }
  async get(key) {
    const value=this.objects.get(key); if (value===undefined) return null;
    const copy=new Uint8Array(value);
    return {size:copy.length,body:new ReadableStream({start(controller){controller.enqueue(copy);controller.close();}})};
  }
  async list({prefix,limit,cursor}) {
    const keys=[...this.objects.keys()].filter(key=>key.startsWith(prefix)).sort();
    const start=cursor?Number(cursor):0, objects=keys.slice(start,start+limit).map(key=>({key})), end=start+objects.length;
    return {objects,truncated:end<keys.length,...(end<keys.length?{cursor:String(end)}:{})};
  }
}
class KMS {
  keys = new Map();
  async generateDataKey() {
    const raw=new Uint8Array(randomBytes(32)), wrapped=new Uint8Array(randomBytes(32));
    this.keys.set(wrapped.toBase64(),new Uint8Array(raw));
    return {KeyId:keyArn,Plaintext:raw,CiphertextBlob:wrapped};
  }
  async decrypt(request) {
    const raw=this.keys.get(request.CiphertextBlob.toBase64());
    if (!raw) throw Error('key unavailable');
    return {KeyId:keyArn,Plaintext:new Uint8Array(raw)};
  }
}
const bucket=new Bucket(), kms=new KMS(), marker='SECRETX';
const valid=JSON.stringify({projectId:'p',generation:1,moveId:'m',index:0,prev:'',table:'users',columns:['id'],offset:0,rows:[['u']],last:true,done:true,cursor:null});
const commitment={projectId:'p',origin:'https://p.invalid',objectName:'source',generation:1,moveId:'m',manifestDigest:scope.manifestDigest,tables:['users'],chunkCount:1,finalDigest:createHash('sha256').update(valid).digest('hex')};
const envelope=(await mintSyntheticArchiveKey(bucket,kms,scope,signal)).provisionalEnvelopeDigest;
const rejectWithoutPayload = (operation, expected) => assert.rejects(operation, error => {
  assert.equal(error.message,expected);
  assert.equal(String(error.stack).includes(marker),false);
  return true;
});
const normalGet=bucket.get.bind(bucket);
bucket.get=async()=>{throw Error(marker);};
await rejectWithoutPayload(() => archiveSyntheticChunk(bucket,kms,scope,commitment,envelope,0,valid,signal),'Archive storage unavailable');
bucket.get=async()=>({size:1,body:{getReader(){throw Error(marker);}}});
await rejectWithoutPayload(() => archiveSyntheticChunk(bucket,kms,scope,commitment,envelope,0,valid,signal),'Archive storage unavailable');
bucket.get=async()=>({size:1,body:new ReadableStream({pull(controller){controller.error(Error(marker));}})});
await rejectWithoutPayload(() => archiveSyntheticChunk(bucket,kms,scope,commitment,envelope,0,valid,signal),'Archive storage unavailable');
let started, release, startedResolve;
started=new Promise(resolve=>{startedResolve=resolve;});
bucket.get=async()=>{startedResolve();return new Promise(resolve=>{release=resolve;});};
const cancellation=new AbortController();
const pending=archiveSyntheticChunk(bucket,kms,scope,commitment,envelope,0,valid,cancellation.signal);
await started; cancellation.abort();
await rejectWithoutPayload(() => pending,'Archive operation canceled');
release(null); bucket.get=normalGet;
await rejectWithoutPayload(() => archiveSyntheticChunk(bucket,kms,scope,commitment,envelope,0,marker,signal),'Invalid archive source chunk');
await archiveSyntheticChunk(bucket,kms,scope,commitment,envelope,0,valid,signal);
const selector=[...bucket.objects.keys()].find(key=>key.endsWith('/part-selector/0000000000000000'));
assert.ok(selector);
const validSelector=bucket.objects.get(selector);
bucket.objects.set(selector,new TextEncoder().encode(marker));
await rejectWithoutPayload(() => archiveSyntheticChunk(bucket,kms,scope,commitment,envelope,0,valid,signal),'Invalid archive record');
bucket.objects.set(selector,new Uint8Array([0xff,0xfe]));
await rejectWithoutPayload(() => archiveSyntheticChunk(bucket,kms,scope,commitment,envelope,0,valid,signal),'Invalid archive record');
bucket.objects.set(selector,validSelector);
const normalList=bucket.list.bind(bucket);
bucket.list=async()=>{throw Error(marker);};
await rejectWithoutPayload(() => sealSyntheticArchive(bucket,kms,scope,commitment,envelope,signal),'Archive storage unavailable');
bucket.list=normalList;
await sealSyntheticArchive(bucket,kms,scope,commitment,envelope,signal);
const unavailableAuthority={async read(){throw Error(marker);},async create(){},async compareAndSwap(){}};
await rejectWithoutPayload(() => beginSyntheticVerification(bucket,kms,scope,commitment,envelope,signal,unavailableAuthority,'9'.repeat(32)),'Archive authority unavailable');

for (const stage of ['begin','apply','finish']) {
  let checkpoint=null, injected=false, applied=0;
  const target={
    async load(){return structuredClone(checkpoint);},
    async begin(cp){checkpoint=structuredClone(cp); if(stage==='begin' && !injected){injected=true;throw Error(marker);}},
    async apply({expected,next}){assert.deepEqual(checkpoint,expected);applied++;checkpoint=structuredClone(next);if(stage==='apply' && !injected){injected=true;throw Error(marker);}},
    async finish(cp){assert.deepEqual(checkpoint,cp);checkpoint={...structuredClone(cp),complete:true};if(stage==='finish' && !injected){injected=true;throw Error(marker);}},
  };
  await rejectWithoutPayload(() => restoreSyntheticArchive(bucket,kms,scope,commitment,envelope,signal,target),'Archive destination outcome uncertain; reconciliation required');
  assert.equal(injected,true);
  const result=await restoreSyntheticArchive(bucket,kms,scope,commitment,envelope,signal,target);
  assert.equal(result.chunkCount,1);
  assert.equal(checkpoint.complete,true);
  assert.equal(applied,1);
}
const unavailable={async load(){throw Error(marker);},async begin(){},async apply(){},async finish(){}};
await rejectWithoutPayload(() => restoreSyntheticArchive(bucket,kms,scope,commitment,envelope,signal,unavailable),'Archive destination unavailable');
// Do not reveal a destination read failure when cancellation wins while
// load() is in flight. This does not race or cancel the underlying callback.
let notifyLoad, rejectLoad;
const loadStarted = new Promise(resolve => { notifyLoad = resolve; });
const cancellableRead = {
  async load() { notifyLoad(); return new Promise((_, reject) => { rejectLoad = reject; }); },
  async begin(){},async apply(){},async finish(){},
};
const readAbort = new AbortController();
const waitingRead = restoreSyntheticArchive(bucket,kms,scope,commitment,envelope,readAbort.signal,cancellableRead);
await loadStarted;
readAbort.abort();
rejectLoad(Error(marker));
await rejectWithoutPayload(() => waitingRead,'Archive operation canceled');
console.log('Archive parse error redaction passed');
