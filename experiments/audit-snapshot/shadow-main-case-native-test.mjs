// Distinct native diagnostic of SQLite catalog identifier case. This is an
// unmounted experiment, not an owner, handler, transfer or hosted test.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { initializeOwnerFence } from '../../worker/owner-fence.js';
import { beginShadow, shadowStatus, acquireShadowReader } from './shadow-lifecycle.mjs';

const baseline=JSON.parse(await readFile(new URL('../../worker/generated/baseline.json',import.meta.url),'utf8'));
const ddl=baseline.statements.find(s=>/^CREATE TABLE events\s*\(/.test(s));
const indexes=baseline.statements.filter(s=>/^CREATE INDEX idx_events_[a-z0-9_]+\s+ON events\s*\(/.test(s));
assert.ok(ddl); assert.equal(indexes.length,12);
const route={projectId:'p',origin:'https://p.invalid',objectName:'owner-p',generation:1};
const scope={id:'1'.repeat(32),epoch:'era-1',principal:'2'.repeat(64),request:'3'.repeat(64),route};
const allow=()=>true, reader='4'.repeat(32), use='5'.repeat(32);
function setup() {
  const db=new DatabaseSync(':memory:');
  const storage={sql:{exec(query,...args){const s=db.prepare(query);const result=s.columns().length?s.all(...args):(s.run(...args),[]);return {toArray:()=>result,one:()=>{assert.equal(result.length,1);return result[0];}};}},
    transactionSync(fn){db.exec('BEGIN');try{const v=fn();db.exec('COMMIT');return v;}catch(error){db.exec('ROLLBACK');throw error;}}};
  initializeOwnerFence(storage,route);
  db.exec("CREATE TABLE mapi_recovery_epoch(epoch TEXT NOT NULL); INSERT INTO mapi_recovery_epoch VALUES ('era-1')");
  db.exec(ddl); for (const index of indexes) db.exec(index);
  db.exec('CREATE TABLE marker(n INTEGER NOT NULL)');
  return {db,storage};
}
{
 const {db,storage}=setup(); try {
  db.exec('CREATE TABLE MAPI_SHADOW_ORPHAN(id INTEGER)');
  assert.throws(()=>shadowStatus(storage,scope,allow),/Shadow lifecycle missing/);
  assert.throws(()=>beginShadow(storage,scope,ddl,indexes,allow),/Shadow already exists/);
 } finally {db.close();}
}
{
 const {db,storage}=setup(); try {
  db.exec('CREATE TRIGGER unrelated_source AFTER INSERT ON EVENTS BEGIN INSERT INTO marker VALUES (1); END');
  assert.throws(()=>beginShadow(storage,scope,ddl,indexes,allow),/Unexpected source trigger/);
  assert.equal(db.prepare('SELECT count(*) AS n FROM marker').get().n,0);
 } finally {db.close();}
}
{
 const {db,storage}=setup(); try {
  beginShadow(storage,scope,ddl,indexes,allow);
  db.exec('CREATE TRIGGER unrelated_reader AFTER INSERT ON MAPI_AUDIT_SHADOW_READERS BEGIN INSERT INTO marker VALUES (1); END');
  assert.throws(()=>acquireShadowReader(storage,scope,reader,use,allow),/Shadow schema differs/);
  assert.equal(db.prepare('SELECT count(*) AS n FROM marker').get().n,0);
  assert.equal(db.prepare('SELECT count(*) AS n FROM mapi_audit_shadow_readers').get().n,0);
  db.exec('DROP TRIGGER unrelated_reader');
  acquireShadowReader(storage,scope,reader,use,allow);
  assert.deepEqual(shadowStatus(storage,scope,allow),{state:'active'});
 } finally {db.close();}
}
console.log('Native shadow lifecycle main-schema identifier checks passed');
