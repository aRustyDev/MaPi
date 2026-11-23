// Native SQLite experiment of fenced ordering fragments. Not a handler,
// payload transfer, real owner, hosted test, or interrupted transfer test.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {DatabaseSync} from 'node:sqlite';
import {initializeOwnerFence,freezeOwnerFence} from '../../worker/owner-fence.js';
import {beginShadow,acquireShadowReader,releaseShadowReader} from './shadow-lifecycle.mjs';
import {readShadowOrderFragment} from './shadow-order-fragment.mjs';

const baseline=JSON.parse(await readFile('worker/generated/baseline.json','utf8'));
const ddl=baseline.statements.find(s=>/^CREATE TABLE events\s*\(/.test(s));
const indexes=baseline.statements.filter(s=>/^CREATE INDEX idx_events_[a-z0-9_]+\s+ON events\s*\(/.test(s));
assert.ok(ddl); assert.equal(indexes.length,12);
const db=new DatabaseSync(':memory:');
try {
  const storage={sql:{exec(query,...args){const stmt=db.prepare(query), result=stmt.columns().length?stmt.all(...args):(stmt.run(...args),[]);return {toArray:()=>result,one:()=>result[0]};}},
    transactionSync(fn){db.exec('BEGIN');try{const result=fn();db.exec('COMMIT');return result;}catch(error){db.exec('ROLLBACK');throw error;}}};
  const route={projectId:'p',origin:'https://p.invalid',objectName:'owner-p',generation:1};
  const scope={id:'1'.repeat(32),epoch:'era-1',principal:'2'.repeat(64),request:'3'.repeat(64),route};
  const reader='4'.repeat(32),use='5'.repeat(32),allow=()=>true;
  initializeOwnerFence(storage,route);
  db.exec("CREATE TABLE mapi_recovery_epoch(epoch TEXT NOT NULL); INSERT INTO mapi_recovery_epoch VALUES ('era-1')");
  db.exec(ddl);for(const index of indexes)db.exec(index);
  const id='x'.repeat(70000)+'é';
  db.prepare("INSERT INTO events(project_id,id,event_type,category,occurred_at,created_at,payload,metadata) VALUES ('p',?,'user.created','identity',1,CAST(? AS INTEGER),'{}','{}')").run(id,'-9223372036854775808');
  db.exec("INSERT INTO events(project_id,id,event_type,category,occurred_at,created_at,payload,metadata) VALUES ('other','other','user.created','identity',1,1,'{}','{}')");
  beginShadow(storage,scope,ddl,indexes,allow);acquireShadowReader(storage,scope,reader,use,allow);
  db.exec("DELETE FROM events WHERE project_id='p'");
  const read=(input,handle,offset,auth=allow)=>JSON.parse(new TextDecoder().decode(readShadowOrderFragment(storage,input,reader,use,auth,handle,offset)));
  const chunks=[];
  for(let offset=0;;offset+=32768) {
    const f=read(scope,'1',offset);assert.equal(f.timestamp,'-9223372036854775808');assert.equal(f.offset,offset);assert.equal(f.idKind,'text');
    const part=Buffer.from(f.fragment,'base64');assert.ok(part.length<=32768);chunks.push(part);if(f.done)break;
  }
  assert.deepEqual(Buffer.concat(chunks),Buffer.from(id));
  assert.throws(()=>read(scope,'2',0),/Invalid shadow event ordering value/);
  assert.throws(()=>read(scope,'1',Buffer.byteLength(id)+1),/Invalid shadow event ordering value/);
  assert.throws(()=>read({...scope,route:{...route,generation:2}},'1',0),/fenced|stale/i);
  assert.throws(()=>read(scope,'1',0,()=>{db.exec("INSERT INTO events(project_id,id,event_type,category,occurred_at,created_at,payload,metadata) VALUES ('p','bad','user.created','identity',1,1,'{}','{}')");return true;}),/read-only/);
  assert.equal(db.prepare("SELECT count(*) AS n FROM events WHERE id='bad'").get().n,0);
  releaseShadowReader(storage,scope,reader,use,allow);
  assert.throws(()=>read(scope,'1',0),/not active/);
  freezeOwnerFence(storage,route,'move');
  assert.throws(()=>read(scope,'1',0),/fenced|stale/i);
  console.log('Native fenced shadow ordering fragments passed snapshot, scope and lease checks');
} finally {db.close();}
