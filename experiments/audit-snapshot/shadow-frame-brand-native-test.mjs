// Distinct local frame-brand check. No Worker, SQLite cursor, hosted service,
// or interrupted bridge boundary test is exercised.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { initializeOwnerFence } from '../../worker/owner-fence.js';
import { acquireShadowReader, beginShadow, withShadowReader } from './shadow-lifecycle.mjs';

const baseline = JSON.parse(await readFile(new URL('../../worker/generated/baseline.json', import.meta.url), 'utf8'));
const ddl = baseline.statements.find(s => /^CREATE TABLE events\s*\(/.test(s));
const indexes = baseline.statements.filter(s => /^CREATE INDEX idx_events_[a-z0-9_]+\s+ON events\s*\(/.test(s));
assert.ok(ddl); assert.equal(indexes.length, 12);
const db = new DatabaseSync(':memory:');
try {
  const storage = {
    sql: { exec(query, ...args) {
      const statement = db.prepare(query);
      const values = statement.columns().length ? statement.all(...args) : (statement.run(...args), []);
      return { toArray: () => values, one: () => { assert.equal(values.length, 1); return values[0]; } };
    } },
    transactionSync(fn) {
      db.exec('BEGIN');
      try { const value = fn(); db.exec('COMMIT'); return value; }
      catch (error) { db.exec('ROLLBACK'); throw error; }
    },
  };
  const route = { projectId:'p', origin:'https://p.invalid', objectName:'owner-p', generation:1 };
  const scope = { id:'1'.repeat(32), epoch:'era-1', principal:'2'.repeat(64), request:'3'.repeat(64), route };
  const reader = '4'.repeat(32), use = '5'.repeat(32), allow = () => true;
  initializeOwnerFence(storage, route);
  db.exec("CREATE TABLE mapi_recovery_epoch(epoch TEXT NOT NULL); INSERT INTO mapi_recovery_epoch VALUES ('era-1')");
  db.exec(ddl); for (const index of indexes) db.exec(index);
  beginShadow(storage, scope, ddl, indexes, allow);
  acquireShadowReader(storage, scope, reader, use, allow);

  assert.equal(typeof SharedArrayBuffer, 'function');
  const shared = new SharedArrayBuffer(4);
  const sharedView = new Uint8Array(shared);
  sharedView.set([1, 2, 3, 4]);
  // Prototype tampering defeats `instanceof` but does not change the shared
  // backing-store brand. The actual reader must reject it without copying.
  Object.setPrototypeOf(shared, ArrayBuffer.prototype);
  assert.equal(shared instanceof SharedArrayBuffer, false);
  assert.throws(() => withShadowReader(storage, scope, reader, use, allow, () => sharedView), /Invalid shadow frame/);

  const ordinary = new Uint8Array([7, 8, 9, 10]);
  const detached = withShadowReader(storage, scope, reader, use, allow, () => ordinary.subarray(1, 3));
  ordinary.fill(0);
  assert.deepEqual([...detached], [8, 9]);
  console.log('Native shadow frame backing-store brand checks passed');
} finally { db.close(); }
