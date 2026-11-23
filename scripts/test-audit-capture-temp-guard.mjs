import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { initializeOwnerFence } from '../worker/owner-fence.js';
import { createAuditCaptureSchema, captureAuditSourceRow } from '../worker/audit-source-capture.js';

// This is a native SQLite test of the unmounted capture helper only.
const baseline = JSON.parse(await readFile(new URL('../worker/generated/baseline.json', import.meta.url), 'utf8'));
const ddl = baseline.statements.find(s => /^CREATE TABLE events\s*\(/.test(s));
assert.ok(ddl);
const db = new DatabaseSync(':memory:');
const storage = {
  sql: { exec(sql, ...args) {
    const stmt = db.prepare(sql);
    const rows = stmt.columns().length ? stmt.all(...args) : (stmt.run(...args), []);
    return { toArray: () => rows, one: () => { assert.equal(rows.length, 1); return rows[0]; } };
  } },
  transactionSync(fn) { db.exec('BEGIN'); try { const value = fn(); db.exec('COMMIT'); return value; } catch (e) { db.exec('ROLLBACK'); throw e; } },
};
const route = { projectId:'project-a', origin:'https://a.invalid', objectName:'owner-a', generation:1 };
const scope = { id:'a'.repeat(32), ordinal:0, rowid:'1', epoch:'era-1', principal:'b'.repeat(64), request:'c'.repeat(64), route };
const allow = () => true;
initializeOwnerFence(storage, route);
db.exec("CREATE TABLE mapi_recovery_epoch (epoch TEXT NOT NULL); INSERT INTO mapi_recovery_epoch VALUES ('era-1')");
db.exec(ddl);
db.exec("INSERT INTO events (rowid,project_id,id,event_type,category,occurred_at,created_at) VALUES (1,'project-a','event-a','mapi.test','identity',1,2)");
createAuditCaptureSchema(storage, route, 'era-1', allow);

db.exec('CREATE TEMP TABLE audit_sentinel(value INTEGER NOT NULL); INSERT INTO audit_sentinel VALUES (0)');
db.exec('CREATE TEMP TRIGGER attack AFTER INSERT ON main.mapi_audit_capture_fragments BEGIN UPDATE audit_sentinel SET value = 1; END');
assert.throws(() => captureAuditSourceRow(storage, scope, allow), /schema/);
assert.equal(db.prepare('SELECT value FROM audit_sentinel').get().value, 0);
assert.equal(db.prepare('SELECT count(*) AS n FROM main.mapi_audit_capture_rows').get().n, 0);
db.exec('DROP TRIGGER temp.attack');

db.exec('CREATE TEMP TABLE MAPI_AUDIT_CAPTURE_FRAGMENTS (snapshot_id, ordinal, column_no, part_no, storage_type, data)');
assert.throws(() => captureAuditSourceRow(storage, scope, allow), /schema/);
assert.equal(db.prepare('SELECT count(*) AS n FROM temp.MAPI_AUDIT_CAPTURE_FRAGMENTS').get().n, 0);
db.exec('DROP TABLE temp.MAPI_AUDIT_CAPTURE_FRAGMENTS');

db.exec('CREATE TEMP TABLE EVENTS (project_id TEXT)');
assert.throws(() => captureAuditSourceRow(storage, scope, allow), /schema/);
assert.equal(db.prepare('SELECT count(*) AS n FROM main.mapi_audit_capture_rows').get().n, 0);
db.exec('DROP TABLE temp.EVENTS');

assert.equal(captureAuditSourceRow(storage, scope, allow).replayed, false);
console.log('Native audit capture TEMP guard checks passed');
