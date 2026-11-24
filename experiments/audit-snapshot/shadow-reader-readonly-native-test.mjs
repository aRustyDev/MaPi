// Native diagnostic for the unmounted shadow reader callback. This does not
// exercise the upstream handler, the interrupted row-transfer test or a real owner.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { initializeOwnerFence } from '../../worker/owner-fence.js';
import { beginShadow, acquireShadowReader, withShadowReader } from './shadow-lifecycle.mjs';

const baseline=JSON.parse(await readFile(new URL('../../worker/generated/baseline.json',import.meta.url),'utf8'));
const ddl=baseline.statements.find(s=>/^CREATE TABLE events\s*\(/.test(s));
const indexes=baseline.statements.filter(s=>/^CREATE INDEX idx_events_[a-z0-9_]+\s+ON events\s*\(/.test(s));
assert.ok(ddl); assert.equal(indexes.length,12);
const db=new DatabaseSync(':memory:');
const storage={sql:{exec(query,...args) {
  const stmt=db.prepare(query), result=stmt.columns().length?stmt.all(...args):(stmt.run(...args),[]);
  return {toArray:()=>result,one:()=>result[0]};
}},transactionSync(fn){db.exec('BEGIN');try{const out=fn();db.exec('COMMIT');return out;}catch(error){db.exec('ROLLBACK');throw error;}}};
const route={projectId:'p',origin:'https://p.invalid',objectName:'owner-p',generation:1};
const scope={id:'1'.repeat(32),epoch:'era-1',principal:'2'.repeat(64),request:'3'.repeat(64),route};
const allow=()=>true, reader='4'.repeat(32), use='5'.repeat(32);
try {
  initializeOwnerFence(storage,route);
  db.exec("CREATE TABLE mapi_recovery_epoch(epoch TEXT NOT NULL); INSERT INTO mapi_recovery_epoch VALUES ('era-1')");
  db.exec(ddl); for(const index of indexes) db.exec(index);
  db.exec('CREATE TABLE business (value TEXT NOT NULL)');
  beginShadow(storage,scope,ddl,indexes,allow);
  acquireShadowReader(storage,scope,reader,use,allow);
  for (const sql of ["INSERT INTO business VALUES ('modified')", "INSERT INTO business VALUES ('modified'); DELETE FROM business"]) {
    assert.throws(()=>withShadowReader(storage,scope,reader,use,allow,()=>{db.exec(sql);return new Uint8Array([1]);}),/Shadow read must be read-only/);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM business').get().n,0);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM mapi_audit_shadow_readers WHERE state='active'").get().n,1);
  }
  assert.deepEqual([...withShadowReader(storage,scope,reader,use,allow,()=>new Uint8Array([1,2,3]))],[1,2,3]);
  console.log('Native shadow reader read-only rollback checks passed');
} finally { db.close(); }
