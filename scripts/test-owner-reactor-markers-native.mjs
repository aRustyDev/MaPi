// Actual owner handleRequest and initialization logic with a fake reactor and
// synthetic storage. No real Go, cold restart, recovery, relocation, or cloud.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import * as diagnostics from '../worker/runtime-diagnostics.js';

const source=await readFile('worker/app.js','utf8');
let starts=0, provisioned=false, failFirst=true;
const memory=new ArrayBuffer(65536), bytes=new Uint8Array(memory), enc=new TextEncoder();
const respond=value=>{ const body=enc.encode(JSON.stringify(value)); bytes.set(body,2048); return (2048n<<32n)|BigInt(body.length); };
function instantiate(_wasm, host) {
  starts++;
  if(failFirst) { failFirst=false; throw Error('private synthetic initialization error'); }
  host(()=>memory);
  return {mapi_alloc:()=>0,mapi_release:()=>{},mapi_init:()=>respond(true),mapi_request:()=>respond({status:200,headers:{},body:null})};
}
const noop=()=>{throw Error('Unexpected dependency');};
const modules={
  'cloudflare:workers':{DurableObject:class {constructor(ctx,env){this.ctx=ctx;this.env=env;}}},
  './generated/baseline.json':{default:{}},'./wasm-module.js':{default:{}},
  './wasi.js':{instantiateReactor:instantiate},'./sql.js':{execute:noop,sqliteError:noop},
  './registry.js':{canonicalOrigin:noop,ProjectRegistry:class {}},'./login-ui.js':{renderLogin:noop},
  './flow-proxy.js':{handleFlowProxy:noop},'./oauth-ingress.js':{handleOAuthIngress:noop,isOAuthRoute:noop},
  './runtime-diagnostics.js':diagnostics,'./flow-diagnostics.js':{classifyFlowSubmission:noop},
  './owner-fence.js':{assertOwnerFence:noop,createOwnerFenceTable:noop,freezeOwnerFence:noop,initializeOwnerFence:noop,reserveMoveDestination:noop,retireOwnerFence:noop,withOwnerFence:noop},
  './relocation-source-identity.js':{sourceIdentityMatches:noop},
  './relocation-manifest.js':{digestRelocationPage:noop,inspectRelocationDestination:noop,inspectRelocationSource:noop,prepareRelocationDestination:noop,restoreRelocationMetadata:noop,validateRelocationSourceSchema:noop},
  './relocation-chunks.js':{beginChunkExport:noop,beginChunkImport:noop,chunkImportStatus:noop,exportChunk:noop,importChunk:noop},
  './relocation-history.js':{destinationTransferHistory:noop,sourceTransferHistory:noop,transferHistoryStatus:noop},
  './recovery-scopes.js':{assertRecoveryEnvelope:noop,readOwnerRecoveryScopes:noop,recoveryPageDigest:noop,validRecoveryStamp:noop,validateRecoveryScope:noop},
  './recovery-epochs.js':{recoveryEpochConfiguration:()=>null},'./schema-migration.js':{authorizeSchemaMigration:noop},
  './login-throttle.js':{admitLogin:noop},'./request-body.js':{readBoundedText:noop},'./relocation-coordinator.js':{RelocationCoordinator:class {}},
};
const context=vm.createContext({Request,Response,Headers,URL,URLSearchParams,TextEncoder,TextDecoder,Uint8Array,crypto,console});
const app=new vm.SourceTextModule(source,{context,identifier:'reactor-attempt-owner.mjs'});
await app.link(specifier=>{const exports=modules[specifier]; if(!exports) throw Error(`Unexpected import ${specifier}`); return new vm.SyntheticModule(Object.keys(exports),function(){for(const [name,value] of Object.entries(exports))this.setExport(name,value);},{context,identifier:specifier});});
await app.evaluate();
const storage={sql:{exec(query){const result=provisioned && query.includes("name = 'mapi_schema_version'")?[{one:1}]:[];return {toArray:()=>result,one:()=>result[0]};}},transactionSync:fn=>fn()};
const logs=[], oldLog=console.log;
try {
  console.log=value=>logs.push(String(value));
  const owner=new app.namespace.NextgenApplication({storage,id:{toString:()=> 'synthetic-owner'}},{MAPI_RUNTIME_DIAGNOSTICS:'1',MAPI_MASTER_KEY:Buffer.from('{}').toString('base64')});
  provisioned=true;
  assert.equal(owner.handleRequest({}).status,503);
  assert.equal(owner.handleRequest({}).status,200);
  assert.equal(owner.handleRequest({}).status,200);
  const events=logs.map(JSON.parse).filter(item=>item.event.startsWith('mapi.reactor.'));
  assert.deepEqual(events.map(({event,attempt})=>({event,attempt})),[
    {event:'mapi.reactor.start',attempt:1},{event:'mapi.reactor.failure',attempt:1},
    {event:'mapi.reactor.start',attempt:2},{event:'mapi.reactor.ready',attempt:2},
  ]);
  assert.equal(starts,2);
  assert.ok(events.every(event=>event.bootId===events[0].bootId && event.objectId==='synthetic-owner'));
  assert.ok(logs.every(message=>!message.includes('private synthetic initialization error')));
  console.log=()=>{throw Error('log sink down');};
  provisioned=false;
  const owner2=new app.namespace.NextgenApplication({storage,id:{toString:()=> 'synthetic-owner-2'}},{MAPI_RUNTIME_DIAGNOSTICS:'0',MAPI_MASTER_KEY:Buffer.from('{}').toString('base64')});
  provisioned=true;
  owner2.env.MAPI_RUNTIME_DIAGNOSTICS='1';
  assert.equal(owner2.handleRequest({}).status,200);
  // Metadata is diagnostics-only and cannot turn an otherwise valid request
  // into an error when the identity source is temporarily unavailable.
  console.log=value=>logs.push(String(value));
  let failMetadata=false;
  const id={toString(){if(failMetadata) throw Error('synthetic metadata unavailable');return 'synthetic-owner-3';}};
  provisioned=false;
  const owner3=new app.namespace.NextgenApplication({storage,id},{MAPI_RUNTIME_DIAGNOSTICS:'1',MAPI_MASTER_KEY:Buffer.from('{}').toString('base64')});
  provisioned=true; failMetadata=true;
  assert.equal(owner3.handleRequest({}).status,200);
} finally {console.log=oldLog;}
console.log('Synthetic owner reactor attempt markers and retry passed');
