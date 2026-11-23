// Disposable Workerd SQLite test for the unmounted audit shadow guards. No Go
// handler, transfer, actual owner, registry, hosted deployment or AWS access.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

const files = [
  ['worker/owner-fence.js', 'worker/owner-fence.js'],
  ['worker/audit-source-capture.js', 'worker/audit-source-capture.js'],
  ['experiments/audit-snapshot/shadow-lifecycle.mjs', 'experiments/audit-snapshot/shadow-lifecycle.mjs'],
  ['experiments/audit-snapshot/shadow-sql.mjs', 'experiments/audit-snapshot/shadow-sql.mjs'],
];
const modules = await Promise.all(files.map(async ([path,filename]) => ({type:'ESModule',path,contents:await readFile(filename,'utf8')})));
const baseline=JSON.parse(await readFile('worker/generated/baseline.json','utf8'));
const ddl=baseline.statements.find(s=>/^CREATE TABLE events\s*\(/.test(s));
const indexes=baseline.statements.filter(s=>/^CREATE INDEX idx_events_[a-z0-9_]+\s+ON events\s*\(/.test(s));
assert.ok(ddl); assert.equal(indexes.length,12);
const worker=`import { DurableObject } from 'cloudflare:workers';
import { initializeOwnerFence } from '../../worker/owner-fence.js';
import { beginShadow, shadowStatus, acquireShadowReader, releaseShadowReader, withShadowReader } from './shadow-lifecycle.mjs';
const ddl=${JSON.stringify(ddl)}, indexes=${JSON.stringify(indexes)};
const route={projectId:'p',origin:'https://p.invalid',objectName:'owner-p',generation:1};
const scope={id:'1'.repeat(32),epoch:'era-1',principal:'2'.repeat(64),request:'3'.repeat(64),route};
const allow=()=>true, reader='4'.repeat(32), use='5'.repeat(32);
export class Probe extends DurableObject {
  run(kind) {
    const s=this.ctx.storage, q=s.sql;
    initializeOwnerFence(s,route);
    q.exec("CREATE TABLE mapi_recovery_epoch(epoch TEXT NOT NULL)"); q.exec("INSERT INTO mapi_recovery_epoch VALUES ('era-1')");
    q.exec(ddl); for(const index of indexes) q.exec(index);
    q.exec('CREATE TABLE marker(n INTEGER NOT NULL)');
    if(kind==='event-trigger') {
      try { q.exec('CREATE TEMP TRIGGER arbitrary AFTER INSERT ON main.events BEGIN INSERT INTO marker VALUES (1); END'); }
      catch(e) { return {kind,created:false,error:String(e).slice(0,256)}; }
      let denied=false; try { beginShadow(s,scope,ddl,indexes,allow); } catch(e) { denied=String(e).includes('Invalid shadow temporary schema'); }
      if(!denied || q.exec("SELECT count(*) AS n FROM sqlite_schema WHERE name GLOB 'mapi_shadow_*'").one().n!==0) throw Error('Event trigger accepted');
      return {kind,created:true,denied};
    }
    beginShadow(s,scope,ddl,indexes,allow);
    if(kind==='authorization-write') {
      const mutate=()=>{ q.exec('INSERT INTO marker VALUES (1)'); q.exec('DELETE FROM marker'); return true; };
      let denied=false; try { acquireShadowReader(s,scope,reader,use,mutate); } catch(e) { denied=String(e).includes('Shadow authority must be read-only'); }
      if(!denied || q.exec('SELECT COUNT(*) AS n FROM marker').one().n!==0 || q.exec('SELECT COUNT(*) AS n FROM mapi_audit_shadow_readers').one().n!==0) throw Error('Mutating authorization accepted');
      return {kind,denied};
    }
    if(kind==='reader-write') {
      acquireShadowReader(s,scope,reader,use,allow);
      const mutate=()=>{ q.exec('INSERT INTO marker VALUES (1)'); q.exec('DELETE FROM marker'); return new Uint8Array([1]); };
      let denied=false; try { withShadowReader(s,scope,reader,use,allow,mutate); } catch(e) { denied=String(e).includes('Shadow read must be read-only'); }
      if(!denied || q.exec('SELECT COUNT(*) AS n FROM marker').one().n!==0 || q.exec("SELECT COUNT(*) AS n FROM mapi_audit_shadow_readers WHERE state='active'").one().n!==1) throw Error('Mutating reader accepted');
      return {kind,denied};
    }
    if(kind==='reader-trigger') {
      try { q.exec('CREATE TEMP TRIGGER arbitrary AFTER INSERT ON main.mapi_audit_shadow_readers BEGIN INSERT INTO marker VALUES (1); END'); }
      catch(e) { return {kind,created:false,error:String(e).slice(0,256)}; }
      let denied=false; try { acquireShadowReader(s,scope,reader,use,allow); } catch(e) { denied=String(e).includes('Invalid shadow temporary schema'); }
      if(!denied || q.exec('SELECT COUNT(*) AS n FROM marker').one().n!==0 || q.exec('SELECT COUNT(*) AS n FROM main.mapi_audit_shadow_readers').one().n!==0) throw Error('Reader trigger accepted');
      return {kind,created:true,denied};
    }
    if(kind==='shadow') {
      try { q.exec('CREATE TEMP TABLE MAPI_AUDIT_SHADOW_READERS(reader_id TEXT, use_id TEXT, state TEXT)'); }
      catch(e) { return {kind,created:false,error:String(e).slice(0,256)}; }
      let denied=false; try { acquireShadowReader(s,scope,reader,use,allow); } catch(e) { denied=String(e).includes('Invalid shadow temporary schema'); }
      if(!denied) throw Error('Shadow accepted');
      return {kind,created:true,denied};
    }
    acquireShadowReader(s,scope,reader,use,allow); releaseShadowReader(s,scope,reader,use,allow);
    if(shadowStatus(s,scope,allow).state!=='active') throw Error('Normal lifecycle failed');
    return {kind,normal:true};
  }
}
export default {async fetch(req,env) { const out=[]; for(const kind of ['normal','event-trigger','reader-trigger','shadow','authorization-write','reader-write']) out.push(await env.PROBE.getByName(kind).run(kind)); return Response.json(out); }};`;
let mf;
try {
  mf=new Miniflare(convertV4MiniflareOptions({host:'127.0.0.1',port:0,telemetry:{enabled:false},workers:[{
    name:'audit-shadow-guards',compatibilityDate:'2026-11-18',durableObjects:{PROBE:{className:'Probe',useSQLite:true}},
    modules:[{type:'ESModule',path:'experiments/audit-snapshot/guard-worker.mjs',contents:worker},...modules],
  }]}));
  const response=await mf.dispatchFetch('http://localhost/'); const body=await response.text();
  assert.equal(response.status,200,body); const result=JSON.parse(body);
  assert.equal(result[0].normal,true);
  for(const item of result.slice(1)) if(item.created || item.kind==='authorization-write' || item.kind==='reader-write') assert.equal(item.denied,true);
  for(const {path,contents} of modules) assert.equal(await readFile(path,'utf8'),contents);
  const hash = value => createHash('sha256').update(value).digest('hex');
  console.log('Local Workerd audit shadow guards:',JSON.stringify(result));
  console.log('Source hashes:',JSON.stringify(Object.fromEntries(modules.map(({path,contents})=>[path,hash(contents)]))));
} finally { if(mf) await mf.dispose(); }
