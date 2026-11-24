// Native, local-only copy-on-write mechanism investigation against the pinned
// events table. This is not a route, schema migration, or protected snapshot.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { auditSourceColumns, createAuditCaptureSchema } from '../../worker/audit-source-capture.js';
import { initializeOwnerFence, assertOwnerFence } from '../../worker/owner-fence.js';

const baseline=JSON.parse(await readFile(new URL('../../worker/generated/baseline.json',import.meta.url),'utf8'));
const ddl=baseline.statements.find(s=>/^CREATE TABLE events\s*\(/.test(s));
assert.ok(ddl);
const db=new DatabaseSync(':memory:');
const storage={sql:{exec(sql,...args){const stmt=db.prepare(sql);const rows=stmt.columns().length?stmt.all(...args):(stmt.run(...args),[]);return {toArray:()=>rows,one:()=>{assert.equal(rows.length,1);return rows[0];}};}},
 transactionSync(fn){db.exec('BEGIN');try{const result=fn();db.exec('COMMIT');return result;}catch(e){db.exec('ROLLBACK');throw e;}}};
const route={projectId:'p',origin:'https://p.invalid',objectName:'owner-p',generation:1};
initializeOwnerFence(storage,route);
db.exec("CREATE TABLE mapi_recovery_epoch(epoch TEXT NOT NULL); INSERT INTO mapi_recovery_epoch VALUES ('era-1')");
db.exec('PRAGMA recursive_triggers=OFF'); db.exec(ddl);
// This experiment handles the pinned PRIMARY KEY plus SQLite rowid only.
const unique=db.prepare("SELECT name,origin FROM pragma_index_list('events') WHERE \"unique\"=1").all();
assert.equal(unique.length,1); assert.equal(unique[0].origin,'pk');
assert.deepEqual(db.prepare('SELECT name FROM pragma_index_info(?) ORDER BY seqno').all(unique[0].name).map(x=>x.name),['project_id','id']);
db.exec(`CREATE TABLE capture_active (singleton INTEGER PRIMARY KEY CHECK(singleton=1));
 CREATE TABLE after_capture (event_rowid INTEGER PRIMARY KEY);
 CREATE TABLE original_versions (event_rowid INTEGER PRIMARY KEY, ready INTEGER NOT NULL);
 CREATE TABLE original_cells (event_rowid INTEGER NOT NULL,column_no INTEGER NOT NULL,part INTEGER NOT NULL,
   storage_type TEXT NOT NULL,data BLOB,PRIMARY KEY(event_rowid,column_no,part));`);

const source=db.prepare(`INSERT INTO events(rowid,project_id,id,event_type,category,occurred_at,created_at,payload,metadata)
 VALUES (?,?,?,'mapi.test','identity',9007199254741001,?, ?, ?) `);
const large=Buffer.alloc(131073,0x61);
for (const [row,project,id,payload] of [[-1,'p','negative','text'],[2,'p','two','two'],[3,'p','three','three'],[4,'p','large',large],
 [5,'p','five','five'],[6,'p','six','six'],[7,'p','seven','seven'],[8,'q','seven','foreign'],[9,'p','nine','nine'],[10,'p','ten','ten']]) {
  source.run(row,project,id,row+100,payload,'{}');
}
// Use the actual unmounted capture helper's schema, before installing this
// experiment's source triggers. The prototype is not called by that helper.
createAuditCaptureSchema(storage,route,'era-1',()=>true);
db.exec('INSERT INTO capture_active VALUES (1)');

// Repeated SQL statements intentionally retain scalar storage classes without
// passing values through JS. They are a local experiment, not a CPU bound.
function saveWhere(predicate) {
  const insert=`INSERT INTO original_versions
     SELECT e.rowid,0 FROM events e WHERE (${predicate})
       AND NOT EXISTS (SELECT 1 FROM after_capture n WHERE n.event_rowid=e.rowid)
       AND NOT EXISTS (SELECT 1 FROM original_versions v WHERE v.event_rowid=e.rowid);`;
  const copy=auditSourceColumns.map((column,i)=>`INSERT INTO original_cells
    WITH RECURSIVE parts(n) AS (
      SELECT 0 UNION ALL SELECT n+1 FROM parts WHERE n < COALESCE((SELECT max(
        CASE WHEN typeof(e.${column}) IN ('text','blob') THEN max(0,(length(CAST(e.${column} AS BLOB))-1)/65536) ELSE 0 END)
        FROM events e JOIN original_versions v ON e.rowid=v.event_rowid WHERE v.ready=0),0)
    ) SELECT e.rowid,${i},parts.n,typeof(e.${column}),
       CASE WHEN typeof(e.${column}) IN ('text','blob') THEN
         CASE WHEN length(CAST(e.${column} AS BLOB))=0 THEN X'' ELSE substr(CAST(e.${column} AS BLOB),parts.n*65536+1,65536) END
       ELSE e.${column} END
      FROM events e JOIN original_versions v ON e.rowid=v.event_rowid JOIN parts
      WHERE v.ready=0 AND parts.n < CASE WHEN typeof(e.${column}) IN ('text','blob')
        THEN max(1,(length(CAST(e.${column} AS BLOB))+65535)/65536) ELSE 1 END;`).join('\n');
  return `${insert}\n${copy}\nUPDATE original_versions SET ready=1 WHERE ready=0;`;
}
const conflict=`(e.rowid=NEW.rowid OR (e.project_id=NEW.project_id AND e.id=NEW.id))`;
db.exec(`CREATE TRIGGER capture_before_insert BEFORE INSERT ON events WHEN EXISTS (SELECT 1 FROM capture_active)
 BEGIN ${saveWhere(conflict)} END;
 CREATE TRIGGER capture_before_update BEFORE UPDATE ON events WHEN EXISTS (SELECT 1 FROM capture_active)
 BEGIN ${saveWhere(`e.rowid=OLD.rowid OR ${conflict}`)} END;
 CREATE TRIGGER capture_before_delete BEFORE DELETE ON events WHEN EXISTS (SELECT 1 FROM capture_active)
 BEGIN ${saveWhere('e.rowid=OLD.rowid')} END;
 CREATE TRIGGER capture_after_insert AFTER INSERT ON events WHEN EXISTS (SELECT 1 FROM capture_active)
 BEGIN INSERT INTO after_capture SELECT NEW.rowid WHERE NOT EXISTS
   (SELECT 1 FROM after_capture WHERE event_rowid=NEW.rowid); END;
 CREATE TRIGGER capture_after_update AFTER UPDATE ON events WHEN EXISTS (SELECT 1 FROM capture_active)
 BEGIN INSERT INTO after_capture SELECT NEW.rowid WHERE NOT EXISTS
   (SELECT 1 FROM after_capture WHERE event_rowid=NEW.rowid); END;`);

function live(rowid) {
  const columns=auditSourceColumns.flatMap((column,i)=>[`typeof(${column}) AS t${i}`,`hex(CAST(${column} AS BLOB)) AS v${i}`]).join(',');
  const row=db.prepare(`SELECT ${columns} FROM events WHERE rowid=?`).get(rowid);
  return row && auditSourceColumns.map((_,i)=>({type:row[`t${i}`],encoded:row[`v${i}`]}));
}
function version(rowid) {
  if (!db.prepare('SELECT 1 FROM original_versions WHERE event_rowid=? AND ready=1').get(rowid)) return null;
  return auditSourceColumns.map((_,i)=>{
    const parts=db.prepare(`SELECT storage_type,hex(CAST(data AS BLOB)) AS encoded
      FROM original_cells WHERE event_rowid=? AND column_no=? ORDER BY part`).all(rowid,i);
    assert.ok(parts.length); assert.ok(parts.every(p=>p.storage_type===parts[0].storage_type));
    return {type:parts[0].storage_type,encoded:parts.map(p=>p.encoded).join('')};
  });
}
const originalIds=[-1,2,3,4,5,6,7,8,9,10];
const expected=new Map(originalIds.map(id=>[id,live(id)]));
function checkSnapshot() {
  for(const [id,record] of expected) {
    const saved=version(id), isNew=!!db.prepare('SELECT 1 FROM after_capture WHERE event_rowid=?').get(id);
    assert.deepEqual(saved ?? (!isNew && live(id)),record);
  }
}
db.exec("INSERT INTO events(project_id,id,event_type,category,occurred_at,created_at) VALUES ('p','new','x','identity',1,2)");
checkSnapshot();
db.exec("INSERT INTO events(project_id,id,event_type,category,occurred_at,created_at) VALUES ('p','two','x','identity',1,2) ON CONFLICT(project_id,id) DO NOTHING");
checkSnapshot();
// The outer conflict policy must not replace a trigger's error policy and
// turn an internal duplicate marker into a failed business update. Exercise
// original and newly inserted rows after each marker already exists.
for (const policy of ['FAIL','ABORT']) {
  db.exec(`UPDATE OR ${policy} events SET payload='changed-original' WHERE project_id='p' AND id='two'`);
  db.exec(`UPDATE OR ${policy} events SET payload='changed-new' WHERE project_id='p' AND id='new'`);
  assert.equal(db.prepare("SELECT payload FROM events WHERE project_id='p' AND id='two'").get().payload,'changed-original');
  assert.equal(db.prepare("SELECT payload FROM events WHERE project_id='p' AND id='new'").get().payload,'changed-new');
  checkSnapshot();
}
db.exec("INSERT OR REPLACE INTO events(project_id,id,event_type,category,occurred_at,created_at) VALUES ('p','large','x','identity',1,2)");
checkSnapshot();
assert.equal(db.prepare('SELECT count(*) AS n FROM original_cells WHERE event_rowid=4 AND column_no=?').get(auditSourceColumns.indexOf('payload')).n,3);
db.exec("UPDATE OR REPLACE events SET id='six' WHERE project_id='p' AND id='five'");
checkSnapshot();
db.exec("INSERT OR REPLACE INTO events(rowid,project_id,id,event_type,category,occurred_at,created_at) VALUES (9,'p','ten','x','identity',1,2)");
checkSnapshot();
db.exec("DELETE FROM events WHERE project_id='p' AND id='three'");
checkSnapshot();
db.exec('BEGIN');
db.exec("UPDATE events SET payload='changed' WHERE project_id='p' AND id='seven'");
assert.equal(db.prepare('SELECT count(*) AS n FROM original_versions WHERE event_rowid=7').get().n,1);
db.exec('ROLLBACK');
assert.equal(db.prepare('SELECT count(*) AS n FROM original_versions WHERE event_rowid=7').get().n,0);
checkSnapshot();
assert.equal(db.prepare("SELECT count(*) AS n FROM original_cells WHERE typeof(data)='blob' AND length(data)>65536").get().n,0);

// Investigate format compatibility with the existing capture staging tables.
// This trusted synthetic adapter is not production authorization or a
// complete source-version/recovery protocol.
function stageVersion(snapshotId,rowid,inject=false) {
  return storage.transactionSync(()=>{
    assertOwnerFence(storage,route);
    assert.equal(db.prepare("SELECT count(*) AS n FROM mapi_recovery_epoch WHERE typeof(epoch)='text' AND epoch COLLATE BINARY='era-1'").get().n,1);
    assert.equal(db.prepare('SELECT count(*) AS n FROM original_versions WHERE event_rowid=? AND ready=1').get(rowid).n,1);
    // Bind the route to the saved project's exact TEXT bytes rather than the
    // current live row: the latter may have been deleted or replaced. Check
    // every fragment, including type and count, without returning it to JS.
    const projectColumn=auditSourceColumns.indexOf('project_id');
    const projectMatch=db.prepare(`WITH expected AS (
      SELECT CAST(? AS BLOB) AS data,max(1,(length(CAST(? AS BLOB))+65535)/65536) AS parts
    ) SELECT CASE WHEN count(*)=expected.parts AND sum(CASE
      WHEN c.storage_type='text' AND typeof(c.data)='blob' AND c.part>=0 AND c.part<expected.parts
        AND c.data IS CASE WHEN length(expected.data)=0 THEN X'' ELSE substr(expected.data,c.part*65536+1,65536) END
      THEN 1 ELSE 0 END)=expected.parts THEN 1 ELSE 0 END AS ok
      FROM original_cells c, expected WHERE c.event_rowid=? AND c.column_no=?`)
      .get(route.projectId,route.projectId,rowid,projectColumn).ok;
    if (projectMatch !== 1) throw Error('Saved event project differs');
    assert.equal(db.prepare("SELECT count(*) AS n FROM original_cells WHERE event_rowid=? AND storage_type='real'").get(rowid).n,0);
    const count=db.prepare('SELECT count(*) AS n FROM original_cells WHERE event_rowid=?').get(rowid).n;
    const exists=db.prepare('SELECT 1 FROM mapi_audit_capture_rows WHERE snapshot_id=? AND ordinal=0').get(snapshotId);
    if (!exists) {
      db.prepare(`INSERT INTO mapi_audit_capture_fragments
        SELECT ?,0,column_no,part,storage_type,data FROM original_cells WHERE event_rowid=?`).run(snapshotId,rowid);
      if(inject) throw Error('injected staging failure');
      db.prepare('INSERT INTO mapi_audit_capture_rows VALUES (?,0,?,?,?,?,?,?,?,?,?)')
        .run(snapshotId,String(rowid),route.projectId,route.origin,route.objectName,route.generation,'era-1','b'.repeat(64),'c'.repeat(64),count);
    }
    const head=db.prepare(`SELECT 1 FROM mapi_audit_capture_rows WHERE snapshot_id=? AND ordinal=0 AND source_rowid=?
      AND project_id=? AND origin=? AND object_name=? AND generation=? AND recovery_epoch=?
      AND principal_digest=? AND request_digest=? AND fragment_count=?`)
      .get(snapshotId,String(rowid),route.projectId,route.origin,route.objectName,route.generation,'era-1','b'.repeat(64),'c'.repeat(64),count);
    assert.ok(head);
    const total=db.prepare('SELECT count(*) AS n FROM mapi_audit_capture_fragments WHERE snapshot_id=? AND ordinal=0').get(snapshotId).n;
    const same=db.prepare(`SELECT count(*) AS n FROM original_cells v JOIN mapi_audit_capture_fragments f
       ON f.snapshot_id=? AND f.ordinal=0 AND f.column_no=v.column_no AND f.part_no=v.part
       WHERE v.event_rowid=? AND f.storage_type=v.storage_type AND typeof(f.data)=typeof(v.data) AND f.data IS v.data`).get(snapshotId,rowid).n;
    assert.equal(total,count);assert.equal(same,count);assertOwnerFence(storage,route);
    return {replayed:!!exists,count};
  });
}
const stageId='d'.repeat(32), failedId='e'.repeat(32);
// Save the other project's pre-update row, then reject its staging before any
// destination writes even though its rowid is known to this test-only caller.
db.exec("UPDATE events SET payload='foreign-changed' WHERE rowid=8");
assert.throws(()=>stageVersion('f'.repeat(32),8),/Saved event project differs/);
assert.equal(db.prepare("SELECT count(*) AS n FROM mapi_audit_capture_fragments WHERE snapshot_id=?").get('f'.repeat(32)).n,0);
const staged=stageVersion(stageId,4);assert.equal(staged.replayed,false);
assert.equal(stageVersion(stageId,4).replayed,true);
assert.throws(()=>stageVersion(failedId,4,true),/injected staging failure/);
assert.equal(db.prepare('SELECT count(*) AS n FROM mapi_audit_capture_fragments WHERE snapshot_id=?').get(failedId).n,0);
assert.equal(db.prepare('SELECT count(*) AS n FROM mapi_audit_capture_rows WHERE snapshot_id=?').get(failedId).n,0);
db.exec(`UPDATE mapi_audit_capture_fragments SET data=X'00' WHERE snapshot_id='${stageId}' AND ordinal=0 AND column_no=0 AND part_no=0`);
assert.throws(()=>stageVersion(stageId,4));
db.close();
console.log('Native pinned-column copy-on-write audit experiment passed');
