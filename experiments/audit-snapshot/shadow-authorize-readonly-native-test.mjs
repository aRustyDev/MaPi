// A synthetic native SQLite lifecycle test. This does not call the upstream
// handler, interrupted transfer test, a real owner, or a hosted deployment.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { initializeOwnerFence } from '../../worker/owner-fence.js';
import { beginShadow, acquireShadowReader, shadowStatus } from './shadow-lifecycle.mjs';

const baseline=JSON.parse(await readFile(new URL('../../worker/generated/baseline.json',import.meta.url),'utf8'));
const ddl=baseline.statements.find(s=>/^CREATE TABLE events\s*\(/.test(s));
const indexes=baseline.statements.filter(s=>/^CREATE INDEX idx_events_[a-z0-9_]+\s+ON events\s*\(/.test(s));
const db=new DatabaseSync(':memory:');
const storage={sql:{exec(query,...args) {
  const stmt=db.prepare(query), result=stmt.columns().length?stmt.all(...args):(stmt.run(...args),[]);
  return {toArray:()=>result,one:()=>result[0]};
}},transactionSync(fn){db.exec('BEGIN');try{const out=fn();db.exec('COMMIT');return out;}catch(error){db.exec('ROLLBACK');throw error;}}};
const route={projectId:'p',origin:'https://p.invalid',objectName:'owner-p',generation:1};
const scope={id:'1'.repeat(32),epoch:'era-1',principal:'2'.repeat(64),request:'3'.repeat(64),route};
const allow=()=>true;
try {
  initializeOwnerFence(storage,route);
  db.exec("CREATE TABLE mapi_recovery_epoch(epoch TEXT NOT NULL); INSERT INTO mapi_recovery_epoch VALUES ('era-1')");
  db.exec(ddl); for(const index of indexes) db.exec(index);
  db.exec('CREATE TABLE authorization_side_effect (value TEXT)');
  const writeThenUndo=()=>{db.exec("INSERT INTO authorization_side_effect VALUES ('modified'); DELETE FROM authorization_side_effect");return true;};
  assert.throws(()=>beginShadow(storage,scope,ddl,indexes,writeThenUndo),/Shadow authority must be read-only/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM authorization_side_effect').get().n,0);
  assert.equal(shadowStatus(storage,scope,allow),null);
  beginShadow(storage,scope,ddl,indexes,allow);
  assert.throws(()=>acquireShadowReader(storage,scope,'4'.repeat(32),'5'.repeat(32),writeThenUndo),/Shadow authority must be read-only/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM mapi_audit_shadow_readers').get().n,0);
  acquireShadowReader(storage,scope,'4'.repeat(32),'5'.repeat(32),()=>{
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM authorization_side_effect').get().n,0);return true;
  });
  console.log('Native shadow authorization read-only rollback checks passed');
} finally { db.close(); }
