// Isolated authority-capability test. It does not invoke the archive writer,
// importer, Woven, AWS, or any previously interrupted combined test.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

const sha = value => createHash('sha256').update(value).digest('hex');
const gateway = await readFile('worker/synthetic-archive-gateway.js', 'utf8');
const authority = await readFile('worker/synthetic-archive-authority.js', 'utf8');
const verifierRunner = await readFile('worker/synthetic-archive-verifier-runner.js', 'utf8');
const archive = await readFile('worker/synthetic-relocation-archive.js', 'utf8');
const objectStore = await readFile('worker/archive-object-store.js', 'utf8');
const keyProvider = await readFile('worker/synthetic-archive-key-provider.js', 'utf8');
const root = await mkdtemp(path.join(tmpdir(), 'mapi-authority-gateway-'));
const keyArn = 'arn:aws:kms:us-east-1:646535719915:key/7614cff5-444e-4615-a785-4192dd150c2f';
const runId = 'mapi-p1-syn-20261123T074636Z-bef5970113984cf34aa5c70e9d0a2c9a';
function policy(archiveId, projectId) {
  return {
    scope:{keyArn,runId,archiveId,manifestDigest:'b'.repeat(64)},
    commitment:{projectId,origin:'https://synthetic.example',objectName:'synthetic-source',generation:1,moveId:'synthetic-move',manifestDigest:'b'.repeat(64),tables:['users','events'],chunkCount:2,finalDigest:'c'.repeat(64)},
    envelopeDigest:'d'.repeat(64),sealingJobId:'1'.repeat(32),verificationJobId:'2'.repeat(32),
  };
}
function identity(p) {
  const s=p.scope,c=p.commitment;
  return [1,s.runId,s.archiveId,p.envelopeDigest,c.projectId,c.origin,c.objectName,c.generation,c.moveId,c.manifestDigest,c.tables,c.chunkCount,c.finalDigest];
}
const sealIdentity = p => sha(JSON.stringify(['mapi-archive-sealing-identity-v1',...identity(p)]));
const verifyIdentity = p => sha(JSON.stringify(['mapi-archive-restore-identity-v1',...identity(p)]));
const sealing = (p,revision,parentDigest,terminal,nonce) => ({version:1,jobId:p.sealingJobId,identityDigest:sealIdentity(p),revision,parentDigest,terminal,role:`sealing-${p.sealingJobId}-${nonce.repeat(32)}`,digest:'e'.repeat(64),recordDigest:'f'.repeat(64)});
const verification = (p,revision,parentDigest,terminal,nonce,sealingHeadDigest) => ({version:2,jobId:p.verificationJobId,identityDigest:verifyIdentity(p),sealDigest:'3'.repeat(64),revision,parentDigest,terminal,role:`verify-${p.verificationJobId}-${nonce.repeat(32)}`,digest:'4'.repeat(64),recordDigest:'5'.repeat(64),sealingHeadDigest});
const p1=policy('a'.repeat(32),'project-one'), p2=policy('6'.repeat(32),'project-two');
const callerModule = `export default { async fetch(request,env) {
  try {
    const {method,args}=await request.json();
    const value=await env.CAP[method](...args);
    return Response.json({ok:true,value});
  } catch(error) { return Response.json({ok:false,error:String(error?.message??error).slice(0,200)}); }
} };`;
function gatewayWorker(name, p, policyText=JSON.stringify(p), policyDigest=sha(policyText), externalScript) {
  return {name,compatibilityDate:'2026-11-19',modules:[
    {type:'ESModule',path:'gateway.mjs',contents:gateway.replace("'./synthetic-archive-authority.js'", "'./authority.mjs'")},
    {type:'ESModule',path:'authority.mjs',contents:authority},
    {type:'ESModule',path:'synthetic-archive-verifier-runner.js',contents:verifierRunner},
    {type:'ESModule',path:'synthetic-relocation-archive.js',contents:archive},
    {type:'ESModule',path:'archive-object-store.js',contents:objectStore},
    {type:'ESModule',path:'synthetic-archive-key-provider.js',contents:keyProvider},
  ],bindings:{MAPI_SYNTHETIC_AUTHORITY_POLICY:policyText,MAPI_SYNTHETIC_AUTHORITY_POLICY_SHA256:policyDigest},durableObjects:{ARCHIVE_AUTH:{className:'SyntheticArchiveAuthority',useSQLite:true,...(externalScript?{scriptName:externalScript}:{})}}};
}
const entrypoints={boot:'SyntheticAuthorityBootstrap',seal:'SyntheticSealingAuthority',verify:'SyntheticVerificationAuthority',recover:'SyntheticRecoveryAuthority',runner:'SyntheticArchiveVerifier'};
function caller(name, target, capability) {
  return {name,compatibilityDate:'2026-11-19',modules:[{type:'ESModule',path:'caller.mjs',contents:callerModule}],serviceBindings:{CAP:{name:target,entrypoint:entrypoints[capability]}}};
}
const malformed = JSON.stringify(p1) + ' ';
const badDigest = '0'.repeat(64);
const foreign={...p1,commitment:{...p1.commitment,projectId:'foreign-project'}};
const alternate={...p1,verificationJobId:'8'.repeat(32)};
const foreignSeal={...p1,sealingJobId:'9'.repeat(32)};
const oversized=' '.repeat(32769);
const workers=[gatewayWorker('gateway-one',p1),gatewayWorker('gateway-two',p2),gatewayWorker('gateway-bad-json',p1,malformed,sha(malformed),'gateway-one'),gatewayWorker('gateway-bad-digest',p1,JSON.stringify(p1),badDigest,'gateway-one'),gatewayWorker('gateway-oversized',p1,oversized,sha(oversized),'gateway-one'),gatewayWorker('gateway-foreign',foreign,JSON.stringify(foreign),sha(JSON.stringify(foreign)),'gateway-one'),gatewayWorker('gateway-foreign-seal',foreignSeal,JSON.stringify(foreignSeal),sha(JSON.stringify(foreignSeal)),'gateway-one'),gatewayWorker('gateway-alternate',alternate,JSON.stringify(alternate),sha(JSON.stringify(alternate)),'gateway-one')];
for (const capability of Object.keys(entrypoints)) workers.push(caller(`caller-${capability}`,'gateway-one',capability));
workers.push(caller('caller-two-boot','gateway-two','boot'),caller('caller-two-seal','gateway-two','seal'),caller('caller-bad-json','gateway-bad-json','boot'),caller('caller-bad-digest','gateway-bad-digest','boot'),caller('caller-oversized','gateway-oversized','boot'),caller('caller-foreign-boot','gateway-foreign','boot'),caller('caller-foreign-seal','gateway-foreign','seal'),caller('caller-foreign-seal-boot','gateway-foreign-seal','boot'),caller('caller-alternate-boot','gateway-alternate','boot'),caller('caller-alternate-verify','gateway-alternate','verify'));
const options=convertV4MiniflareOptions({workers,host:'127.0.0.1',port:0,telemetry:{enabled:false}});
options.resourcePersistencePath=root;
const mf=new Miniflare(options);
async function call(worker, method, ...args) {
  const stub=await mf.getWorker(worker);
  const response=await stub.fetch('http://synthetic-gateway.local/',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({method,args})});
  assert.equal(response.status,200);
  return response.json();
}
const ok = async (worker,method,...args) => { const r=await call(worker,method,...args); assert.equal(r.ok,true,r.error); return r.value; };
const denied = async (worker,method,...args) => { const r=await call(worker,method,...args); assert.equal(r.ok,false,`${worker}.${method} unexpectedly succeeded`); };
try {
  await denied('caller-bad-json','initialize');
  await denied('caller-bad-digest','initialize');
  await denied('caller-oversized','initialize');
  await denied('caller-seal','initialize');
  assert.deepEqual(await ok('caller-boot','initialize'),{initialized:true});
  assert.deepEqual(await ok('caller-boot','initialize'),{initialized:true});
  await denied('caller-foreign-boot','initialize');
  await denied('caller-foreign-seal-boot','initialize');
  await denied('caller-boot','read',p1.sealingJobId);
  await denied('caller-verify','registerVerifier');
  await denied('caller-recover','registerVerifier');
  await denied('caller-seal','registerVerifier');
  await denied('caller-verify','read',p1.verificationJobId);
  assert.deepEqual(await ok('caller-boot','registerVerifier'),{registered:true});
  assert.deepEqual(await ok('caller-boot','registerVerifier'),{registered:true});
  assert.equal(await ok('caller-seal','read',p1.sealingJobId),null);
  // The runner does not expose raw authority writes, and cannot advance before
  // a terminal sealing head. It has no archive or KMS binding in this test.
  await denied('caller-runner','create',p1.verificationJobId,{});
  await denied('caller-runner','advance');
  assert.equal(await ok('caller-verify','read',p1.verificationJobId),null);
  const initial=sealing(p1,0,'',false,'1');
  await denied('caller-verify','create',p1.sealingJobId,initial);
  await denied('caller-recover','create',p1.sealingJobId,initial);
  await denied('caller-seal','create',p1.verificationJobId,initial);
  await denied('caller-seal','create','9'.repeat(32),initial);
  await denied('caller-seal','create',p1.sealingJobId,{...initial,identityDigest:'0'.repeat(64)});
  assert.equal(await ok('caller-seal','read',p1.sealingJobId),null);
  assert.deepEqual(await ok('caller-seal','create',p1.sealingJobId,initial),{created:true});
  await denied('caller-foreign-seal','read',p1.sealingJobId);
  await denied('caller-foreign-seal','compareAndSwap',p1.sealingJobId,sealing(foreign,0,'',false,'1'),sealing(foreign,1,sha(JSON.stringify(sealing(foreign,0,'',false,'1'))),true,'2'));
  assert.deepEqual(await ok('caller-seal','read',p1.sealingJobId),initial);
  const terminal=sealing(p1,1,sha(JSON.stringify(initial)),true,'2');
  await denied('caller-verify','compareAndSwap',p1.sealingJobId,initial,terminal);
  assert.deepEqual(await ok('caller-seal','read',p1.sealingJobId),initial);
  // Simulate a lost caller acknowledgement after the real CAS has completed.
  await assert.rejects(async()=>{await ok('caller-seal','compareAndSwap',p1.sealingJobId,initial,terminal);throw Error('synthetic lost acknowledgement');});
  assert.deepEqual(await ok('caller-seal','read',p1.sealingJobId),terminal);
  assert.deepEqual(await ok('caller-verify','read',p1.sealingJobId),terminal);
  assert.deepEqual(await ok('caller-recover','read',p1.sealingJobId),terminal);
  await denied('caller-seal','compareAndSwap',p1.sealingJobId,terminal,sealing(p1,2,sha(JSON.stringify(terminal)),false,'3'));
  const verify0=verification(p1,0,'',false,'1',sha(JSON.stringify(terminal)));
  await denied('caller-seal','create',p1.verificationJobId,verify0);
  await denied('caller-recover','create',p1.verificationJobId,verify0);
  await denied('caller-verify','create',p1.verificationJobId,{...verify0,identityDigest:verifyIdentity({...p1,commitment:{...p1.commitment,projectId:'foreign'}})});
  assert.equal(await ok('caller-verify','read',p1.verificationJobId),null);
  assert.deepEqual(await ok('caller-verify','create',p1.verificationJobId,verify0),{created:true});
  const done=verification(p1,1,sha(JSON.stringify(verify0)),true,'2',sha(JSON.stringify(terminal)));
  await denied('caller-recover','compareAndSwap',p1.verificationJobId,verify0,done);
  assert.deepEqual(await ok('caller-verify','read',p1.verificationJobId),verify0);
  assert.deepEqual(await ok('caller-verify','compareAndSwap',p1.verificationJobId,verify0,done),{updated:true});
  assert.deepEqual(await ok('caller-recover','read',p1.verificationJobId),done);
  // A different verifier job for the same immutable base policy does not
  // gain authority merely by deploying a different gateway configuration.
  assert.deepEqual(await ok('caller-alternate-boot','initialize'),{initialized:true});
  const later=verification(alternate,0,'',false,'8',sha(JSON.stringify(terminal)));
  await denied('caller-alternate-verify','create',alternate.verificationJobId,later);
  assert.deepEqual(await ok('caller-verify','read',p1.verificationJobId),done);
  assert.deepEqual(await ok('caller-alternate-boot','registerVerifier'),{registered:true});
  assert.deepEqual(await ok('caller-alternate-verify','create',alternate.verificationJobId,later),{created:true});
  assert.deepEqual(await ok('caller-verify','read',p1.verificationJobId),done);
  await denied('caller-seal','read',p1.verificationJobId);
  await denied('caller-recover','read','9'.repeat(32));
  assert.deepEqual(await ok('caller-two-boot','initialize'),{initialized:true});
  assert.equal(await ok('caller-two-seal','read',p2.sealingJobId),null);
  await denied('caller-two-seal','create',p2.sealingJobId,initial);
  assert.deepEqual(await ok('caller-two-seal','create',p2.sealingJobId,sealing(p2,0,'',false,'7')),{created:true});
  assert.deepEqual(await ok('caller-seal','read',p1.sealingJobId),terminal);
  const direct=await mf.getWorker('gateway-one');
  assert.equal((await direct.fetch('http://synthetic-gateway.local/')).status,404);
  console.log('Synthetic archive authority gateway: service-binding capability and policy checks passed');
} finally { await mf.dispose(); await rm(root,{recursive:true,force:true}); }
