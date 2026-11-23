// Disposable comparison of the relocation FK-existence query with native
// SQLite and local workerd. The deliberately small fixture is not a scan-cost
// or hosted-platform benchmark.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { assertNoForeignKeyViolations } from '../worker/foreign-keys.js';

const exercise = (storage, sql) => {
  const observed = [];
  const checked = { sql: { exec(statement) {
    if (statement !== 'SELECT 1 AS violation FROM main.pragma_foreign_key_check() LIMIT 1') throw Error('unexpected FK check');
    const cursor = sql.exec(statement);
    return { toArray() { const rows = cursor.toArray(); observed.push(rows.length); return rows; } };
  } } };
  sql.exec('CREATE TABLE parents (a INTEGER NOT NULL, b INTEGER NOT NULL, PRIMARY KEY (a,b))');
  sql.exec('CREATE TABLE children (id INTEGER PRIMARY KEY, a INTEGER, b INTEGER, FOREIGN KEY (a,b) REFERENCES parents(a,b))');
  sql.exec('CREATE TABLE other_children (id INTEGER PRIMARY KEY, a INTEGER, b INTEGER, FOREIGN KEY (a,b) REFERENCES parents(a,b))');
  sql.exec('CREATE TABLE checkpoint (id INTEGER PRIMARY KEY, value INTEGER NOT NULL)');
  sql.exec('INSERT INTO parents VALUES (1,1)');
  sql.exec('INSERT INTO children VALUES (1,1,1)');
  sql.exec('INSERT INTO children VALUES (2,NULL,2)'); // A partial NULL composite FK is valid.
  sql.exec('INSERT INTO checkpoint VALUES (1,0)');
  storage.transactionSync(() => assertNoForeignKeyViolations(checked, 'foreign key violation'));
  let rejected = false;
  try {
    storage.transactionSync(() => {
      sql.exec('PRAGMA defer_foreign_keys=ON');
      sql.exec('INSERT INTO children VALUES (3,2,2)');
      sql.exec('INSERT INTO other_children VALUES (4,3,3)');
      sql.exec('UPDATE checkpoint SET value=1 WHERE id=1');
      if (sql.exec('PRAGMA foreign_key_check').toArray().length !== 2) throw Error('expected two deferred violations');
      if (sql.exec('PRAGMA main.foreign_key_check').toArray().length !== 2 || sql.exec('SELECT 1 AS violation FROM main.pragma_foreign_key_check() LIMIT 1').toArray().length !== 1) throw Error('named-schema FK result differs');
      assertNoForeignKeyViolations(checked, 'foreign key violation');
    });
  } catch (error) {
    if (error.message !== 'foreign key violation') throw error;
    rejected = true;
  }
  const afterReject = {
    children: sql.exec('SELECT COUNT(*) AS n FROM children').toArray()[0].n,
    checkpoint: sql.exec('SELECT value FROM checkpoint WHERE id=1').toArray()[0].value,
  };
  storage.transactionSync(() => {
    sql.exec('PRAGMA defer_foreign_keys=ON');
    sql.exec('INSERT INTO children VALUES (3,1,1)');
    sql.exec('UPDATE checkpoint SET value=2 WHERE id=1');
    assertNoForeignKeyViolations(checked, 'foreign key violation');
  });
  const afterRetry = {
    children: sql.exec('SELECT COUNT(*) AS n FROM children').toArray()[0].n,
    checkpoint: sql.exec('SELECT value FROM checkpoint WHERE id=1').toArray()[0].value,
  };
  // TEMP may not be supported by every workerd storage implementation. When
  // supported, main qualification must still find the main-schema violation.
  let tempSupported = false, tempRejected = false, tempError = '';
  try { sql.exec('CREATE TEMP TABLE pragma_foreign_key_check (x INTEGER)'); tempSupported = true; }
  catch (error) { tempError = error?.message === 'not authorized: SQLITE_AUTH' ? 'sqlite-auth' : 'unclassified'; }
  if (tempSupported) {
    try {
      storage.transactionSync(() => {
        sql.exec('PRAGMA defer_foreign_keys=ON');
        sql.exec('INSERT INTO other_children VALUES (5,4,4)');
        sql.exec('UPDATE checkpoint SET value=3 WHERE id=1');
        assertNoForeignKeyViolations(checked, 'foreign key violation');
      });
    } catch (error) { if (error.message !== 'foreign key violation') throw error; tempRejected = true; }
    sql.exec('DROP TABLE temp.pragma_foreign_key_check');
  }
  // The original unqualified PRAGMA examines main, not attached schemas.
  // Test that the explicit main table-valued form keeps that scope when an
  // in-memory attachment is permitted. This is not a cross-schema FK check.
  let attachSupported = false, attachMainAgrees = false, attachError = '';
  try { sql.exec("ATTACH ':memory:' AS aux"); attachSupported = true; }
  catch (error) { attachError = error?.message === 'not authorized: SQLITE_AUTH' ? 'sqlite-auth' : 'unclassified'; }
  if (attachSupported) {
    sql.exec('CREATE TABLE aux.parents (a INTEGER PRIMARY KEY)');
    sql.exec('CREATE TABLE aux.children (a INTEGER REFERENCES parents(a))');
    try {
      storage.transactionSync(() => {
        sql.exec('PRAGMA defer_foreign_keys=ON');
        sql.exec('INSERT INTO aux.children VALUES (123)');
        if (sql.exec('PRAGMA foreign_key_check').toArray().length || sql.exec('PRAGMA main.foreign_key_check').toArray().length || sql.exec('PRAGMA aux.foreign_key_check').toArray().length !== 1) throw Error('attached schema scope differs');
        assertNoForeignKeyViolations(checked, 'foreign key violation');
        attachMainAgrees = true;
        throw Error('rollback attached probe');
      });
    } catch (error) { if (error.message !== 'rollback attached probe') throw error; }
    if (sql.exec('SELECT COUNT(*) AS n FROM aux.children').toArray()[0].n !== 0) throw Error('attached probe was not rolled back');
    sql.exec('DETACH DATABASE aux');
  }
  sql.exec('CREATE TABLE pragma_foreign_key_check (x INTEGER)');
  let shadowRejected = false, shadowHelperReached = false, shadowHelperRejected = false;
  try {
    storage.transactionSync(() => {
      sql.exec('PRAGMA defer_foreign_keys=ON');
      sql.exec('INSERT INTO other_children VALUES (5,4,4)');
      sql.exec('UPDATE checkpoint SET value=3 WHERE id=1');
      shadowHelperReached = true;
      try { assertNoForeignKeyViolations(checked, 'foreign key violation'); }
      catch (error) { shadowHelperRejected = true; throw error; }
    });
  } catch { shadowRejected = true; }
  sql.exec('DROP TABLE pragma_foreign_key_check');
  sql.exec('CREATE VIEW pragma_foreign_key_check AS SELECT 0 AS x');
  let viewRejected = false, viewHelperReached = false, viewHelperRejected = false;
  try {
    storage.transactionSync(() => {
      sql.exec('PRAGMA defer_foreign_keys=ON');
      sql.exec('INSERT INTO other_children VALUES (6,5,5)');
      sql.exec('UPDATE checkpoint SET value=4 WHERE id=1');
      viewHelperReached = true;
      try { assertNoForeignKeyViolations(checked, 'foreign key violation'); }
      catch (error) { viewHelperRejected = true; throw error; }
    });
  } catch { viewRejected = true; }
  sql.exec('DROP VIEW pragma_foreign_key_check');
  // SQLite accepts this DDL but the FK definition itself is malformed, even
  // with no child rows. The helper must propagate the error before commit.
  sql.exec('CREATE TABLE broken_fk (a INTEGER REFERENCES parents(missing_column))');
  let oldMismatchRejected = false, oldMismatchCategory = '', mismatchReached = false, mismatchRejected = false, mismatchCategory = '';
  try { sql.exec('PRAGMA foreign_key_check').toArray(); }
  catch (error) { oldMismatchRejected = true; oldMismatchCategory = /foreign key mismatch/i.test(error?.message ?? '') ? 'foreign-key-mismatch' : 'unclassified'; }
  try {
    storage.transactionSync(() => {
      sql.exec('UPDATE checkpoint SET value=5 WHERE id=1');
      mismatchReached = true;
      try { assertNoForeignKeyViolations(checked, 'foreign key violation'); }
      catch (error) { mismatchRejected = true; mismatchCategory = /foreign key mismatch/i.test(error?.message ?? '') ? 'foreign-key-mismatch' : 'unclassified'; throw error; }
    });
  } catch {}
  const afterShadow = {
    children: sql.exec('SELECT COUNT(*) AS n FROM children').toArray()[0].n,
    otherChildren: sql.exec('SELECT COUNT(*) AS n FROM other_children').toArray()[0].n,
    checkpoint: sql.exec('SELECT value FROM checkpoint WHERE id=1').toArray()[0].value,
  };
  return { rejected, afterReject, afterRetry, tempSupported, tempRejected, tempError, attachSupported, attachMainAgrees, attachError, shadowRejected, shadowHelperReached, shadowHelperRejected, viewRejected, viewHelperReached, viewHelperRejected, oldMismatchRejected, oldMismatchCategory, mismatchReached, mismatchRejected, mismatchCategory, afterShadow, observed };
};

const db = new DatabaseSync(':memory:');
try {
  db.exec('PRAGMA foreign_keys=ON');
  const sql = { exec(statement) {
    if (/^\s*(?:SELECT|PRAGMA (?:(?:main|aux)\.)?foreign_key_check)/i.test(statement)) return { toArray: () => db.prepare(statement).all() };
    db.exec(statement); return { toArray: () => [] };
  } };
  const storage = { sql, transactionSync(callback) {
    db.exec('BEGIN');
    try { const result = callback(); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  } };
  assert.deepEqual(exercise(storage, sql), { rejected: true, afterReject: { children: 2, checkpoint: 0 }, afterRetry: { children: 3, checkpoint: 2 }, tempSupported: true, tempRejected: true, tempError: '', attachSupported: true, attachMainAgrees: true, attachError: '', shadowRejected: true, shadowHelperReached: true, shadowHelperRejected: true, viewRejected: true, viewHelperReached: true, viewHelperRejected: true, oldMismatchRejected: true, oldMismatchCategory: 'foreign-key-mismatch', mismatchReached: true, mismatchRejected: true, mismatchCategory: 'foreign-key-mismatch', afterShadow: { children: 3, otherChildren: 0, checkpoint: 2 }, observed: [0, 1, 0, 1, 0] });
} finally { db.close(); }

const source = `import { DurableObject } from 'cloudflare:workers';
import { assertNoForeignKeyViolations } from './foreign-keys.js';
const exercise = ${exercise.toString()};
export class Probe extends DurableObject { fetch() { return Response.json(exercise(this.ctx.storage, this.ctx.storage.sql)); } }
export default { fetch(request, env) { return env.PROBE.get(env.PROBE.idFromName('synthetic')).fetch(request); } };`;
const mf = new Miniflare(convertV4MiniflareOptions({
  workers: [{ name: 'local-fk-bound-probe', compatibilityDate: '2026-11-19',
    modules: [{ type: 'ESModule', path: 'worker.js', contents: source },
      { type: 'ESModule', path: 'foreign-keys.js', contents: await readFile('worker/foreign-keys.js', 'utf8') }],
    durableObjects: { PROBE: { className: 'Probe', useSQLite: true } } }],
  host: '127.0.0.1', port: 0, telemetry: { enabled: false },
}));
try {
  const response = await mf.dispatchFetch('http://127.0.0.1/');
  assert.equal(response.status, 200);
  const result = await response.json();
  const expectedObserved = [0, 1, 0];
  if (result.tempSupported) expectedObserved.push(1);
  if (result.attachSupported) expectedObserved.push(0);
  assert.deepEqual(result, { rejected: true, afterReject: { children: 2, checkpoint: 0 }, afterRetry: { children: 3, checkpoint: 2 }, tempSupported: result.tempSupported, tempRejected: result.tempSupported, tempError: result.tempError, attachSupported: result.attachSupported, attachMainAgrees: result.attachSupported, attachError: result.attachError, shadowRejected: true, shadowHelperReached: true, shadowHelperRejected: true, viewRejected: true, viewHelperReached: true, viewHelperRejected: true, oldMismatchRejected: true, oldMismatchCategory: 'foreign-key-mismatch', mismatchReached: true, mismatchRejected: true, mismatchCategory: 'foreign-key-mismatch', afterShadow: { children: 3, otherChildren: 0, checkpoint: 2 }, observed: expectedObserved });
  const status = (supported, error) => supported ? 'checked' : error === 'sqlite-auth' ? 'denied (SQLITE_AUTH)' : 'not established';
  console.log(`Local workerd temporary-schema fixture: ${status(result.tempSupported, result.tempError)}`);
  console.log(`Local workerd attached-schema fixture: ${status(result.attachSupported, result.attachError)}`);
  console.log('Native SQLite and local workerd FK existence and rollback checks passed');
} finally { await mf.dispose(); }
