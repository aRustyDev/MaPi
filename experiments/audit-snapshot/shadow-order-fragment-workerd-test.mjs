// Disposable local Workerd test for one private snapshot ordering read. This
// is not the handler, payload transfer, real owner or a hosted test.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
const base='experiments/audit-snapshot/';
const baseline=JSON.parse(await readFile('worker/generated/baseline.json','utf8'));
const ddl=baseline.statements.find(s=>/^CREATE TABLE events\s*\(/.test(s));
const indexes=baseline.statements.filter(s=>/^CREATE INDEX idx_events_[a-z0-9_]+\s+ON events\s*\(/.test(s));
assert.ok(ddl);assert.equal(indexes.length,12);
const paths=['worker/owner-fence.js','worker/audit-source-capture.js',base+'shadow-sql.mjs',base+'shadow-lifecycle.mjs',base+'shadow-order-fragment.mjs'];
const modules=await Promise.all(paths.map(async path=>({type:'ESModule',path,contents:await readFile(path,'utf8')})));
const worker=`import {DurableObject} from 'cloudflare:workers';
import {initializeOwnerFence,freezeOwnerFence} from './worker/owner-fence.js';
import {beginShadow,acquireShadowReader,releaseShadowReader} from './experiments/audit-snapshot/shadow-lifecycle.mjs';
import {readShadowOrderFragment} from './experiments/audit-snapshot/shadow-order-fragment.mjs';
const ddl=${JSON.stringify(ddl)}, indexes=${JSON.stringify(indexes)}, route={projectId:'p',origin:'https://p.invalid',objectName:'owner-p',generation:1};
const scope={id:'1'.repeat(32),epoch:'era-1',principal:'2'.repeat(64),request:'3'.repeat(64),route};
const reader='4'.repeat(32),use='5'.repeat(32),allow=()=>true,id='x'.repeat(70000)+'é';
export class Probe extends DurableObject {
  initialize(){const s=this.ctx.storage,q=s.sql;initializeOwnerFence(s,route);q.exec('CREATE TABLE mapi_recovery_epoch(epoch TEXT NOT NULL)');q.exec("INSERT INTO mapi_recovery_epoch VALUES ('era-1')");q.exec(ddl);for(const i of indexes)q.exec(i);q.exec("INSERT INTO events(project_id,id,event_type,category,occurred_at,created_at,payload,metadata) VALUES ('p',?,'user.created','identity',1,CAST(? AS INTEGER),'{}','{}')",id,'-9223372036854775808');q.exec("INSERT INTO events(project_id,id,event_type,category,occurred_at,created_at,payload,metadata) VALUES ('other','foreign','user.created','identity',1,1,'{}','{}')");beginShadow(s,scope,ddl,indexes,allow);acquireShadowReader(s,scope,reader,use,allow);q.exec("DELETE FROM events WHERE project_id='p'");}
  part(handle,offset,stale=false){return readShadowOrderFragment(this.ctx.storage,stale?{...scope,route:{...route,generation:2}}:scope,reader,use,allow,handle,offset);}
  release(){releaseShadowReader(this.ctx.storage,scope,reader,use,allow);}
  freeze(){freezeOwnerFence(this.ctx.storage,route,'move');}
}
export default {async fetch(req,env){const p=env.PROBE.getByName('one');await p.initialize();const chunks=[];let offset=0;for(;;){const bytes=await p.part('1',offset);const v=JSON.parse(new TextDecoder().decode(bytes));if(v.timestamp!=='-9223372036854775808'||v.offset!==offset)throw Error('wrong metadata');const part=Uint8Array.fromBase64(v.fragment);if(part.length>32768)throw Error('fragment too large');chunks.push(part);if(v.done)break;offset+=32768;}const merged=new Uint8Array(chunks.reduce((n,x)=>n+x.length,0));let position=0;for(const c of chunks){merged.set(c,position);position+=c.length;}if(new TextDecoder().decode(merged)!==id)throw Error('snapshot mismatch');for(const args of [['2',0,false],['1',0,true]]){let denied=false;try{await p.part(...args);}catch{denied=true;}if(!denied)throw Error('bad scope accepted');}await p.release();let denied=false;try{await p.part('1',0);}catch{denied=true;}if(!denied)throw Error('released lease accepted');await p.freeze();denied=false;try{await p.part('1',0);}catch{denied=true;}if(!denied)throw Error('frozen owner accepted');return Response.json({fragments:chunks.length,bytes:merged.length});}};`;
let mf;
try{
  mf=new Miniflare(convertV4MiniflareOptions({host:'127.0.0.1',port:0,telemetry:{enabled:false},workers:[{name:'shadow-order-fragment',compatibilityDate:'2026-11-19',durableObjects:{PROBE:{className:'Probe',useSQLite:true}},modules:[{type:'ESModule',path:'worker.mjs',contents:worker},...modules]}]}));
  const response=await mf.dispatchFetch('http://localhost/');const text=await response.text();assert.equal(response.status,200,text);const value=JSON.parse(text);assert.deepEqual(value,{fragments:3,bytes:70002});
  for(const {path,contents} of modules)assert.equal(await readFile(path,'utf8'),contents);
  const hash=x=>createHash('sha256').update(x).digest('hex');
  console.log('Workerd fenced shadow ordering fragments passed snapshot, scope and lease checks');
  console.log(JSON.stringify(Object.fromEntries(modules.map(({path,contents})=>[path,hash(contents)]))));
}finally{if(mf)await mf.dispose();}
