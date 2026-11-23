// Unmounted lifecycle seam only; no real handler, payload transfer, owner,
// hosted service, or claim that an opaque program is a correct Go sort.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {DatabaseSync} from 'node:sqlite';
import {initializeOwnerFence,freezeOwnerFence} from '../../worker/owner-fence.js';
import {beginShadow,acquireShadowReader,releaseShadowReader,beginShadowSort,appendShadowSortHandles,advanceShadowSort,readShadowSort,discardShadowSortStep,closeShadow,cleanupShadowStep} from './shadow-lifecycle.mjs';
const baseline=JSON.parse(await readFile('worker/generated/baseline.json','utf8'));
const ddl=baseline.statements.find(s=>/^CREATE TABLE events\s*\(/.test(s));
const indexes=baseline.statements.filter(s=>/^CREATE INDEX idx_events_[a-z0-9_]+\s+ON events\s*\(/.test(s));
assert.ok(ddl);assert.equal(indexes.length,12);
const db=new DatabaseSync(':memory:'); let inject=false;
try {
 const storage={sql:{exec(query,...args){
   if(inject && query.startsWith("UPDATE mapi_audit_shadow_sort SET state='sorting'")) throw Error('Injected checkpoint failure');
   const stmt=db.prepare(query),result=stmt.columns().length?stmt.all(...args):(stmt.run(...args),[]);return {toArray:()=>result,one:()=>result[0]};
 }},transactionSync(fn){db.exec('BEGIN');try{const result=fn();db.exec('COMMIT');return result;}catch(error){db.exec('ROLLBACK');throw error;}}};
 const route={projectId:'p',origin:'https://p.invalid',objectName:'owner-p',generation:1};
 const scope={id:'1'.repeat(32),epoch:'era-1',principal:'2'.repeat(64),request:'3'.repeat(64),route};
 const reader='4'.repeat(32),use='5'.repeat(32),sort='6'.repeat(32),allow=()=>true;
 initializeOwnerFence(storage,route);
 db.exec("CREATE TABLE mapi_recovery_epoch(epoch TEXT NOT NULL); INSERT INTO mapi_recovery_epoch VALUES ('era-1')");
 db.exec(ddl);for(const index of indexes)db.exec(index);
 db.exec("INSERT INTO events(project_id,id,event_type,category,occurred_at,created_at,payload,metadata) VALUES ('p','a','user.created','identity',1,1,'{}','{}'),('p','b','user.created','identity',1,2,'{}','{}'),('other','c','user.created','identity',1,3,'{}','{}')");
 beginShadow(storage,scope,ddl,indexes,allow);acquireShadowReader(storage,scope,reader,use,allow);
 assert.equal(beginShadowSort(storage,scope,reader,use,sort,allow).version,0);
 assert.equal(beginShadowSort(storage,scope,reader,use,sort,allow).version,0);
 assert.throws(()=>releaseShadowReader(storage,scope,reader,use,allow),/sort remains active/);
 assert.throws(()=>appendShadowSortHandles(storage,scope,reader,use,sort,allow,0,['3']),/Foreign/);
 assert.throws(()=>appendShadowSortHandles(storage,scope,reader,use,sort,allow,0,Array(65).fill('1')),/batch/);
 assert.equal(appendShadowSortHandles(storage,scope,reader,use,sort,allow,0,['1','2']).version,1);
 assert.throws(()=>appendShadowSortHandles(storage,scope,reader,use,sort,allow,0,['1']),/Stale/);
 assert.equal(advanceShadowSort(storage,scope,reader,use,sort,allow,1,'initial').version,2);
 const before=readShadowSort(storage,scope,reader,use,sort,allow,0,64);
 inject=true;assert.throws(()=>advanceShadowSort(storage,scope,reader,use,sort,allow,2,'next',[0,1]),/Injected/);inject=false;
 assert.deepEqual(readShadowSort(storage,scope,reader,use,sort,allow,0,64),before);
 assert.equal(advanceShadowSort(storage,scope,reader,use,sort,allow,2,'next',[0,1]).version,3);
 assert.deepEqual(readShadowSort(storage,scope,reader,use,sort,allow,0,64).items.map(x=>x.handle),['2','1']);
 assert.throws(()=>advanceShadowSort(storage,scope,reader,use,sort,allow,2,'next',[0,1]),/Stale/);
 assert.deepEqual(discardShadowSortStep(storage,scope,reader,use,sort,allow,1),{complete:false,removed:1});
 assert.deepEqual(discardShadowSortStep(storage,scope,reader,use,sort,allow,1),{complete:true,removed:1});
 assert.deepEqual(discardShadowSortStep(storage,scope,reader,use,sort,allow,1),{complete:true,removed:0});
 assert.throws(()=>beginShadowSort(storage,scope,reader,use,sort,allow),/cannot be reused/);
 releaseShadowReader(storage,scope,reader,use,allow);
 const r2='7'.repeat(32),u2='8'.repeat(32),s2='9'.repeat(32);
 acquireShadowReader(storage,scope,r2,u2,allow);beginShadowSort(storage,scope,r2,u2,s2,allow);
 freezeOwnerFence(storage,route,'move');
 assert.throws(()=>appendShadowSortHandles(storage,scope,r2,u2,s2,allow,0,['1']),/fenced|stale/i);
 assert.equal(db.prepare('SELECT count FROM mapi_audit_shadow_sort WHERE sort_id=?').get(s2).count,0);
 // Test-only reset of the synthetic fence allows the same fixture to exercise
 // cleanup; it is not a supported unfreeze or recovery operation.
 db.exec("UPDATE mapi_owner_fence SET state='active',move_id=NULL WHERE singleton=1");
 assert.deepEqual(discardShadowSortStep(storage,scope,r2,u2,s2,allow,64),{complete:true,removed:0});
 releaseShadowReader(storage,scope,r2,u2,allow);closeShadow(storage,scope,allow);
 let cleanup; do {cleanup=cleanupShadowStep(storage,scope,allow,64);} while(!cleanup.complete);
 assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_schema WHERE name IN ('mapi_audit_shadow_sort','mapi_audit_shadow_sort_items')").get().n,0);
 console.log('Native shadow sort checkpoint, lease, rollback and freeze checks passed');
} finally {db.close();}
