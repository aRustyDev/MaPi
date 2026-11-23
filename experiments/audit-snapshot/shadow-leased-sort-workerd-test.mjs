// Local diagnostic: the Go external sort, an SQL spool and leased fragmented
// timestamp/ID reads. This is not the public handler, row transfer, actual
// owner, hosted service, or a production authorization boundary.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

const go='/Users/asmith/go/pkg/mod/golang.org/toolchain@v0.0.1-go1.26.9.darwin-arm64/bin/go';
const base='experiments/audit-snapshot/';
const original=await readFile(base+'nextgen-overlay/apps/api/internal/storage/events/external_handle_sort_diagnostic.go','utf8');
const adapter=await readFile(base+'shadow-external-sort-wasip1.go','utf8');
const baseline=JSON.parse(await readFile('worker/generated/baseline.json','utf8'));
const ddl=baseline.statements.find(s=>/^CREATE TABLE events\s*\(/.test(s));
const indexes=baseline.statements.filter(s=>/^CREATE INDEX idx_events_[a-z0-9_]+\s+ON events\s*\(/.test(s));
assert.ok(ddl); assert.equal(indexes.length,12);
// Equal bytes in text and BLOB storage force a comparator tie without a
// duplicate SQLite key. Values are valid UTF-8; malformed TEXT is not tested.
const fixtures=Array.from({length:29},(_,i)=>({handle:i+1,id:'key-'+String((i*13)%29).padStart(2,'0'),nano:String((i%5)-2),blob:false}));
fixtures.push({handle:30,id:'tie',nano:'1000000000000000000',blob:false},{handle:31,id:'tie',nano:'1000000000000000000',blob:true},
  {handle:32,id:'x'.repeat(70000)+'a',nano:'1',blob:false},{handle:33,id:'x'.repeat(70000)+'b',nano:'1',blob:false},
  {handle:34,id:'x'.repeat(70000),nano:'1',blob:false},{handle:35,id:'é',nano:'-9223372036854775808',blob:false},
  {handle:36,id:'max',nano:'9223372036854775807',blob:false});
const env={...process.env,GOTOOLCHAIN:'go1.26.9',GOPROXY:'off',GOWORK:'off',GOCACHE:'/private/tmp/mapi-shadow-external-sort-cache'};
const expected=Object.fromEntries(['asc','desc'].map(direction=>[direction,JSON.parse(execFileSync(go,['run',base+'shadow-order-oracle.go'],{env,input:JSON.stringify({events:fixtures,direction}),maxBuffer:1024*1024}).toString()).map(x=>x.handle)]));
const dir=await mkdtemp(resolve(tmpdir(),'mapi-shadow-sort-'));
let mf;
try {
  const sort=resolve(dir,'sort.go'), main=resolve(dir,'main.go'), wasm=resolve(dir,'sort.wasm');
  await writeFile(sort,original.replace(/^package events$/m,'package main'));
  await writeFile(main,adapter);
  execFileSync(go,['build','-buildmode=c-shared','-o',wasm,main,sort],{env:{...env,GOOS:'wasip1',GOARCH:'wasm',CGO_ENABLED:'0'},stdio:'pipe'});
  const paths=['worker/wasi.js','worker/owner-fence.js','worker/audit-source-capture.js',
    base+'shadow-leased-order-compare.mjs',base+'shadow-order-fragment.mjs',base+'shadow-sql.mjs',base+'shadow-lifecycle.mjs'];
  const modules=await Promise.all(paths.map(async path=>({type:'ESModule',path,contents:await readFile(path,'utf8')})));
  const worker=`import {DurableObject} from 'cloudflare:workers';
import wasm from './sort.wasm';
import {instantiateReactor} from './worker/wasi.js';
import {initializeOwnerFence} from './worker/owner-fence.js';
import {beginShadow,acquireShadowReader,releaseShadowReader} from './experiments/audit-snapshot/shadow-lifecycle.mjs';
import {compareLeasedShadowEvents} from './experiments/audit-snapshot/shadow-leased-order-compare.mjs';
const ddl=${JSON.stringify(ddl)}, indexes=${JSON.stringify(indexes)}, fixtures=${JSON.stringify(fixtures)};
const route={projectId:'p',origin:'https://p.invalid',objectName:'owner-p',generation:1};
const scope={id:'1'.repeat(32),epoch:'era-1',principal:'2'.repeat(64),request:'3'.repeat(64),route};
const reader='4'.repeat(32),use='5'.repeat(32),allow=()=>true;
export class Probe extends DurableObject { run() {
 const storage=this.ctx.storage,q=storage.sql; initializeOwnerFence(storage,route);
 q.exec('CREATE TABLE mapi_recovery_epoch(epoch TEXT NOT NULL)'); q.exec("INSERT INTO mapi_recovery_epoch VALUES ('era-1')");
 q.exec(ddl); for(const index of indexes) q.exec(index);
 for(const item of fixtures) {
   const id=item.blob?new TextEncoder().encode(item.id).buffer:item.id;
   q.exec("INSERT INTO events(project_id,id,event_type,category,occurred_at,created_at,payload,metadata) VALUES ('p',?,'user.created','identity',1,CAST(? AS INTEGER),'{}','{}')",id,item.nano);
 }
 q.exec("INSERT INTO events(project_id,id,event_type,category,occurred_at,created_at,payload,metadata) VALUES ('other','foreign','user.created','identity',1,1,'{}','{}')");
 beginShadow(storage,scope,ddl,indexes,allow); acquireShadowReader(storage,scope,reader,use,allow);
 q.exec("DELETE FROM events WHERE project_id='p' AND id='key-00'");
 q.exec("INSERT INTO events(project_id,id,event_type,category,occurred_at,created_at,payload,metadata) VALUES ('p','new','user.created','identity',1,1,'{}','{}')");
 q.exec('CREATE TABLE diagnostic_sort_spool(pos INTEGER PRIMARY KEY, handle INTEGER NOT NULL)');
 const handles=q.exec("SELECT CAST(source_rowid AS TEXT) AS handle FROM mapi_shadow_snapshot WHERE project_id='p' ORDER BY source_rowid").toArray();
 if(handles.length!==fixtures.length) throw Error('snapshot selection mismatch');
 for(let i=0;i<handles.length;i++) q.exec('INSERT INTO diagnostic_sort_spool VALUES (?, CAST(? AS INTEGER))',i,handles[i].handle);
 let maxPart=0, comparisons=0, swaps=0, failAfter=0, direction='asc';
 const observed={transactionSync(fn){return storage.transactionSync(fn)},sql:{exec(query,...args){
   const cursor=q.exec(query,...args); if(!query.includes('substr('))return cursor;
   return {toArray(){const result=cursor.toArray();for(const row of result)maxPart=Math.max(maxPart,row.fragment.byteLength);return result;}};
 }}};
 const compare=(a,b)=>compareLeasedShadowEvents(observed,scope,reader,use,allow,a,b,direction);
 const get=i=>q.exec('SELECT CAST(handle AS TEXT) AS h FROM diagnostic_sort_spool WHERE pos=?',i).one().h;
 const reactor=instantiateReactor(wasm,()=>({
  spool_get(i){ try {return BigInt(get(i));} catch{return 0n;} },
  spool_swap(i,j){ try {if(i===j)return 0;const a=get(i),b=get(j);q.exec('UPDATE diagnostic_sort_spool SET handle=CASE pos WHEN ? THEN CAST(? AS INTEGER) ELSE CAST(? AS INTEGER) END WHERE pos IN (?,?)',i,b,a,i,j); if(q.exec('SELECT changes() AS n').one().n!==2 || get(i)!==b || get(j)!==a)return 1;swaps++;return 0;}catch{return 1;} },
  spool_compare(a,b){ try { comparisons++; if(failAfter && comparisons>=failAfter) return 2; return compare(String(a),String(b)); }catch{return 2;} },
 }));
 const state=()=>q.exec('SELECT CAST(handle AS TEXT) AS h FROM diagnostic_sort_spool ORDER BY pos').toArray().map(x=>x.h);
 const original=JSON.stringify(state()); failAfter=12;
 let failed=false; try {storage.transactionSync(()=>{if(reactor.sort_shadow_handles(handles.length)!==0)throw Error('sort failed');});} catch {failed=true;}
 if(!failed || swaps===0 || JSON.stringify(state())!==original)throw Error('sort failure did not roll back swaps');
 comparisons=0; failAfter=0;
 storage.transactionSync(()=>{if(reactor.sort_shadow_handles(handles.length)!==0)throw Error('sort failed');});
 const asc=state().map(Number);
 storage.transactionSync(()=>{for(let i=0;i<handles.length;i++)q.exec('UPDATE diagnostic_sort_spool SET handle=CAST(? AS INTEGER) WHERE pos=?',handles[i].handle,i);});
 direction='desc'; storage.transactionSync(()=>{if(reactor.sort_shadow_handles(handles.length)!==0)throw Error('descending sort failed');});
 const desc=state().map(Number);
 let foreign=false;try {compare(handles[0].handle,'37');}catch{foreign=true;} if(!foreign)throw Error('foreign event accepted');
 releaseShadowReader(storage,scope,reader,use,allow);
 let released=false;try {compare(handles[0].handle,handles[1].handle);}catch{released=true;} if(!released)throw Error('released lease accepted');
 return {asc,desc,maxPart,comparisons};
} }
export default {async fetch(req,env){return Response.json(await env.PROBE.getByName('sort').run());}};`;
  mf=new Miniflare(convertV4MiniflareOptions({host:'127.0.0.1',port:0,telemetry:{enabled:false},workers:[{
    name:'audit-shadow-sort',compatibilityDate:'2026-11-19',durableObjects:{PROBE:{className:'Probe',useSQLite:true}},
    modules:[{type:'ESModule',path:'worker.mjs',contents:worker},{type:'CompiledWasm',path:'sort.wasm',contents:await readFile(wasm)},...modules],
  }]}));
  const response=await mf.dispatchFetch('http://localhost/'); const text=await response.text(); assert.equal(response.status,200,text);
  const actual=JSON.parse(text); assert.deepEqual(actual.asc,expected.asc); assert.deepEqual(actual.desc,expected.desc); assert.ok(actual.comparisons>0); assert.ok(actual.maxPart<=32768 && actual.maxPart>0);
  for(const {path,contents} of modules) assert.equal(await readFile(path,'utf8'),contents);
  const hash=x=>createHash('sha256').update(x).digest('hex');
  console.log('Local Workerd leased external sort matched pinned Go timestamp/ID slice order; rollback, scope and release checks passed');
  console.log(JSON.stringify({handles:actual.asc.length,comparisons:actual.comparisons,maxFragment:actual.maxPart,wasm:hash(await readFile(wasm)),modules:Object.fromEntries(modules.map(({path,contents})=>[path,hash(contents)]))}));
} finally { if(mf)await mf.dispose(); await rm(dir,{recursive:true,force:true}); }
