// Disposable native SQLite lifecycle test; not an owner, Workerd or hosted test.
import assert from 'node:assert/strict';
import {readFile, mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {initializeOwnerFence, freezeOwnerFence} from '../../worker/owner-fence.js';
import {beginShadow, shadowStatus, acquireShadowReader, withShadowReader, releaseShadowReader, closeShadow, cleanupShadowStep} from './shadow-lifecycle.mjs';

const baseline=JSON.parse(await readFile(new URL('../../worker/generated/baseline.json',import.meta.url),'utf8'));
const ddl=baseline.statements.find(s=>/^CREATE TABLE events\s*\(/.test(s));
const indexes=baseline.statements.filter(s=>/^CREATE INDEX idx_events_[a-z0-9_]+\s+ON events\s*\(/.test(s));
assert.ok(ddl); assert.equal(indexes.length,12);
const dir=await mkdtemp(join(tmpdir(),'mapi-shadow-lifecycle-'));
let db;
try {
  const path=join(dir,'fixture.sqlite');
  const open=()=>{db=new DatabaseSync(path);db.exec('PRAGMA recursive_triggers=OFF');};
  open();
  const storage={sql:{exec(query,...args){const s=db.prepare(query);const result=s.columns().length?s.all(...args):(s.run(...args),[]);return {toArray:()=>result,one:()=>{assert.equal(result.length,1);return result[0];}};}},
    transactionSync(fn){db.exec('BEGIN');try{const value=fn();db.exec('COMMIT');return value;}catch(error){db.exec('ROLLBACK');throw error;}}};
  const route={projectId:'p',origin:'https://p.invalid',objectName:'owner-p',generation:1};
  const scope={id:'1'.repeat(32),epoch:'era-1',principal:'2'.repeat(64),request:'3'.repeat(64),route};
  const allow=()=>true, first='4'.repeat(32), second='5'.repeat(32),
    firstUse='a'.repeat(32), overlappingUse='b'.repeat(32), secondUse='c'.repeat(32);
  initializeOwnerFence(storage,route);
  db.exec("CREATE TABLE mapi_recovery_epoch(epoch TEXT NOT NULL); INSERT INTO mapi_recovery_epoch VALUES ('era-1')");
  db.exec(ddl); for(const index of indexes) db.exec(index);
  db.exec("INSERT INTO events(project_id,id,event_type,category,occurred_at,created_at) VALUES ('p','a','x','identity',1,2)");
  assert.equal(shadowStatus(storage,scope,allow),null);
  let checks=0;
  assert.throws(()=>beginShadow(storage,scope,ddl,indexes,()=>++checks===1),/denied/);
  assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name GLOB 'mapi_shadow_*' OR name GLOB 'mapi_audit_shadow_*'").get().n,0);
  beginShadow(storage,scope,ddl,indexes,allow);
  assert.deepEqual(shadowStatus(storage,scope,allow),{state:'active'});
  acquireShadowReader(storage,scope,first,firstUse,allow);
  acquireShadowReader(storage,scope,first,firstUse,allow); // lost acknowledgement
  acquireShadowReader(storage,scope,first,overlappingUse,allow);
  db.exec("UPDATE events SET category='changed' WHERE project_id='p' AND id='a'");
  const encodeCategory=()=>new TextEncoder().encode(db.prepare("SELECT category FROM mapi_shadow_snapshot WHERE project_id='p' AND id='a'").get().category);
  const originalFrame=encodeCategory();
  const detached=withShadowReader(storage,scope,first,firstUse,allow,()=>originalFrame);
  originalFrame.fill(0);
  assert.equal(new TextDecoder().decode(detached),'identity');
  assert.throws(()=>withShadowReader(storage,scope,first,firstUse,allow,()=>({some:'object'})),/encoded frame/);
  assert.throws(()=>withShadowReader(storage,scope,first,firstUse,allow,()=>new Uint8Array(256*1024)),/Invalid shadow frame/);
  assert.equal(withShadowReader(storage,scope,first,firstUse,allow,()=>new Uint8Array()).length,0);
  assert.throws(()=>withShadowReader(storage,scope,first,firstUse,allow,()=>Promise.resolve('x')),/synchronous/);
  assert.throws(()=>closeShadow(storage,scope,allow),/readers remain active/);
  // Reopening the same database simulates object eviction, not power failure.
  db.close();open();
  releaseShadowReader(storage,scope,first,firstUse,allow);
  releaseShadowReader(storage,scope,first,firstUse,allow); // lost acknowledgement
  // The previously returned frame remains detached after its lease ends.
  assert.equal(new TextDecoder().decode(detached),'identity');
  // A second use of the same reader capability remains active independently.
  assert.equal(new TextDecoder().decode(withShadowReader(storage,scope,first,overlappingUse,allow,encodeCategory)),'identity');
  assert.throws(()=>closeShadow(storage,scope,allow),/readers remain active/);
  releaseShadowReader(storage,scope,first,overlappingUse,allow);
  acquireShadowReader(storage,scope,second,secondUse,allow);
  db.exec("PRAGMA ignore_check_constraints=ON; UPDATE mapi_audit_shadow_readers SET state='future' WHERE reader_id='"+second+"'; PRAGMA ignore_check_constraints=OFF");
  assert.throws(()=>closeShadow(storage,scope,allow),/readers remain active/);
  db.exec("UPDATE mapi_audit_shadow_readers SET state='active' WHERE reader_id='"+second+"'");
  assert.throws(()=>acquireShadowReader(storage,scope,first,firstUse,allow),/cannot be reused/);
  assert.throws(()=>withShadowReader(storage,scope,first,firstUse,allow,()=>0),/not active/);
  assert.throws(()=>closeShadow(storage,scope,allow),/readers remain active/);
  assert.throws(()=>releaseShadowReader(storage,{...scope,epoch:'era-2'},second,secondUse,allow),/era changed/);
  assert.throws(()=>releaseShadowReader(storage,{...scope,route:{...route,generation:2}},second,secondUse,allow),/fenced|stale/);
  const trigger=db.prepare("SELECT sql FROM sqlite_schema WHERE type='trigger' AND name='mapi_shadow_before_delete'").get().sql;
  db.exec('DROP TRIGGER mapi_shadow_before_delete');
  assert.throws(()=>releaseShadowReader(storage,scope,second,secondUse,allow),/schema differs/);
  db.exec(trigger);
  releaseShadowReader(storage,scope,second,secondUse,allow);
  closeShadow(storage,scope,allow); closeShadow(storage,scope,allow);
  assert.deepEqual(shadowStatus(storage,scope,allow),{state:'cleaning'});
  assert.throws(()=>acquireShadowReader(storage,scope,'6'.repeat(32),'d'.repeat(32),allow),/closing/);
  db.exec("INSERT INTO events(project_id,id,event_type,category,occurred_at,created_at) VALUES ('p','after','x','identity',1,3)");
  let calls=0;
  assert.throws(()=>cleanupShadowStep(storage,scope,()=>++calls===1,1),/denied/);
  assert.equal(db.prepare('SELECT count(*) AS n FROM mapi_shadow_events').get().n,1);
  let last;
  for(let i=0;i<20;i++) {
    last=cleanupShadowStep(storage,scope,allow,1);
    assert.ok(last.removed<=1);
    db.close();open();
    if(last.complete) break;
  }
  assert.equal(last?.complete,true);
  assert.deepEqual(cleanupShadowStep(storage,scope,allow,1),{complete:true,removed:0});
  assert.deepEqual(shadowStatus(storage,scope,allow),{state:'complete'});
  closeShadow(storage,scope,allow);
  assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name GLOB 'mapi_shadow_*'").get().n,0);
  assert.equal(db.prepare('SELECT count(*) AS n FROM events').get().n,2);
  assert.throws(()=>beginShadow(storage,{...scope,id:'7'.repeat(32)},ddl,indexes,allow),/already exists/);
  // A route freeze cannot be bypassed, even when a terminal tombstone remains.
  freezeOwnerFence(storage,route,'move-1');
  assert.throws(()=>cleanupShadowStep(storage,scope,allow,1),/fenced/);
  console.log('Native shadow lifecycle checks passed');
} finally { try { db?.close(); } catch {} await rm(dir,{recursive:true,force:true}); }
