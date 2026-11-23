// Disposable Workerd proof for the unmounted sort checkpoint across one
// object abort/restart. Synthetic authorization only; no real owner, public
// handler, deferred transfer, registry, Woven deployment or AWS resource.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';

const paths=['worker/owner-fence.js','worker/audit-source-capture.js','experiments/audit-snapshot/shadow-lifecycle.mjs','experiments/audit-snapshot/shadow-sql.mjs'];
const modules=await Promise.all(paths.map(async path=>({type:'ESModule',path,contents:await readFile(path,'utf8')})));
const baseline=JSON.parse(await readFile('worker/generated/baseline.json','utf8'));
const ddl=baseline.statements.find(s=>/^CREATE TABLE events\s*\(/.test(s));
const indexes=baseline.statements.filter(s=>/^CREATE INDEX idx_events_[a-z0-9_]+\s+ON events\s*\(/.test(s));
assert.ok(ddl); assert.equal(indexes.length,12);
const worker=`import {DurableObject} from 'cloudflare:workers';
import {initializeOwnerFence,freezeOwnerFence} from '../../worker/owner-fence.js';
import {beginShadow,acquireShadowReader,releaseShadowReader,beginShadowSort,appendShadowSortHandles,advanceShadowSort,readShadowSort,discardShadowSortStep} from './shadow-lifecycle.mjs';
const ddl=${JSON.stringify(ddl)},indexes=${JSON.stringify(indexes)};
const route={projectId:'p',origin:'https://p.invalid',objectName:'owner-p',generation:1};
const scope={id:'1'.repeat(32),epoch:'era-1',principal:'2'.repeat(64),request:'3'.repeat(64),route};
const reader='4'.repeat(32),use='5'.repeat(32),sort='6'.repeat(32),allow=()=>true;
const assert=(ok,msg)=>{if(!ok)throw Error(msg)};
const reject=(fn,part)=>{let error;try{fn()}catch(e){error=String(e)}assert(error&&error.includes(part),'Expected rejection '+part)};
export class Probe extends DurableObject {
 boot=crypto.randomUUID();
 async setup() {
  const s=this.ctx.storage,q=s.sql;
  initializeOwnerFence(s,route);
  q.exec('CREATE TABLE mapi_recovery_epoch(epoch TEXT NOT NULL)');q.exec("INSERT INTO mapi_recovery_epoch VALUES ('era-1')");
  q.exec(ddl);for(const index of indexes)q.exec(index);
  q.exec("INSERT INTO events(project_id,id,event_type,category,occurred_at,created_at,payload,metadata) VALUES ('p','a','user.created','identity',1,1,'{}','{}'),('p','b','user.created','identity',1,2,'{}','{}')");
  beginShadow(s,scope,ddl,indexes,allow);acquireShadowReader(s,scope,reader,use,allow);
  beginShadowSort(s,scope,reader,use,sort,allow);appendShadowSortHandles(s,scope,reader,use,sort,allow,0,['1','2']);
  advanceShadowSort(s,scope,reader,use,sort,allow,1,'initial');
  advanceShadowSort(s,scope,reader,use,sort,allow,2,'after-swap',[0,1]);
  await s.sync();
  return {boot:this.boot,checkpoint:readShadowSort(s,scope,reader,use,sort,allow,0,64)};
 }
 evict(){this.ctx.abort('synthetic eviction');}
 async resume() {
  const s=this.ctx.storage;
  const checkpoint=readShadowSort(s,scope,reader,use,sort,allow,0,64);
  assert(checkpoint.job.version===3&&checkpoint.job.program==='after-swap','checkpoint lost');
  assert(checkpoint.items.map(x=>x.handle).join(',')==='2,1','spool lost');
  reject(()=>releaseShadowReader(s,scope,reader,use,allow),'sort remains active');
  reject(()=>advanceShadowSort(s,scope,reader,use,sort,allow,2,'stale',[0,1]),'Stale');
  advanceShadowSort(s,scope,reader,use,sort,allow,3,'resumed',[0,1]);
  const resumed=readShadowSort(s,scope,reader,use,sort,allow,0,64);
  assert(resumed.job.version===4&&resumed.job.program==='resumed'&&resumed.items.map(x=>x.handle).join(',')==='1,2','resume failed');
  await s.sync(); return {boot:this.boot,resumed};
 }
 async freezeAndCheck() {
  const s=this.ctx.storage; freezeOwnerFence(s,route,'move');
  reject(()=>advanceShadowSort(s,scope,reader,use,sort,allow,4,'later',[0,1]),'fenced');
  assert(s.sql.exec('SELECT version FROM mapi_audit_shadow_sort WHERE sort_id=?',sort).one().version===4,'frozen checkpoint changed');
  await s.sync(); return {boot:this.boot};
 }
}
export default {async fetch(req,env){
  let owner=env.PROBE.getByName('eviction');const before=await owner.setup();
  try{await owner.evict()}catch{}
  owner=env.PROBE.getByName('eviction');const after=await owner.resume();
  if(!before.boot||!after.boot||before.boot===after.boot)throw Error('Owner instance did not restart');
  const frozen=await owner.freezeAndCheck(); if(frozen.boot!==after.boot)throw Error('Unexpected extra restart');
  return new Response('ok');
}};`;
let mf;
try {
  mf=new Miniflare(convertV4MiniflareOptions({host:'127.0.0.1',port:0,telemetry:{enabled:false},workers:[{
    name:'shadow-sort-eviction',compatibilityDate:'2026-11-18',durableObjects:{PROBE:{className:'Probe',useSQLite:true}},
    modules:[{type:'ESModule',path:'experiments/audit-snapshot/eviction-worker.mjs',contents:worker},...modules],
  }]}));
  const response=await mf.dispatchFetch('http://localhost/');const body=await response.text();assert.equal(response.status,200,body);assert.equal(body,'ok');
  for(const {path,contents} of modules)assert.equal(await readFile(path,'utf8'),contents);
  const sha=value=>createHash('sha256').update(value).digest('hex');
  console.log('Local Workerd shadow checkpoint survived synthetic object eviction, resumed and stayed fenced');
  console.log(JSON.stringify({lifecycle:sha(modules.find(m=>m.path.endsWith('shadow-lifecycle.mjs')).contents),worker:sha(worker)}));
} finally {if(mf)await mf.dispose();}
