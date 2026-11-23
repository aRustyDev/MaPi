// Disposable local Workerd proof of the unmounted sort checkpoint seam. No
// production handler, transfer, registry, real owner, Woven or AWS is used.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';

const paths=['worker/owner-fence.js','worker/audit-source-capture.js','experiments/audit-snapshot/shadow-lifecycle.mjs','experiments/audit-snapshot/shadow-sql.mjs'];
const modules=await Promise.all(paths.map(async path=>({type:'ESModule',path,contents:await readFile(path,'utf8')})));
const baseline=JSON.parse(await readFile('worker/generated/baseline.json','utf8'));
const ddl=baseline.statements.find(s=>/^CREATE TABLE events\s*\(/.test(s));
const indexes=baseline.statements.filter(s=>/^CREATE INDEX idx_events_[a-z0-9_]+\s+ON events\s*\(/.test(s));
assert.ok(ddl);assert.equal(indexes.length,12);
const worker=`import {DurableObject} from 'cloudflare:workers';
import {initializeOwnerFence,freezeOwnerFence} from '../../worker/owner-fence.js';
import {beginShadow,acquireShadowReader,releaseShadowReader,beginShadowSort,appendShadowSortHandles,advanceShadowSort,readShadowSort,discardShadowSortStep,closeShadow,cleanupShadowStep} from './shadow-lifecycle.mjs';
const ddl=${JSON.stringify(ddl)},indexes=${JSON.stringify(indexes)};
const route={projectId:'p',origin:'https://p.invalid',objectName:'owner-p',generation:1};
const scope={id:'1'.repeat(32),epoch:'era-1',principal:'2'.repeat(64),request:'3'.repeat(64),route};
const reader='4'.repeat(32),use='5'.repeat(32),sort='6'.repeat(32),allow=()=>true;
const assert=(ok,msg)=>{if(!ok)throw Error(msg)};
const reject=(fn,part)=>{let error;try{fn()}catch(e){error=String(e)}assert(error&&error.includes(part),'Expected rejection '+part)};
export class Probe extends DurableObject {
 run() {
  const base=this.ctx.storage,q=base.sql;let inject=false;
  const storage={sql:{exec(query,...args){if(inject&&query.startsWith("UPDATE mapi_audit_shadow_sort SET state='sorting'"))throw Error('Injected checkpoint failure');return q.exec(query,...args);}},transactionSync(fn){return base.transactionSync(fn);}};
  initializeOwnerFence(storage,route);
  q.exec('CREATE TABLE mapi_recovery_epoch(epoch TEXT NOT NULL)');q.exec("INSERT INTO mapi_recovery_epoch VALUES ('era-1')");
  q.exec(ddl);for(const index of indexes)q.exec(index);
  q.exec("INSERT INTO events(project_id,id,event_type,category,occurred_at,created_at,payload,metadata) VALUES ('p','a','user.created','identity',1,1,'{}','{}'),('p','b','user.created','identity',1,2,'{}','{}'),('other','c','user.created','identity',1,3,'{}','{}')");
  beginShadow(storage,scope,ddl,indexes,allow);acquireShadowReader(storage,scope,reader,use,allow);
  assert(beginShadowSort(storage,scope,reader,use,sort,allow).version===0,'begin');
  assert(beginShadowSort(storage,scope,reader,use,sort,allow).version===0,'begin retry');
  reject(()=>releaseShadowReader(storage,scope,reader,use,allow),'sort remains active');
  reject(()=>appendShadowSortHandles(storage,scope,reader,use,sort,allow,0,['3']),'Foreign');
  reject(()=>appendShadowSortHandles(storage,scope,reader,use,sort,allow,0,Array(65).fill('1')),'batch');
  assert(appendShadowSortHandles(storage,scope,reader,use,sort,allow,0,['1','2']).version===1,'append');
  reject(()=>appendShadowSortHandles(storage,scope,reader,use,sort,allow,0,['1']),'Stale');
  assert(advanceShadowSort(storage,scope,reader,use,sort,allow,1,'initial').version===2,'seal');
  const before=JSON.stringify(readShadowSort(storage,scope,reader,use,sort,allow,0,64));
  inject=true;reject(()=>advanceShadowSort(storage,scope,reader,use,sort,allow,2,'next',[0,1]),'Injected');inject=false;
  assert(JSON.stringify(readShadowSort(storage,scope,reader,use,sort,allow,0,64))===before,'swap/checkpoint rollback');
  assert(advanceShadowSort(storage,scope,reader,use,sort,allow,2,'next',[0,1]).version===3,'swap');
  assert(readShadowSort(storage,scope,reader,use,sort,allow,0,64).items.map(x=>x.handle).join(',')==='2,1','swap contents');
  reject(()=>advanceShadowSort(storage,scope,reader,use,sort,allow,2,'next',[0,1]),'Stale');
  let d=discardShadowSortStep(storage,scope,reader,use,sort,allow,1);assert(!d.complete&&d.removed===1,'first discard');
  d=discardShadowSortStep(storage,scope,reader,use,sort,allow,1);assert(d.complete&&d.removed===1,'final discard');
  d=discardShadowSortStep(storage,scope,reader,use,sort,allow,1);assert(d.complete&&d.removed===0,'lost discard acknowledgment');
  reject(()=>beginShadowSort(storage,scope,reader,use,sort,allow),'cannot be reused');
  releaseShadowReader(storage,scope,reader,use,allow);
  const r2='7'.repeat(32),u2='8'.repeat(32),s2='9'.repeat(32);
  acquireShadowReader(storage,scope,r2,u2,allow);beginShadowSort(storage,scope,r2,u2,s2,allow);
  freezeOwnerFence(storage,route,'move');
  reject(()=>appendShadowSortHandles(storage,scope,r2,u2,s2,allow,0,['1']),'fenced');
  assert(q.exec('SELECT count FROM mapi_audit_shadow_sort WHERE sort_id=?',s2).one().count===0,'frozen checkpoint changed');
  // Test-only reset of the synthetic fence checks cleanup; it is not a
  // supported unfreeze or recovery operation.
  q.exec("UPDATE mapi_owner_fence SET state='active',move_id=NULL WHERE singleton=1");
  d=discardShadowSortStep(storage,scope,r2,u2,s2,allow,64);assert(d.complete&&d.removed===0,'empty discard');
  releaseShadowReader(storage,scope,r2,u2,allow);closeShadow(storage,scope,allow);
  let cleaned;do{cleaned=cleanupShadowStep(storage,scope,allow,64)}while(!cleaned.complete);
  assert(q.exec("SELECT COUNT(*) AS n FROM sqlite_schema WHERE name IN ('mapi_audit_shadow_sort','mapi_audit_shadow_sort_items')").one().n===0,'sort cleanup');
  return true;
 }
}
export default {async fetch(req,env){return new Response(await env.PROBE.getByName('sort-checkpoint').run()?'ok':'failed')}};`;
let mf;
try{
 mf=new Miniflare(convertV4MiniflareOptions({host:'127.0.0.1',port:0,telemetry:{enabled:false},workers:[{
  name:'shadow-sort-checkpoint',compatibilityDate:'2026-11-18',durableObjects:{PROBE:{className:'Probe',useSQLite:true}},
  modules:[{type:'ESModule',path:'experiments/audit-snapshot/sort-checkpoint-worker.mjs',contents:worker},...modules],
 }]}));
 const response=await mf.dispatchFetch('http://localhost/');const body=await response.text();assert.equal(response.status,200,body);assert.equal(body,'ok');
 for(const {path,contents} of modules)assert.equal(await readFile(path,'utf8'),contents);
 const sha=value=>createHash('sha256').update(value).digest('hex');
 console.log('Local Workerd shadow checkpoint, rollback, lease, freeze and discard checks passed');
 console.log(JSON.stringify({lifecycle:sha(modules.find(m=>m.path.endsWith('shadow-lifecycle.mjs')).contents),worker:sha(worker)}));
}finally{if(mf)await mf.dispose()}
