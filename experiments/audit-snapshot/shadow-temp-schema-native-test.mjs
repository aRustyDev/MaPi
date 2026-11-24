// Disposable native SQLite test; the experiment is not a deployed owner.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {DatabaseSync} from 'node:sqlite';
import {initializeOwnerFence} from '../../worker/owner-fence.js';
import {beginShadow, shadowStatus, acquireShadowReader, releaseShadowReader} from './shadow-lifecycle.mjs';

const baseline=JSON.parse(await readFile(new URL('../../worker/generated/baseline.json',import.meta.url),'utf8'));
const ddl=baseline.statements.find(s=>/^CREATE TABLE events\s*\(/.test(s));
const indexes=baseline.statements.filter(s=>/^CREATE INDEX idx_events_[a-z0-9_]+\s+ON events\s*\(/.test(s));
assert.ok(ddl); assert.equal(indexes.length,12);
const db=new DatabaseSync(':memory:');
try {
  const storage={sql:{exec(query,...args){const s=db.prepare(query);const result=s.columns().length?s.all(...args):(s.run(...args),[]);return {toArray:()=>result,one:()=>{assert.equal(result.length,1);return result[0];}};}},
    transactionSync(fn){db.exec('BEGIN');try{const value=fn();db.exec('COMMIT');return value;}catch(error){db.exec('ROLLBACK');throw error;}}};
  const route={projectId:'p',origin:'https://p.invalid',objectName:'owner-p',generation:1};
  const scope={id:'1'.repeat(32),epoch:'era-1',principal:'2'.repeat(64),request:'3'.repeat(64),route};
  const allow=()=>true, reader='4'.repeat(32), use='5'.repeat(32);
  initializeOwnerFence(storage,route);
  db.exec("CREATE TABLE mapi_recovery_epoch(epoch TEXT NOT NULL); INSERT INTO mapi_recovery_epoch VALUES ('era-1')");
  db.exec(ddl); for(const index of indexes) db.exec(index);
  db.exec('CREATE TABLE marker(n INTEGER NOT NULL)');
  db.exec('CREATE TEMP TRIGGER unrelated_name AFTER INSERT ON main.events BEGIN INSERT INTO marker VALUES (1); END');
  assert.throws(()=>beginShadow(storage,scope,ddl,indexes,allow),/Invalid shadow temporary schema/);
  assert.equal(db.prepare("SELECT count(*) AS n FROM main.sqlite_schema WHERE name GLOB 'mapi_shadow_*'").get().n,0);
  db.exec('DROP TRIGGER temp.unrelated_name');
  beginShadow(storage,scope,ddl,indexes,allow);

  // A trigger with an unrelated name can target the main reader table. If not
  // checked, an otherwise successful acquisition executes its side effect.
  db.exec('CREATE TEMP TRIGGER arbitrary AFTER INSERT ON main.mapi_audit_shadow_readers BEGIN INSERT INTO marker VALUES (1); END');
  assert.throws(()=>acquireShadowReader(storage,scope,reader,use,allow),/Invalid shadow temporary schema/);
  assert.equal(db.prepare('SELECT count(*) AS n FROM marker').get().n,0);
  assert.equal(db.prepare('SELECT count(*) AS n FROM main.mapi_audit_shadow_readers').get().n,0);
  db.exec('DROP TRIGGER temp.arbitrary');

  // SQLite resolves names case-insensitively and checks TEMP before main.
  db.exec('CREATE TEMP TABLE MAPI_AUDIT_SHADOW_READERS(reader_id TEXT, use_id TEXT, state TEXT)');
  assert.throws(()=>acquireShadowReader(storage,scope,reader,use,allow),/Invalid shadow temporary schema/);
  db.exec('DROP TABLE temp.MAPI_AUDIT_SHADOW_READERS');
  db.exec('CREATE TEMP TABLE EVENTS(project_id TEXT)');
  assert.throws(()=>shadowStatus(storage,scope,allow),/Invalid shadow temporary schema/);
  db.exec('DROP TABLE temp.EVENTS');
  db.exec('CREATE TEMP VIEW MAPI_SHADOW_SNAPSHOT AS SELECT 1 AS id');
  assert.throws(()=>shadowStatus(storage,scope,allow),/Invalid shadow temporary schema/);
  db.exec('DROP VIEW temp.MAPI_SHADOW_SNAPSHOT');
  acquireShadowReader(storage,scope,reader,use,allow);
  releaseShadowReader(storage,scope,reader,use,allow);
  assert.deepEqual(shadowStatus(storage,scope,allow),{state:'active'});
  console.log('Native shadow lifecycle TEMP schema guard checks passed');
} finally {db.close();}
