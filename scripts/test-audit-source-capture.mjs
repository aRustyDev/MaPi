import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { initializeOwnerFence, freezeOwnerFence } from '../worker/owner-fence.js';
import { createAuditCaptureSchema, captureAuditSourceRow, auditSourceColumns, auditSourceFragmentBytes } from '../worker/audit-source-capture.js';

// A distinct native test of the unmounted source-row helper. The pinned
// baseline contributes the actual events table, not the full Go handler.
const baseline = JSON.parse(await readFile(new URL('../worker/generated/baseline.json', import.meta.url), 'utf8'));
const ddl = baseline.statements.find(s => /^CREATE TABLE events\s*\(/.test(s));
assert.ok(ddl);
const db = new DatabaseSync(':memory:');
let inject = false, inserts = 0;
const storage = {
  sql: { exec(sql, ...args) {
    if (inject && sql.includes('INSERT INTO mapi_audit_capture_fragments') && ++inserts === 5) throw Error('injected source capture failure');
    const statement = db.prepare(sql);
    const rows = statement.columns().length ? statement.all(...args) : (statement.run(...args), []);
    return { toArray: () => rows, one: () => { assert.equal(rows.length,1); return rows[0]; } };
  } },
  transactionSync(fn) {
    db.exec('BEGIN');
    try { const result = fn(); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  },
};
const route = {projectId:'project-a',origin:'https://a.invalid',objectName:'owner-a',generation:1};
const scope = {id:'a'.repeat(32),ordinal:0,rowid:'-7',epoch:'era-1',principal:'b'.repeat(64),request:'c'.repeat(64),route};
const allow = () => true;
initializeOwnerFence(storage,route);
db.exec("CREATE TABLE mapi_recovery_epoch (epoch TEXT NOT NULL); INSERT INTO mapi_recovery_epoch VALUES ('era-1')");
db.exec(ddl);
const payload = 'a'.repeat(auditSourceFragmentBytes * 2 + 11);
const metadata = new Uint8Array(auditSourceFragmentBytes + 3).fill(0x61);
db.prepare(`INSERT INTO events (rowid,project_id,id,event_type,category,occurred_at,created_at,payload,metadata)
  VALUES (-7,'project-a','event-a','mapi.test','identity',9007199254741001,42,?,?)`).run(payload,metadata);
db.exec("INSERT INTO events (rowid,project_id,id,event_type,category,occurred_at,created_at) VALUES (5,'project-b','event-b','mapi.test','identity',1,2), (0,'project-a','event-zero','mapi.test','identity',3,4)");
createAuditCaptureSchema(storage,route,'era-1',allow);
assert.throws(() => createAuditCaptureSchema(storage,route,'era-1',allow));
assert.throws(() => captureAuditSourceRow(storage,{...scope,id:'1'.repeat(32),rowid:'5'},allow),/row missing/);
assert.equal(captureAuditSourceRow(storage,{...scope,id:'8'.repeat(32),rowid:'0'},allow).replayed,false);
assert.throws(() => captureAuditSourceRow(storage,{...scope,id:'1'.repeat(32),rowid:'-0'},allow),/scope/);
assert.throws(() => captureAuditSourceRow(storage,{...scope,id:'1'.repeat(32),rowid:'9223372036854775808'},allow),/scope/);
const first = captureAuditSourceRow(storage,scope,allow);
assert.equal(first.replayed,false);
assert.equal(first.fragments,auditSourceColumns.length + 3);
assert.deepEqual(captureAuditSourceRow(storage,scope,allow),{replayed:true,fragments:first.fragments});
assert.throws(() => captureAuditSourceRow(storage,{...scope,rowid:'0'},allow),/Conflicting/);
const fragments = db.prepare('SELECT part_no,storage_type,data FROM mapi_audit_capture_fragments WHERE snapshot_id = ? AND ordinal = 0 AND column_no = ? ORDER BY part_no');
const payloadParts=fragments.all(scope.id,auditSourceColumns.indexOf('payload'));
assert.equal(payloadParts.length,3);
assert.ok(payloadParts.every(r=>r.storage_type === 'text' && r.data.length <= auditSourceFragmentBytes));
assert.equal(Buffer.concat(payloadParts.map(r=>Buffer.from(r.data))).toString('utf8'),payload);
const metadataParts=fragments.all(scope.id,auditSourceColumns.indexOf('metadata'));
assert.equal(metadataParts.length,2);
assert.ok(metadataParts.every(r=>r.storage_type === 'blob' && r.data.length <= auditSourceFragmentBytes));
assert.deepEqual(Buffer.concat(metadataParts.map(r=>Buffer.from(r.data))),Buffer.from(metadata));
const integer = db.prepare("SELECT storage_type,typeof(data) AS storage,data FROM mapi_audit_capture_fragments WHERE snapshot_id = ? AND ordinal = 0 AND column_no = ?");
integer.setReadBigInts(true);
assert.deepEqual({...integer.get(scope.id,auditSourceColumns.indexOf('occurred_at'))},{storage_type:'integer',storage:'integer',data:9007199254741001n});
db.exec("UPDATE events SET payload = 'new-value' WHERE rowid = -7");
assert.throws(() => captureAuditSourceRow(storage,scope,allow),/source or capture changed/);
assert.equal(Buffer.concat(fragments.all(scope.id,auditSourceColumns.indexOf('payload')).map(r=>Buffer.from(r.data))).toString('utf8'),payload);
db.prepare('UPDATE events SET payload = ? WHERE rowid = -7').run(payload);
assert.equal(captureAuditSourceRow(storage,scope,allow).replayed,true);
db.exec('DELETE FROM events WHERE rowid = -7');
assert.throws(() => captureAuditSourceRow(storage,scope,allow),/source row missing/);
db.exec("INSERT INTO events (rowid,project_id,id,event_type,category,occurred_at,created_at) VALUES (-7,'project-a','event-reused','mapi.test','identity',1,2)");
assert.throws(() => captureAuditSourceRow(storage,scope,allow),/source or capture changed/);
db.exec('DELETE FROM events WHERE rowid = -7');
db.prepare(`INSERT INTO events (rowid,project_id,id,event_type,category,occurred_at,created_at,payload,metadata)
  VALUES (-7,'project-a','event-a','mapi.test','identity',9007199254741001,42,?,?)`).run(payload,metadata);
assert.equal(captureAuditSourceRow(storage,scope,allow).replayed,true);
const failing = {...scope,id:'2'.repeat(32)};
inject=true;
assert.throws(() => captureAuditSourceRow(storage,failing,allow),/injected/);
inject=false;
assert.equal(db.prepare('SELECT count(*) AS n FROM mapi_audit_capture_fragments WHERE snapshot_id = ?').get(failing.id).n,0);
assert.equal(db.prepare('SELECT count(*) AS n FROM mapi_audit_capture_rows WHERE snapshot_id = ?').get(failing.id).n,0);
let calls=0;
assert.throws(() => captureAuditSourceRow(storage,{...scope,id:'3'.repeat(32)},()=>++calls === 1),/denied/);
assert.equal(db.prepare("SELECT count(*) AS n FROM mapi_audit_capture_rows WHERE snapshot_id = ?").get('3'.repeat(32)).n,0);
db.exec('CREATE TABLE audit_capture_sentinel(value INTEGER NOT NULL); INSERT INTO audit_capture_sentinel VALUES(0)');
db.exec('CREATE TRIGGER audit_capture_attack AFTER INSERT ON mapi_audit_capture_fragments BEGIN UPDATE audit_capture_sentinel SET value = 1; END');
assert.throws(() => captureAuditSourceRow(storage,{...scope,id:'4'.repeat(32)},allow),/schema/);
assert.equal(db.prepare('SELECT value FROM audit_capture_sentinel').get().value,0);
db.exec('DROP TRIGGER audit_capture_attack');
db.exec("UPDATE mapi_recovery_epoch SET epoch = 'era-2'");
assert.throws(() => captureAuditSourceRow(storage,{...scope,id:'5'.repeat(32)},allow),/era changed/);
db.exec("UPDATE mapi_recovery_epoch SET epoch = 'era-1'");
freezeOwnerFence(storage,route,'move-1');
assert.throws(() => captureAuditSourceRow(storage,{...scope,id:'6'.repeat(32)},allow),/fenced/);

// An altered source collation must not widen the server-resolved project.
const db2 = new DatabaseSync(':memory:');
const storage2 = {
  sql: { exec(sql,...args) { const st=db2.prepare(sql); const rows=st.columns().length ? st.all(...args) : (st.run(...args),[]); return {toArray:()=>rows,one:()=>{assert.equal(rows.length,1);return rows[0];}}; } },
  transactionSync(fn) { db2.exec('BEGIN'); try {const v=fn();db2.exec('COMMIT');return v;} catch(e){db2.exec('ROLLBACK');throw e;} },
};
initializeOwnerFence(storage2,route);
db2.exec("CREATE TABLE mapi_recovery_epoch (epoch TEXT COLLATE NOCASE NOT NULL); INSERT INTO mapi_recovery_epoch VALUES ('era-1')");
const nocaseDDL=ddl.replace('project_id          TEXT    NOT NULL','project_id          TEXT COLLATE NOCASE NOT NULL');
assert.notEqual(nocaseDDL,ddl);
db2.exec(nocaseDDL);
db2.exec("INSERT INTO events (rowid,project_id,id,event_type,category,occurred_at,created_at) VALUES (1,'PROJECT-A','event-b','mapi.test','identity',1,2)");
createAuditCaptureSchema(storage2,route,'era-1',allow);
assert.throws(()=>captureAuditSourceRow(storage2,{...scope,id:'7'.repeat(32),rowid:'1'},allow),/row missing/);
assert.throws(()=>captureAuditSourceRow(storage2,{...scope,id:'7'.repeat(32),rowid:'1',epoch:'ERA-1'},allow),/era changed/);
assert.equal(db2.prepare('SELECT count(*) AS n FROM mapi_audit_capture_fragments').get().n,0);
console.log('Native audit source capture checks passed');
