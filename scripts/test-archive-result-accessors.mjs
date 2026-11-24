// Local synthetic adapter boundary regression. This does not exercise the
// interrupted combined archive test, a real owner, AWS, or Woven.
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mintSyntheticArchiveKey } from '../worker/synthetic-archive-key-provider.js';
import { archiveSyntheticChunk, sealSyntheticArchive } from '../worker/synthetic-relocation-archive.js';

const keyArn='arn:aws:kms:us-east-1:646535719915:key/7614cff5-444e-4615-a785-4192dd150c2f';
const runId='mapi-p1-syn-20261123T074636Z-bef5970113984cf34aa5c70e9d0a2c9a';
const scope={keyArn,runId,archiveId:'c'.repeat(32),manifestDigest:'d'.repeat(64)};
const signal=new AbortController().signal;
class Bucket {
  objects=new Map();
  async put(key,value,options) {
    assert.equal(options.onlyIf.get('If-None-Match'),'*');
    if(this.objects.has(key))return null;
    this.objects.set(key,new Uint8Array(value));return {key};
  }
  async get(key) {
    const value=this.objects.get(key);if(value===undefined)return null;
    const copy=new Uint8Array(value);
    return {size:copy.length,body:new ReadableStream({start(c){c.enqueue(copy);c.close();}})};
  }
  async list({prefix,limit,cursor}) {
    const keys=[...this.objects.keys()].filter(k=>k.startsWith(prefix)).sort();
    const start=cursor?Number(cursor):0, objects=keys.slice(start,start+limit).map(key=>({key}));
    const end=start+objects.length;
    return {objects,truncated:end<keys.length,...(end<keys.length?{cursor:String(end)}:{})};
  }
}
class KMS {
  keys=new Map();
  async generateDataKey(){const raw=new Uint8Array(randomBytes(32)),wrapped=new Uint8Array(randomBytes(32));this.keys.set(wrapped.toBase64(),new Uint8Array(raw));return {KeyId:keyArn,Plaintext:raw,CiphertextBlob:wrapped};}
  async decrypt(r){const raw=this.keys.get(r.CiphertextBlob.toBase64());if(!raw)throw Error('key unavailable');return {KeyId:keyArn,Plaintext:new Uint8Array(raw)};}
}
const bucket=new Bucket(),kms=new KMS(),marker='SECRET_ADAPTER_MARKER';
const valid=JSON.stringify({projectId:'p',generation:1,moveId:'m',index:0,prev:'',table:'users',columns:['id'],offset:0,rows:[['u']],last:true,done:true,cursor:null});
const commitment={projectId:'p',origin:'https://p.invalid',objectName:'source',generation:1,moveId:'m',manifestDigest:scope.manifestDigest,tables:['users'],chunkCount:1,finalDigest:createHash('sha256').update(valid).digest('hex')};
const envelope=(await mintSyntheticArchiveKey(bucket,kms,scope,signal)).provisionalEnvelopeDigest;
await archiveSyntheticChunk(bucket,kms,scope,commitment,envelope,0,valid,signal);
const normalGet=bucket.get.bind(bucket), normalList=bucket.list.bind(bucket);
const selector=[...bucket.objects.keys()].find(k=>k.endsWith('/chunk-selector/0000000000000000'));
assert.ok(selector);
const rejectSafe=(operation,message)=>assert.rejects(operation,error=>{
  assert.equal(error.message,message);
  assert.equal(String(error.stack).includes(marker),false);
  assert.equal(error.cause,undefined);
  return true;
});

function streamResult(resultFactory,size=1) {
  let canceled=false;
  const object={size,body:{getReader(){return {async read(){return resultFactory();},cancel(){canceled=true;},releaseLock(){}};}}};
  return {object,wasCanceled:()=>canceled};
}
for(const name of ['done','value']) {
  const r=name==='done'?{get done(){throw Error(marker);}}:{done:false,get value(){throw Error(marker);}};
  const stream=streamResult(()=>r);
  bucket.get=async key=>key===selector?stream.object:normalGet(key);
  await rejectSafe(()=>archiveSyntheticChunk(bucket,kms,scope,commitment,envelope,0,valid,signal),'Archive storage unavailable');
  assert.equal(stream.wasCanceled(),true);
}
const malformed=streamResult(()=>({done:'true'}));
bucket.get=async key=>key===selector?malformed.object:normalGet(key);
await rejectSafe(()=>archiveSyntheticChunk(bucket,kms,scope,commitment,envelope,0,valid,signal),'Invalid archive record');
assert.equal(malformed.wasCanceled(),true);

// A typed array can shadow its `length`; count the actual backing view bytes.
const selectorBytes=new Uint8Array(bucket.objects.get(selector));
Object.defineProperty(selectorBytes,'length',{value:0});
bucket.get=async key=>{
  if(key!==selector)return normalGet(key);
  let emitted=false;
  return streamResult(()=>emitted?{done:true}:(emitted=true,{done:false,value:selectorBytes}),selectorBytes.byteLength).object;
};
assert.equal((await archiveSyntheticChunk(bucket,kms,scope,commitment,envelope,0,valid,signal)).digest,commitment.finalDigest);
bucket.get=normalGet;

for(const page of [
  {get objects(){throw Error(marker);}},
  {objects:[],get truncated(){throw Error(marker);}},
  {objects:[{get key(){throw Error(marker);}}],truncated:false},
  {objects:[],truncated:true,get cursor(){throw Error(marker);}},
]) {
  bucket.list=async()=>page;
  await rejectSafe(()=>sealSyntheticArchive(bucket,kms,scope,commitment,envelope,signal),'Invalid archive inventory');
}
// Reject a selector-sized prefix with an oversized key before deriving the
// fixed-width suffix. This is an adapter-boundary check, not an R2 limit test.
bucket.list=async({prefix})=>({objects:[{key:prefix+'0'.repeat(131077)}],truncated:false});
await rejectSafe(()=>sealSyntheticArchive(bucket,kms,scope,commitment,envelope,signal),'Unexpected archive selector');
bucket.list=normalList;
await sealSyntheticArchive(bucket,kms,scope,commitment,envelope,signal);
console.log('Synthetic archive result accessor checks passed');
