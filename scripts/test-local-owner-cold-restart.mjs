// Disposable local cold-restart diagnostic. Synthetic keys and SQLite state
// never leave the local Miniflare process. This does not call a readiness
// endpoint, deploy a Worker, or contact Woven/AWS.
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

const directory=resolve(process.argv[2] ?? '');
if (!directory.startsWith('/private/tmp/')) throw Error('A disposable local bundle directory is required');
const names=await readdir(resolve(directory,'bundle'));
const candidates=names.filter(name=>name.endsWith('-phase1-owner.wasm'));
assert.equal(candidates.length,1);
const source=await readFile(resolve(directory,'bundle/phase1-owner.js'),'utf8');
const wasm=await readFile(resolve(directory,'bundle',candidates[0]));
const sha=value=>createHash('sha256').update(value).digest('hex');
const {privateKey}=generateKeyPairSync('rsa',{modulusLength:4096,privateKeyEncoding:{type:'pkcs1',format:'pem'},publicKeyEncoding:{type:'spki',format:'pem'}});
const master=Buffer.from(JSON.stringify({id:'synthetic-master.pem',pem:privateKey})).toString('base64');
const operator=randomBytes(32).toString('base64url');
const origins=['https://alpha.test','https://beta.test'];
const email='same-user@example.test', passwords=['Alpha-Synthetic-123!','Beta-Synthetic-456!'];
const state=await mkdtemp(resolve(tmpdir(),'mapi-local-cold-'));
let mf, disposed=true;
async function create() {
  disposed=false;
  return new Miniflare(convertV4MiniflareOptions({host:'127.0.0.1',port:0,telemetry:{enabled:false},isolatedResourcePersistencePath:state,workers:[{
    name:'owner-cold-local',compatibilityDate:'2026-11-19',
    bindings:{MAPI_MASTER_KEY:master,MAPI_OPERATOR_TOKEN:operator,MAPI_APP_ORIGIN:origins[0],MAPI_LOCAL_TEST:'1',MAPI_OFFICIAL_LOGIN:'1',MAPI_OIDC_EXPERIMENTAL:'1',MAPI_MANAGEMENT_ENABLED:'1',MAPI_RUNTIME_DIAGNOSTICS:'1'},
    durableObjects:{NEXTGEN_APPLICATION:{className:'NextgenApplication',useSQLite:true},PROJECT_REGISTRY:{className:'ProjectRegistry',useSQLite:true}},
    modules:[{type:'ESModule',path:'phase1-owner.js',contents:source},{type:'CompiledWasm',path:candidates[0],contents:wasm}],
  }]}));
}
async function request(origin,path,options={}) {
  const headers={};
  if(options.auth!==false) headers.authorization=`Bearer ${operator}`;
  if(options.cookie) headers.cookie=options.cookie;
  if(options.body) headers['content-type']=options.form?'application/x-www-form-urlencoded':'application/json';
  if(options.form) headers.origin=origin;
  return mf.dispatchFetch(origin+path,{method:options.body?'POST':'GET',headers,redirect:'manual',body:options.body?(options.form?new URLSearchParams(options.body):JSON.stringify(options.body)):undefined});
}
async function status(i) {
  const response=await request(origins[i],'/_mapi/admin/status'); assert.equal(response.status,200);
  const result=await response.json(); assert.ok(result.bootId); return result;
}
async function journey(i) {
  const before=performance.now();
  const login=await request(origins[i],'/login',{auth:false,form:true,body:{email,password:passwords[i]}});
  const loginMs=performance.now()-before;
  assert.equal(login.status,303,'login'); const cookie=login.headers.get('set-cookie')?.split(';',1)[0]; assert.ok(cookie);
  const session=await request(origins[i],'/app',{auth:false,cookie}); assert.equal(session.status,200,'session'); await session.arrayBuffer();
  return {loginMs,journeyMs:performance.now()-before};
}
try {
  mf=await create();
  const first=await request(origins[0],'/_mapi/admin/init',{body:{name:'Synthetic primary'}}); assert.equal(first.status,200);
  const second=await request(origins[0],'/_mapi/admin/projects',{body:{name:'Synthetic secondary',origin:origins[1]}}); assert.equal(second.status,200);
  for(let i=0;i<2;i++) assert.equal((await request(origins[i],'/_mapi/admin/users',{body:{email,password:passwords[i]}})).status,200);
  const before=await Promise.all(origins.map((_,i)=>status(i)));
  await mf.dispose(); mf=null; disposed=true;

  // The new local Worker runtime has never received a request. Do not probe
  // it: the first Worker/owner request is the primary project's login.
  mf=await create();
  const cold=[]; for(let i=0;i<2;i++) cold.push(await journey(i));
  // Status is only read after both first journeys, so it cannot warm either
  // owner beforehand. A changed boot ID confirms a new owner instance.
  const after=await Promise.all(origins.map((_,i)=>status(i)));
  for(let i=0;i<2;i++) {
    assert.notEqual(after[i].bootId,before[i].bootId,'owner did not restart');
    assert.ok(after[i].reactorInitializations>=1,'cold login did not initialize reactor');
  }
  const warm=[]; for(let i=0;i<2;i++) warm.push(await journey(i));
  console.log(JSON.stringify({result:'local-cold-restart',sourceSha256:sha(source),wasmSha256:sha(wasm),cold,warm,
    owners:after.map((v,i)=>({bootChanged:v.bootId!==before[i].bootId,reactorInitializations:v.reactorInitializations,wasmMemoryBytes:v.wasmMemoryBytes,wasmHighWaterBytes:v.wasmHighWaterBytes}))}));
} finally {
  if(mf) { await mf.dispose(); disposed=true; }
  if(disposed) await rm(state,{recursive:true,force:true});
}
