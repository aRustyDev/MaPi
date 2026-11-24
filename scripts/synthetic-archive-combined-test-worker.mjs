export { SyntheticArchiveStagedDestination } from './synthetic-archive-staged-destination.mjs';
import { mintSyntheticArchiveKey } from '../worker/synthetic-archive-key-provider.js';
import { SyntheticArchiveAuthority } from '../worker/synthetic-archive-authority.js';
import { archiveSyntheticChunk, sealSyntheticArchive, verifySyntheticArchive, restoreSyntheticArchive, beginSyntheticVerification, advanceSyntheticVerification, beginSyntheticSealing, advanceSyntheticSealing } from '../worker/synthetic-relocation-archive.js';
// Eviction is a local fixture capability, never exposed by the real class.
export class LocalArchiveAuthority extends SyntheticArchiveAuthority {
  evict() { this.ctx.abort('synthetic authority restart'); }
}
const enc=new TextEncoder();
async function hash(s) { return [...new Uint8Array(await crypto.subtle.digest('SHA-256',enc.encode(s)))].map(v=>v.toString(16).padStart(2,'0')).join(''); }
function check(v,m) { if (!v) throw Error(m); }
async function reject(f,m) { try { await f(); } catch { return; } throw Error(m); }
const keyArn='arn:aws:kms:us-east-1:646535719915:key/7614cff5-444e-4615-a785-4192dd150c2f';
const runId='mapi-p1-syn-20261123T074636Z-bef5970113984cf34aa5c70e9d0a2c9a';
const kms={async generateDataKey(input) { return {KeyId:input.KeyId,Plaintext:new Uint8Array(32).fill(7),CiphertextBlob:new Uint8Array([3,4,5])}; },async decrypt(input) { if (input.CiphertextBlob.toBase64()!=='AwQF') throw Error('Unknown fake KMS ciphertext'); return {KeyId:input.KeyId,Plaintext:new Uint8Array(32).fill(7)}; }};
async function fixture(env, name, archiveId) {
  const scope={keyArn,runId,archiveId,manifestDigest:'b'.repeat(64)}, signal=AbortSignal.timeout(30000);
  const readCounts=new Map();
  const bucket={get(key) { readCounts.set(key,(readCounts.get(key)||0)+1); return env.ARCHIVE.get(key); },put(...args) { return env.ARCHIVE.put(...args); },list(...args) { return env.ARCHIVE.list(...args); }};
  const {provisionalEnvelopeDigest:envelopeDigest}=await mintSyntheticArchiveKey(bucket,kms,scope,signal);
  const p0={projectId:name,generation:1,moveId:'move',index:0,prev:'',table:'users',columns:['id','name'],offset:0,rows:[['u1','Alice'],['u2','Bob']],last:true,done:false,cursor:['u2']};
  const content0=JSON.stringify(p0),digest0=await hash(content0);
  const p1={projectId:name,generation:1,moveId:'move',index:1,prev:digest0,table:'events',columns:['id','payload'],offset:0,rows:[[{integer:'-9223372036854775808'},'audit one'],[{integer:'9223372036854775807'},'audit two']],last:true,done:true,cursor:[{integer:'9223372036854775807'}]};
  const content1=JSON.stringify(p1),digest1=await hash(content1);
  const commitment={projectId:name,origin:'https://synthetic.invalid',objectName:'source',generation:1,moveId:'move',manifestDigest:scope.manifestDigest,tables:['users','events'],chunkCount:2,finalDigest:digest1};
  await archiveSyntheticChunk(bucket,kms,scope,commitment,envelopeDigest,0,content0,signal);
  await archiveSyntheticChunk(bucket,kms,scope,commitment,envelopeDigest,1,content1,signal);
  await sealSyntheticArchive(bucket,kms,scope,commitment,envelopeDigest,signal);
  const verified=await verifySyntheticArchive(bucket,kms,scope,commitment,envelopeDigest,signal);
  const jobId=(name==='synthetic-a'?'3':'4').repeat(32);
  let authorityHead=null;
  const authority={async read(id) { check(id===jobId,'wrong authority scope'); return authorityHead===null?null:JSON.parse(JSON.stringify(authorityHead)); },
    async create(id,next) { check(id===jobId && authorityHead===null && next.revision===0 && next.parentDigest==='','invalid authority create'); authorityHead=JSON.parse(JSON.stringify(next)); },
    async compareAndSwap(id,previous,next) { check(id===jobId && JSON.stringify(previous)===JSON.stringify(authorityHead) && next.revision===previous.revision+1 && next.parentDigest===await hash(JSON.stringify(previous)),'invalid authority CAS'); authorityHead=JSON.parse(JSON.stringify(next)); }};
  let head=await beginSyntheticVerification(bucket,kms,scope,commitment,envelopeDigest,signal,authority,jobId), progress;
  for (let step=0;step<10;step++) { progress=await advanceSyntheticVerification(bucket,kms,scope,commitment,envelopeDigest,signal,authority,jobId,head,1); head=progress.head; if (progress.complete) break; }
  check(progress?.complete,'verification did not complete');
  const verification={authority,jobId,head,maxChunks:1};
  let target=env.TARGET.getByName(name);
  await target.initializeFixture({scope,commitment,envelopeDigest,destinationName:`destination-${name}`});
  const originalHead=authorityHead; authorityHead={...head,revision:head.revision+1};
  await reject(()=>restoreSyntheticArchive(bucket,kms,scope,commitment,envelopeDigest,signal,target,verification),'changed head accepted by fresh target');
  check(await target.load()===null,'invalid authority initialized destination');
  authorityHead=originalHead;
  readCounts.clear();
  if (name==='synthetic-a') {
    const savedHead=authorityHead;
    const changedDuringApply={load:()=>target.load(),begin:cp=>target.begin(cp),finish:cp=>target.finish(cp),async apply(step) { await target.apply(step); authorityHead={...head,revision:head.revision+1}; }};
    await reject(()=>restoreSyntheticArchive(bucket,kms,scope,commitment,envelopeDigest,signal,changedDuringApply,verification),'mid-dispatch authority change accepted');
    const changed=await target.fixtureState();
    check(changed.checkpoint.next===1 && changed.checkpoint.complete===false && changed.importer.done===0 && changed.users.length===2 && changed.events.length===0,'mid-dispatch write or inaccessible staged state differs');
    check(changed.checkpoint.verificationHeadDigest===await hash(JSON.stringify(head)),'checkpoint is not bound to verifier head');
    const initialReads=[...readCounts.entries()].filter(([k])=>k.includes('/chunk-selector/')).map(([k,n])=>[k.slice(-16),n]);
    check(JSON.stringify(initialReads)===JSON.stringify([['0000000000000000',1]]),'verified restore unexpectedly rescanned');
    authorityHead=savedHead; // Test-only reconciliation of the mock authority; not an operational rollback protocol.
    await target.abortAfterNextImport();
    await reject(()=>restoreSyntheticArchive(bucket,kms,scope,commitment,envelopeDigest,signal,target,verification),'expected importer interruption');
    target=env.TARGET.getByName(name);
    const partial=await target.fixtureState();
    check(partial.checkpoint.next===1 && partial.importer.next_chunk===2 && partial.users.length===2 && partial.events.length===2 && partial.inserts.every(x=>x.count===2),'interruption did not preserve checkpoint');
    authorityHead={...head,revision:head.revision+1};
    await reject(()=>restoreSyntheticArchive(bucket,kms,scope,commitment,envelopeDigest,signal,target,verification),'changed head accepted');
    const afterMismatch=await target.fixtureState();
    check(JSON.stringify(afterMismatch)===JSON.stringify(partial),'authority mismatch changed destination');
    authorityHead=savedHead;
  } else {
    const first=await restoreSyntheticArchive(bucket,kms,scope,commitment,envelopeDigest,signal,target,verification);
    check(first.complete===false && first.next===1,'bounded restore did not pause after one chunk');
    const firstState=await target.fixtureState();
    check(firstState.checkpoint.next===1 && firstState.users.length===2 && firstState.events.length===0,'bounded progress differs');
  }
  readCounts.clear();
  const restored=await restoreSyntheticArchive(bucket,kms,scope,commitment,envelopeDigest,signal,target,verification);
  const selectors=[...readCounts.entries()].filter(([k])=>k.includes('/chunk-selector/')).map(([k,n])=>[k.slice(-16),n]);
  if (name==='synthetic-a') check(JSON.stringify(selectors)===JSON.stringify([['0000000000000001',1]]),'resume re-scanned earlier chunks');
  const state=await target.fixtureState();
  check(state.checkpoint.verificationHeadDigest===await hash(JSON.stringify(head)),'completion head binding differs');
  check(state.checkpoint.complete && state.users.length===2 && state.users[0].name==='Alice' && state.users[1].name==='Bob','users differ');
  check(JSON.stringify(state.events)===JSON.stringify([{id:'-9223372036854775808',payload:'audit one'},{id:'9223372036854775807',payload:'audit two'}]),'audit events differ');
  check(JSON.stringify(state.inserts)===JSON.stringify([{kind:'event',count:2},{kind:'user',count:2}]),'committed rows reinserted');
  check(restored.inventoryDigest===verified.inventoryDigest && restored.finalDigest===digest1,'archive commitment differs');
  return {project:name,users:state.users.length,events:state.events.length,selectorReadsAfterResume:selectors};
}
async function durableAuthorityFixture(env) {
  const name='synthetic-durable', scope={keyArn,runId,archiveId:'5'.repeat(32),manifestDigest:'b'.repeat(64)}, signal=AbortSignal.timeout(30000);
  const bucket=env.ARCHIVE, {provisionalEnvelopeDigest:envelope}=await mintSyntheticArchiveKey(bucket,kms,scope,signal);
  const first=JSON.stringify({projectId:name,generation:1,moveId:'move',index:0,prev:'',table:'users',columns:['id','name'],offset:0,rows:[['u1','Alice']],last:true,done:false,cursor:['u1']});
  const firstDigest=await hash(first);
  const second=JSON.stringify({projectId:name,generation:1,moveId:'move',index:1,prev:firstDigest,table:'events',columns:['id','payload'],offset:0,rows:[[{integer:'42'},'audit']],last:true,done:true,cursor:[{integer:'42'}]});
  const commitment={projectId:name,origin:'https://synthetic.invalid',objectName:'source',generation:1,moveId:'move',manifestDigest:scope.manifestDigest,tables:['users','events'],chunkCount:2,finalDigest:await hash(second)};
  await archiveSyntheticChunk(bucket,kms,scope,commitment,envelope,0,first,signal);
  await archiveSyntheticChunk(bucket,kms,scope,commitment,envelope,1,second,signal);
  const sealJob='6'.repeat(32), verifyJob='7'.repeat(32);
  const identity=[1,scope.runId,scope.archiveId,envelope,commitment.projectId,commitment.origin,commitment.objectName,commitment.generation,commitment.moveId,commitment.manifestDigest,commitment.tables,commitment.chunkCount,commitment.finalDigest];
  const sealingIdentityDigest=await hash(JSON.stringify(['mapi-archive-sealing-identity-v1',...identity]));
  const verificationIdentityDigest=await hash(JSON.stringify(['mapi-archive-restore-identity-v1',...identity]));
  const basePolicyDigest=await hash(JSON.stringify({scope,commitment,envelopeDigest:envelope,sealingJobId:sealJob}));
  const policyDigest=await hash(JSON.stringify(['mapi-synthetic-verifier-policy-v1',basePolicyDigest,verifyJob,verificationIdentityDigest]));
  const authorityName=`mapi-synthetic-authority-v1/${scope.archiveId}`;
  let authority=env.ARCHIVE_AUTH.getByName(authorityName);
  await authority.initialize({archiveId:scope.archiveId,sealingIdentityDigest,verificationIdentityDigest,basePolicyDigest,sealingJobId:sealJob});
  await authority.registerVerification(verifyJob,policyDigest);
  let sealHead=await beginSyntheticSealing(bucket,kms,scope,commitment,envelope,signal,authority,sealJob), sealed;
  for(let i=0;i<20;i++) { sealed=await advanceSyntheticSealing(bucket,kms,scope,commitment,envelope,signal,authority,sealJob,sealHead,1); sealHead=sealed.head; if(sealed.complete) break; }
  check(sealed?.complete,'durable sealing did not complete');
  const sealing={authority,jobId:sealJob,head:sealHead};
  let head=await beginSyntheticVerification(bucket,kms,scope,commitment,envelope,signal,authority,verifyJob,sealing), verified;
  for(let i=0;i<20;i++) { verified=await advanceSyntheticVerification(bucket,kms,scope,commitment,envelope,signal,authority,verifyJob,head,1,sealing); head=verified.head; if(verified.complete) break; }
  check(verified?.complete,'durable full-history verification did not complete');
  await reject(()=>authority.compareAndSwap(verifyJob,head,{...head,revision:head.revision+1}),'terminal authority accepted mutation');
  await reject(()=>authority.evict(),'authority eviction did not interrupt');
  authority=env.ARCHIVE_AUTH.getByName(authorityName);
  check(JSON.stringify(await authority.read(verifyJob))===JSON.stringify(head),'terminal verifier head lost after eviction');
  const readOnly={read:job=>authority.read(job)}, recoverySealing={authority:readOnly,jobId:sealJob,head:sealHead};
  const target=env.TARGET.getByName(name);
  await target.initializeFixture({scope,commitment,envelopeDigest:envelope,destinationName:`destination-${name}`});
  const options={authority:readOnly,jobId:verifyJob,head,maxChunks:1,sealing:recoverySealing};
  const partial=await restoreSyntheticArchive(bucket,kms,scope,commitment,envelope,signal,target,options);
  check(!partial.complete && partial.next===1,'durable authority restore did not pause');
  const complete=await restoreSyntheticArchive(bucket,kms,scope,commitment,envelope,signal,target,options), state=await target.fixtureState();
  check(complete.complete && state.checkpoint.complete && JSON.stringify(state.users)===JSON.stringify([{id:'u1',name:'Alice'}]) && JSON.stringify(state.events)===JSON.stringify([{id:'42',payload:'audit'}]),'durable authority restore differs');
  return {project:name,users:state.users.length,events:state.events.length,authority:'local durable object'};
}
export default {async fetch(req,env) { try { const results=await Promise.all([fixture(env,'synthetic-a','1'.repeat(32)),fixture(env,'synthetic-b','2'.repeat(32)),durableAuthorityFixture(env)]); return Response.json({ok:true,results}); } catch(error) { return Response.json({ok:false,error:String(error?.stack||error)},{status:500}); } }};
