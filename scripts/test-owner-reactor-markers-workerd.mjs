// Worker boot, owner boot and flow diagnostics with real Go Wasm and SQLite. Unrelated
// modules are stubbed; this is not a recovery, relocation, registry, cold
// restart, hosted or production integration test.
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

const dir=resolve(process.argv[2]??'');
if(!dir.startsWith('/private/tmp/')) throw Error('Disposable local bundle directory required');
const names=(await readdir(resolve(dir,'bundle'))).filter(n=>n.endsWith('-phase1-owner.wasm'));
assert.equal(names.length,1);
const wasm=await readFile(resolve(dir,'bundle',names[0]));
const appSource=await readFile('worker/app.js','utf8');
const app=appSource.replace('"./generated/baseline.json"','"./baseline-stub.js"').replace('"./wasm-module.js"','"./owner.wasm"');
if(app===appSource || app.includes('"./wasm-module.js"') || app.includes('"./generated/baseline.json"')) throw Error('App import rewrite failed');
const key=generateKeyPairSync('rsa',{modulusLength:4096,privateKeyEncoding:{type:'pkcs1',format:'pem'},publicKeyEncoding:{type:'spki',format:'pem'}}).privateKey;
const master=Buffer.from(JSON.stringify({id:'synthetic-master',pem:key})).toString('base64');
const stubs={
  'registry.js':`export const canonicalOrigin=value=>new URL(value).origin; export class ProjectRegistry {}`,
  'login-ui.js':'renderLogin', 'flow-proxy.js':'handleFlowProxy', 'oauth-ingress.js':'handleOAuthIngress isOAuthRoute',
  'management-ingress.js':`export const handleManagementApp=()=>new Response(null,{status:204});`,
  'relocation-source-identity.js':'sourceIdentityMatches',
  'relocation-manifest.js':'digestRelocationPage inspectRelocationDestination inspectRelocationSource prepareRelocationDestination restoreRelocationMetadata validateRelocationSourceSchema',
  'relocation-chunks.js':'beginChunkExport beginChunkImport chunkImportStatus exportChunk importChunk',
  'relocation-history.js':'destinationTransferHistory sourceTransferHistory transferHistoryStatus',
  'recovery-scopes.js':'assertRecoveryEnvelope readOwnerRecoveryScopes recoveryPageDigest validRecoveryStamp validateRecoveryScope',
  'schema-migration.js':'authorizeSchemaMigration', 'request-body.js':'readBoundedText',
  'relocation-coordinator.js':`export class RelocationCoordinator {}`,
};
const modules=[];
for(const name of ['wasi.js','sql.js','runtime-diagnostics.js','owner-fence.js','recovery-epochs.js','flow-diagnostics.js','login-throttle.js']) modules.push({type:'ESModule',path:`worker/${name}`,contents:await readFile(`worker/${name}`,'utf8')});
for(const [name,spec] of Object.entries(stubs)) modules.push({type:'ESModule',path:`worker/${name}`,contents:spec.includes('export ')?spec:spec.split(' ').map(x=>`export const ${x}=()=>{throw Error('Unexpected synthetic dependency')};`).join('\n')});
modules.push({type:'ESModule',path:'worker/baseline-stub.js',contents:`export default ${await readFile('worker/generated/baseline.json','utf8')};`});
modules.push({type:'ESModule',path:'worker/app.js',contents:app},{type:'CompiledWasm',path:'worker/owner.wasm',contents:wasm});
const phase1Owner = (await readFile('worker/phase1-owner.js','utf8')).replace('./generated/phase1-owner-app.js','./app.js');
modules.push({type:'ESModule',path:'worker/phase1-owner.js',contents:phase1Owner});
const worker=`import {NextgenApplication} from './app.js';
import phase1Owner from './phase1-owner.js';
const origin='https://marker.invalid', objectName='synthetic-owner';
export class Probe extends NextgenApplication {
  constructor(ctx,env) {
    const original=console.log;
    let attempted=false;
    const registryRoute={origin,object_name:objectName,generation:1,project_id:null,state:'pending'};
    console.log=()=>{attempted=true;throw Error('injected owner log failure')};
    try {
      super(ctx,{...env, MAPI_MASTER_KEY:'not-base64',
        NEXTGEN_APPLICATION:{idFromName:()=>ctx.id},
        PROJECT_REGISTRY:{getByName:()=>({resolve:async()=>registryRoute})}});
    } finally { console.log=original }
    if(!attempted) throw Error('Owner boot log was not exercised');
    this.fixtureRegistryRoute=registryRoute;
  }
  async check() {
    const original=console.log, logs=[]; console.log=value=>logs.push(String(value));
    try {
      const route={projectId:null,origin,objectName,generation:1};
      let failed=false; try { await this.provision('Synthetic marker project',origin,route); } catch {failed=true}
      if(!failed) throw Error('Bad key unexpectedly accepted');
      this.env.MAPI_MASTER_KEY=this.env.TEST_MASTER;
      const result=await this.provision('Synthetic marker project',origin,route);
      if(!result?.projectId) throw Error('Real Go provisioning failed');
      const again=await this.provision('Synthetic marker project',origin,route);
      if(again.projectId!==result.projectId) throw Error('Provision retry mismatch');
      const events=logs.map(line=>{try{return JSON.parse(line)}catch{return null}}).filter(x=>x?.event?.startsWith('mapi.reactor.'));
      if(JSON.stringify(events.map(x=>[x.event,x.attempt]))!==JSON.stringify([['mapi.reactor.start',1],['mapi.reactor.failure',1],['mapi.reactor.start',2],['mapi.reactor.ready',2]])) throw Error('Lifecycle sequence mismatch');
      if(logs.some(line=>line.includes('not-base64') || line.includes('TEST_MASTER'))) throw Error('Lifecycle leaked input');
      const request={method:'POST',url:origin+'/api/v1/flows/flow_fixture/submit',headers:{},body:btoa('{}'),peer:'192.0.2.38'};
      const activeRoute={...route,projectId:result.projectId};
      this.fixtureRegistryRoute.project_id=result.projectId;
      this.fixtureRegistryRoute.state='active';
      await this.activateProvisioning(activeRoute);
      const expected=this.flowRequest(request,activeRoute);
      if(!logs.some(line=>line.includes('mapi.flow.submit'))) throw Error('Flow submit log was not exercised');
      let flowLog=false;
      console.log=()=>{flowLog=true;throw Error('injected flow log failure')};
      const actual=this.flowRequest(request,activeRoute);
      if(!flowLog || actual.status!==expected.status) throw Error('Failed diagnostic changed the flow result');
      return {events:events.map(x=>({event:x.event,attempt:x.attempt})),projectCreated:true};
    } finally {console.log=original}
  }
}
export default {async fetch(req,env){
  const original=console.log;
  let workerLog=false;
  console.log=()=>{workerLog=true;throw Error('injected Worker log failure')};
  try {
    const response=await phase1Owner.fetch(req,env);
    if(!workerLog || response.status!==204) throw Error('Worker boot was not forwarded');
  } finally { console.log=original }
  return Response.json(await env.PROBE.getByName('one').check());
}};`;
let mf;
try {
  mf=new Miniflare(convertV4MiniflareOptions({host:'127.0.0.1',port:0,telemetry:{enabled:false},workers:[{
    name:'owner-reactor-attempt-local',compatibilityDate:'2026-11-19',bindings:{TEST_MASTER:master,MAPI_RUNTIME_DIAGNOSTICS:'1'},
    durableObjects:{PROBE:{className:'Probe',useSQLite:true}},modules:[{type:'ESModule',path:'worker/test-worker.mjs',contents:worker},...modules],
  }]}));
  const response=await mf.dispatchFetch('http://localhost/');const body=await response.text();
  assert.equal(response.status,200,body);assert.equal(JSON.parse(body).projectCreated,true);
  const sha=value=>createHash('sha256').update(value).digest('hex');
  assert.equal(sha(await readFile('worker/app.js')),sha(appSource));
  console.log('Throwing diagnostic sinks preserved Worker boot, owner provisioning, reactor retry and flow outcomes in local Workerd.');
  console.log(JSON.stringify({app:sha(appSource),wasm:sha(wasm),worker:sha(worker)}));
}finally{if(mf)await mf.dispose()}
