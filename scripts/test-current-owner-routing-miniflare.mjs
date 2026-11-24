// Invoke only against a disposable dry-run bundle built from the current
// source. This test uses in-memory local Durable Objects and synthetic keys;
// it does not deploy, access Woven, or test relocation or hosted metrics.
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

const names=await readdir('bundle');
const wasmName=names.find(name=>name.endsWith('-phase1-owner.wasm'));
assert.ok(wasmName && names.filter(name=>name.endsWith('-phase1-owner.wasm')).length===1);
const {privateKey}=generateKeyPairSync('rsa',{modulusLength:4096,privateKeyEncoding:{type:'pkcs1',format:'pem'},publicKeyEncoding:{type:'spki',format:'pem'}});
const master=Buffer.from(JSON.stringify({id:'synthetic-master.pem',pem:privateKey})).toString('base64');
const operator=randomBytes(32).toString('base64url');
const control=randomBytes(32).toString('base64url');
const origins=['https://alpha.test','https://beta.test'];
// This wrapper exists only inside the disposable Miniflare process. The
// deployed entry has no HTTP token endpoint.
const wrapper=`import owner,{NextgenApplication,ProjectRegistry} from './phase1-owner.js';
export {NextgenApplication,ProjectRegistry};
export default {async fetch(req,env) {
  const url=new URL(req.url);
  if(url.pathname==='/__local/project-token' || url.pathname==='/__local/user-audit') {
    if(req.headers.get('x-local-control')!==env.MAPI_PHASE1_CONTROL_TOKEN) return new Response(null,{status:404});
    const row=await env.PROJECT_REGISTRY.getByName('projects').resolve(url.origin);
    const route={projectId:row.project_id,origin:row.origin,objectName:row.object_name,generation:row.generation};
    const action=url.pathname==='/__local/project-token'?'project-token':'user-audit';
    const userId=action==='user-audit'?(await req.json()).userId:undefined;
    const result=await env.NEXTGEN_APPLICATION.getByName(row.object_name).phase1Control(route,env.MAPI_PHASE1_CONTROL_TOKEN,action,userId);
    return Response.json(action==='project-token'?{token:result}:{count:result});
  }
  return owner.fetch(req,env);
}};`;
let mf;
try {
  mf=new Miniflare(convertV4MiniflareOptions({host:'127.0.0.1',port:0,telemetry:{enabled:false},workers:[{
    name:'owner-routing-local',compatibilityDate:'2026-11-19',
    bindings:{MAPI_MASTER_KEY:master,MAPI_OPERATOR_TOKEN:operator,MAPI_PHASE1_CONTROL_TOKEN:control,MAPI_APP_ORIGIN:origins[0],MAPI_LOCAL_TEST:'1',MAPI_OFFICIAL_LOGIN:'1',MAPI_OIDC_EXPERIMENTAL:'1',MAPI_MANAGEMENT_ENABLED:'1'},
    durableObjects:{NEXTGEN_APPLICATION:{className:'NextgenApplication',useSQLite:true},PROJECT_REGISTRY:{className:'ProjectRegistry',useSQLite:true}},
    modules:[{type:'ESModule',path:'test-wrapper.js',contents:wrapper},{type:'ESModule',path:'phase1-owner.js',contents:await readFile('bundle/phase1-owner.js','utf8')},{type:'CompiledWasm',path:wasmName,contents:await readFile(`bundle/${wasmName}`)}],
  }]}));
  async function request(origin,path,options={}) {
    const headers={};
    if(options.token) headers.authorization=`Bearer ${options.token}`;
    else if(options.auth!==false) headers.authorization=`Bearer ${operator}`;
    if(options.control) headers['x-local-control']=control;
    if(options.cookie) headers.cookie=options.cookie;
    if(options.body) headers['content-type']=options.form?'application/x-www-form-urlencoded':'application/json';
    if(options.form) headers.origin=origin;
    return mf.dispatchFetch(origin+path,{method:options.body?'POST':'GET',headers,redirect:'manual',body:options.body?(options.form?new URLSearchParams(options.body):JSON.stringify(options.body)):undefined});
  }
  const init=await request(origins[0],'/_mapi/admin/init',{body:{name:'Synthetic primary'}});
  assert.equal(init.status,200,'primary provision'); const primary=(await init.json()).projectId;
  const creates=await Promise.all(Array.from({length:3},()=>request(origins[0],'/_mapi/admin/projects',{body:{name:'Synthetic secondary',origin:origins[1]}})));
  assert.ok(creates.every(r=>r.status===200),'secondary provision');
  const ids=await Promise.all(creates.map(async r=>(await r.json()).projectId));
  assert.ok(primary && ids[0] && primary!==ids[0] && ids.every(id=>id===ids[0]));
  const email='same-user@example.test', passwords=['Alpha-Synthetic-123!','Beta-Synthetic-456!'];
  const userIds=[];
  for(let i=0;i<2;i++) {
    const user=await request(origins[i],'/_mapi/admin/users',{body:{email,password:passwords[i]}});
    assert.equal(user.status,200,'add user'); userIds.push((await user.json()).userId);
  }
  assert.ok(userIds[0] && userIds[1] && userIds[0]!==userIds[1]);
  const tokens=[];
  for(let i=0;i<2;i++) {
    const response=await request(origins[i],'/__local/project-token',{control:true});
    assert.equal(response.status,200,'private synthetic token'); const token=(await response.json()).token; assert.ok(token); tokens.push(token);
  }
  const projects=[primary,ids[0]];
  for(let i=0;i<2;i++) {
    const query=await request(origins[i],`/api/v1/users/query?project_id=${projects[i]}`,{token:tokens[i],body:{}});
    assert.equal(query.status,200,'own management query'); const text=await query.text();
    assert.ok(text.includes(userIds[i]) && !text.includes(userIds[1-i]),'management query isolation');
    assert.equal((await request(origins[i],`/api/v1/users/${userIds[i]}`,{token:tokens[i]})).status,200,'own management read');
    assert.equal((await request(origins[i],`/api/v1/users/${userIds[1-i]}`,{token:tokens[i]})).status,404,'foreign user read');
    assert.ok((await request(origins[i],`/api/v1/users/query?project_id=${projects[i]}`,{token:tokens[1-i],body:{}})).status>=400,'foreign project token');
  }
  const cookies=[];
  for(let i=0;i<2;i++) {
    const login=await request(origins[i],'/login',{auth:false,form:true,body:{email,password:passwords[i]}});
    assert.equal(login.status,303,'login'); const cookie=login.headers.get('set-cookie')?.split(';',1)[0]; assert.ok(cookie); cookies.push(cookie);
  }
  for(let i=0;i<2;i++) {
    assert.equal((await request(origins[i],'/app',{auth:false,cookie:cookies[i]})).status,200,'own session');
    assert.equal((await request(origins[i],'/app',{auth:false,cookie:cookies[1-i]})).status,303,'foreign session');
    assert.equal((await request(origins[i],'/login',{auth:false,form:true,body:{email,password:passwords[1-i]}})).status,401,'foreign credential');
  }
  console.log('Current local owner: two projects passed provisioning, Go management reads, login and session isolation');
  if(process.argv.includes('--load')) {
    // Local-only diagnostic, not the hosted browser-to-RP benchmark. Each
    // journey uses the real legacy Go password handler and a session read.
    for(const mixed of [false,true]) {
      const elapsed=[[],[]], memory=[[],[]], created=[0,0], started=performance.now(); let management=0, sampleMs=0;
      async function journey(i) {
        const before=performance.now();
        const login=await request(origins[i],'/login',{auth:false,form:true,body:{email,password:passwords[i]}});
        assert.equal(login.status,303,'load login');
        const cookie=login.headers.get('set-cookie')?.split(';',1)[0]; assert.ok(cookie);
        assert.equal((await request(origins[i],'/app',{auth:false,cookie})).status,200,'load session');
        elapsed[i].push(performance.now()-before);
      }
      async function managementReads(i) {
        for(let n=0;n<2;n++) {
          const get=await request(origins[i],`/api/v1/users/${userIds[i]}`,{token:tokens[i]}); assert.equal(get.status,200,'load management get'); await get.arrayBuffer(); management++;
          const query=await request(origins[i],`/api/v1/users/query?project_id=${projects[i]}`,{token:tokens[i],body:{}}); assert.equal(query.status,200,'load management query'); await query.arrayBuffer(); management++;
        }
      }
      async function createAndVerify(i,wave) {
        const createdUser=await request(origins[i],'/_mapi/admin/users',{body:{email:`synthetic-${i}-${wave}@example.test`,password:`Synthetic-${i}-${wave}-Pass-123!`}});
        assert.equal(createdUser.status,200,'load operator create');
        const userId=(await createdUser.json()).userId; assert.ok(userId,'load created user ID');
        const user=await request(origins[i],`/api/v1/users/${userId}`,{token:tokens[i]});
        assert.equal(user.status,200,'load created user read'); await user.arrayBuffer();
        const audit=await request(origins[i],'/__local/user-audit',{control:true,body:{userId}});
        assert.equal(audit.status,200,'load created user audit'); assert.equal((await audit.json()).count,1,'exactly one create audit');
        created[i]++;
      }
      for(let wave=0;wave<5;wave++) {
        const work=[];
        for(let i=0;i<2;i++) {
          for(let j=0;j<4;j++) work.push(journey(i));
          if(mixed) { work.push(managementReads(i)); if(wave===1 || wave===3) work.push(createAndVerify(i,wave)); }
        }
        await Promise.all(work);
        // Query only after a warm wave: status(true) may initialize a cold Go
        // reactor, so it cannot be used as evidence of a cold first request.
        const sampleStart=performance.now();
        await Promise.all(origins.map(async (origin,i)=>{
          const response=await request(origin,'/_mapi/admin/status');
          assert.equal(response.status,200,'owner memory sample');
          const state=await response.json();
          assert.equal(state.ready,true,'owner memory sample readiness');
          assert.ok(Number.isSafeInteger(state.wasmMemoryBytes) && state.wasmMemoryBytes>0 && state.wasmMemoryBytes%65536===0,'Wasm memory bytes');
          assert.ok(Number.isSafeInteger(state.wasmHighWaterBytes) && state.wasmHighWaterBytes>=state.wasmMemoryBytes && state.wasmHighWaterBytes%65536===0,'Wasm high water');
          assert.equal(state.wasmHighWaterPages,state.wasmHighWaterBytes/65536,'Wasm pages');
          assert.ok(typeof state.bootId==='string' && state.bootId && Number.isSafeInteger(state.reactorInitializations) && state.reactorInitializations>0,'owner instance sample');
          memory[i].push({bytes:state.wasmMemoryBytes, high:state.wasmHighWaterBytes, boot:state.bootId, initializations:state.reactorInitializations});
        }));
        sampleMs+=performance.now()-sampleStart;
      }
      const seconds=(performance.now()-started)/1000;
      const p95=elapsed.map(values=>values.sort((a,b)=>a-b)[18]);
      const wasm=memory.map(samples=>({samples:samples.length,instances:new Set(samples.map(sample=>sample.boot)).size,
        maximumSampleBytes:Math.max(...samples.map(sample=>sample.bytes)), highWaterBytes:Math.max(...samples.map(sample=>sample.high)),
        highWaterPages:Math.max(...samples.map(sample=>sample.high))/65536, maxInitializations:Math.max(...samples.map(sample=>sample.initializations))}));
      if(mixed) assert.deepEqual(created,[2,2],'operator creates and audits');
      console.log(JSON.stringify({local:true,mixed,completed:elapsed.map(values=>values.length),journeyP95Ms:p95,managementOperations:management,operatorCreatesAndAudits:created,wallSeconds:seconds,journeysPerSecond:40/seconds,statusSampleMs:sampleMs,wasm}));
    }
  }
} finally { if(mf) await mf.dispose(); }
