// Unmounted lifecycle seam with disposable Workerd SQLite. No real Go
// authorization, production owner, handler, transfer, registry or cloud.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';

const baseline=JSON.parse(await readFile('worker/generated/baseline.json','utf8'));
const ddl=baseline.statements.find(s=>/^CREATE TABLE events\s*\(/.test(s));
const indexes=baseline.statements.filter(s=>/^CREATE INDEX idx_events_[a-z0-9_]+\s+ON events\s*\(/.test(s));
assert.ok(ddl); assert.equal(indexes.length,12);
const paths=['worker/owner-fence.js','worker/audit-source-capture.js','experiments/audit-snapshot/shadow-sql.mjs','experiments/audit-snapshot/shadow-lifecycle.mjs'];
const modules=await Promise.all(paths.map(async path=>({type:'ESModule',path,contents:await readFile(path,'utf8')})));
const worker=`import {DurableObject} from 'cloudflare:workers';
import {initializeOwnerFence} from '../../worker/owner-fence.js';
import {beginShadow,beginShadowInTransaction,shadowStatus} from './shadow-lifecycle.mjs';
const ddl=${JSON.stringify(ddl)},indexes=${JSON.stringify(indexes)};
const route={projectId:'p',origin:'https://p.invalid',objectName:'owner-p',generation:1};
const scope={id:'1'.repeat(32),epoch:'era-1',principal:'2'.repeat(64),request:'3'.repeat(64),route};
export class Probe extends DurableObject {
 run() {
  const s=this.ctx.storage,q=s.sql;
  initializeOwnerFence(s,route);
  q.exec('CREATE TABLE mapi_recovery_epoch(epoch TEXT NOT NULL)'); q.exec("INSERT INTO mapi_recovery_epoch VALUES ('era-1')");
  q.exec(ddl); for(const index of indexes)q.exec(index);
  q.exec('CREATE TABLE business_marker(v INTEGER NOT NULL)');
  let denied=false;
  try{s.transactionSync(()=>beginShadowInTransaction(s,scope,ddl,indexes,()=>false));}catch(e){denied=String(e).includes('Shadow authority denied')}
  if(!denied)throw Error('Authorization denial missing');
  let rolledBack=false;
  try{s.transactionSync(()=>{q.exec('INSERT INTO business_marker VALUES (1)');beginShadowInTransaction(s,scope,ddl,indexes,()=>true);throw Error('injected outer failure')})}catch(e){rolledBack=String(e).includes('injected outer failure')}
  if(!rolledBack||q.exec('SELECT count(*) AS n FROM business_marker').one().n!==0||q.exec("SELECT count(*) AS n FROM sqlite_schema WHERE lower(name) GLOB 'mapi_shadow_*' OR lower(name) GLOB 'mapi_audit_shadow_*'").one().n!==0)throw Error('Outer rollback failed');
  s.transactionSync(()=>{q.exec('INSERT INTO business_marker VALUES (2)');beginShadowInTransaction(s,scope,ddl,indexes,()=>true)});
  if(q.exec('SELECT count(*) AS n FROM business_marker').one().n!==1||shadowStatus(s,scope,()=>true).state!=='active')throw Error('Outer commit failed');
  let duplicate=false;try{beginShadow(s,scope,ddl,indexes,()=>true)}catch(e){duplicate=String(e).includes('Shadow already exists')}
  if(!duplicate)throw Error('Existing wrapper semantics changed');
  return true;
 }
}
export default {async fetch(req,env){return new Response(await env.PROBE.getByName('begin').run()?'ok':'failed')}};`;
const sha=x=>createHash('sha256').update(x).digest('hex');
let mf;
try {
 mf=new Miniflare(convertV4MiniflareOptions({host:'127.0.0.1',port:0,telemetry:{enabled:false},workers:[{name:'shadow-begin-transaction',compatibilityDate:'2026-11-18',durableObjects:{PROBE:{className:'Probe',useSQLite:true}},modules:[{type:'ESModule',path:'experiments/audit-snapshot/begin-worker.mjs',contents:worker},...modules]}]}));
 const response=await mf.dispatchFetch('http://localhost/'), body=await response.text(); assert.equal(response.status,200,body); assert.equal(body,'ok');
 for(const {path,contents} of modules) assert.equal(await readFile(path,'utf8'),contents);
 console.log('Local Workerd caller-held shadow begin: denial, rollback, commit and wrapper checks passed');
 console.log(JSON.stringify({lifecycle:sha(modules.find(m=>m.path.endsWith('shadow-lifecycle.mjs')).contents),worker:sha(worker)}));
} finally {if(mf)await mf.dispose()}
