// Exercise actual owner initialization/request code with a fake reactor and
// synthetic storage. No real Go, deployment, hosted service, or user data.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import * as diagnostics from '../worker/runtime-diagnostics.js';

const source=await readFile('worker/app.js','utf8');
let provisioned=false, diagnostic=[];
const lengths=[], memory=new ArrayBuffer(65536), bytes=new Uint8Array(memory), encoder=new TextEncoder();
class TrackingDecoder extends TextDecoder {
  decode(input, options) { if(input) lengths.push(input.byteLength); return super.decode(input,options); }
}
const respond=value=>{const body=encoder.encode(JSON.stringify(value));bytes.set(body,2048);return (2048n<<32n)|BigInt(body.length);};
function instantiate(_wasm,host,onDiagnostic) {
  host(()=>memory);
  return {mapi_alloc:()=>0,mapi_release:()=>{},mapi_init:()=>respond(true),
    mapi_request:()=>{for(const chunk of diagnostic)onDiagnostic(chunk);throw Error('synthetic reactor failure');}};
}
const noop=()=>{throw Error('Unexpected dependency');};
const modules={
  'cloudflare:workers':{DurableObject:class {constructor(ctx,env){this.ctx=ctx;this.env=env;}}},
  './generated/baseline.json':{default:{}},'./wasm-module.js':{default:{}},
  './wasi.js':{instantiateReactor:instantiate},'./sql.js':{execute:noop,sqliteHost:()=>({})},
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
const context=vm.createContext({Request,Response,Headers,URL,URLSearchParams,TextEncoder,TextDecoder:TrackingDecoder,Uint8Array,crypto,console});
const app=new vm.SourceTextModule(source,{context,identifier:'owner-diagnostic-bound.mjs'});
await app.link(specifier=>{const exports=modules[specifier];if(!exports)throw Error('Unexpected import');return new vm.SyntheticModule(Object.keys(exports),function(){for(const [name,value] of Object.entries(exports))this.setExport(name,value);},{context,identifier:specifier});});
await app.evaluate();
const storage={sql:{exec(query){const result=provisioned && query.includes("name = 'mapi_schema_version'")?[{one:1}]:[];return {toArray:()=>result,one:()=>result[0]};}},transactionSync:fn=>fn()};
const logs=[],oldError=console.error;
try {
  console.error=(...args)=>logs.push(args);
  const owner=new app.namespace.NextgenApplication({storage,id:{toString:()=> 'synthetic-owner'}},{MAPI_MASTER_KEY:Buffer.from('{}').toString('base64'),MAPI_LOCAL_TEST:'1'});
  provisioned=true;
  diagnostic=[encoder.encode('fatal error: synthetic failure\n')];
  assert.equal(owner.handleRequest({}).status,503);
  assert.ok(logs.some(args=>args[0]==='Go/Wasm runtime:'&&args[1]==='synthetic failure'),'normal fatal classification');
  logs.length=0; lengths.length=0;
  const prefix=encoder.encode('fatal error: synthetic failure\n');
  const oversized=new Uint8Array(1024*1024);oversized.fill(65);oversized.set(prefix);
  diagnostic=[oversized,oversized];
  assert.equal(owner.handleRequest({}).status,503);
  assert.ok(logs.some(args=>args[0]==='Go/Wasm runtime:'&&args[1]==='synthetic failure'),'fatal classification with oversized write');
  assert.ok(Math.max(...lengths)<=8192,`decoded oversized chunk: ${Math.max(...lengths)}`);
  assert.equal(lengths.filter(n=>n===8192).length,1,'second oversized write must not be decoded');
  const rendered=logs.find(args=>args[0]==='Go/Wasm diagnostic:');assert.ok(rendered&&rendered[1].length<=1400);
  logs.length=0;lengths.length=0;
  diagnostic=[encoder.encode('é'.repeat(100000))];
  assert.equal(owner.handleRequest({}).status,503);
  assert.ok(Math.max(...lengths)<=8192);
} finally {console.error=oldError;}
console.log('Actual owner bounds oversized Wasm diagnostic decoding and preserves normal fatal classification');
