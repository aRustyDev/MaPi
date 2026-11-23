// Unmounted SQLite mechanism experiment. This deliberately uses a small
// synthetic schema, not the pinned event schema or any production Worker.
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

const db = new DatabaseSync(':memory:');
db.exec(`PRAGMA recursive_triggers = OFF;
  CREATE TABLE events (project_id TEXT NOT NULL, id TEXT NOT NULL, created_at INTEGER NOT NULL,
    payload BLOB NOT NULL, PRIMARY KEY(project_id,id));
  CREATE TABLE capture_active (singleton INTEGER PRIMARY KEY CHECK(singleton=1));
  CREATE TABLE after_capture (event_rowid INTEGER PRIMARY KEY);
  CREATE TABLE original_versions (event_rowid INTEGER PRIMARY KEY, project_id TEXT NOT NULL,
    id TEXT NOT NULL, created_at INTEGER NOT NULL, payload_type TEXT NOT NULL, ready INTEGER NOT NULL);
  CREATE TABLE original_fragments (event_rowid INTEGER NOT NULL, part INTEGER NOT NULL,
    data BLOB NOT NULL, PRIMARY KEY(event_rowid,part));
  INSERT INTO events(rowid,project_id,id,created_at,payload) VALUES
    (-1,'p','original-negative',11,X'0102'), (2,'p','original-two',12,X'0304'),
    (3,'p','original-three',13,X'0506'), (4,'p','original-four',14,zeroblob(140)),
    (5,'p','original-five',15,X'07'), (6,'p','original-six',16,X'08'),
    (7,'p','original-seven',17,X'09'), (8,'q','original-seven',18,X'0A'),
    (9,'p','original-nine',19,X'0B'), (10,'p','original-ten',20,X'0C');
  INSERT INTO capture_active VALUES (1);`);

// Capture all original rows that the operation could replace. This stores
// every source payload in 64-byte pieces in SQL. A duplicate no-op may create
// an unnecessary version, but does not change its application outcome.
function saveWhere(predicate) {
  return `INSERT OR IGNORE INTO original_versions
      SELECT e.rowid,e.project_id,e.id,e.created_at,typeof(e.payload),0 FROM events e
       WHERE (${predicate}) AND NOT EXISTS (SELECT 1 FROM after_capture n WHERE n.event_rowid=e.rowid);
    INSERT INTO original_fragments(event_rowid,part,data)
      WITH RECURSIVE parts(n) AS (
        SELECT 0 UNION ALL SELECT n+1 FROM parts WHERE n < COALESCE((SELECT max((length(CAST(e.payload AS BLOB))-1)/64)
          FROM events e JOIN original_versions v ON e.rowid=v.event_rowid WHERE v.ready=0),0)
      ) SELECT e.rowid,parts.n,
         CASE WHEN length(CAST(e.payload AS BLOB))=0 THEN X'' ELSE substr(CAST(e.payload AS BLOB),parts.n*64+1,64) END
        FROM events e JOIN original_versions v ON e.rowid=v.event_rowid JOIN parts
        WHERE v.ready=0 AND parts.n < max(1,(length(CAST(e.payload AS BLOB))+63)/64);
    UPDATE original_versions SET ready=1 WHERE ready=0;`;
}
const conflict = `(e.rowid=NEW.rowid OR (e.project_id=NEW.project_id AND e.id=NEW.id))`;
db.exec(`CREATE TRIGGER capture_before_insert BEFORE INSERT ON events
  WHEN EXISTS (SELECT 1 FROM capture_active WHERE singleton=1) BEGIN ${saveWhere(conflict)} END;
  CREATE TRIGGER capture_before_update BEFORE UPDATE ON events
  WHEN EXISTS (SELECT 1 FROM capture_active WHERE singleton=1) BEGIN ${saveWhere(`e.rowid=OLD.rowid OR ${conflict}`)} END;
  CREATE TRIGGER capture_before_delete BEFORE DELETE ON events
  WHEN EXISTS (SELECT 1 FROM capture_active WHERE singleton=1) BEGIN ${saveWhere('e.rowid=OLD.rowid')} END;
  CREATE TRIGGER capture_after_insert AFTER INSERT ON events
  WHEN EXISTS (SELECT 1 FROM capture_active WHERE singleton=1) BEGIN
    INSERT OR IGNORE INTO after_capture VALUES (NEW.rowid); END;
  CREATE TRIGGER capture_after_update AFTER UPDATE ON events
  WHEN EXISTS (SELECT 1 FROM capture_active WHERE singleton=1) BEGIN
    INSERT OR IGNORE INTO after_capture VALUES (NEW.rowid); END;`);

function snapshot() {
  const original = db.prepare(`SELECT e.rowid,e.project_id,e.id,e.created_at,e.payload FROM events e
    WHERE NOT EXISTS (SELECT 1 FROM after_capture n WHERE n.event_rowid=e.rowid)
      AND NOT EXISTS (SELECT 1 FROM original_versions v WHERE v.event_rowid=e.rowid)
    ORDER BY e.rowid`).all().map(r=>({rowid:r.rowid,project:r.project_id,id:r.id,time:r.created_at,bytes:Buffer.from(r.payload)}));
  const saved = db.prepare('SELECT event_rowid,project_id,id,created_at,ready FROM original_versions ORDER BY event_rowid').all().map(r=>{
    assert.equal(r.ready,1);
    const parts=db.prepare('SELECT data FROM original_fragments WHERE event_rowid=? ORDER BY part').all(r.event_rowid);
    return {rowid:r.event_rowid,project:r.project_id,id:r.id,time:r.created_at,bytes:Buffer.concat(parts.map(p=>Buffer.from(p.data)))};
  });
  return [...original,...saved].sort((a,b)=>a.rowid-b.rowid);
}
const before=snapshot();
const big=Buffer.alloc(140,0x61);
db.prepare('INSERT INTO events(project_id,id,created_at,payload) VALUES (?,?,?,?)').run('p','new',14,big);
assert.deepEqual(snapshot(),before); // automatic rowid with an original rowid -1
db.exec("INSERT INTO events VALUES ('p','original-two',99,X'FFFF') ON CONFLICT(project_id,id) DO NOTHING");
assert.deepEqual(snapshot(),before);
db.exec("INSERT OR REPLACE INTO events VALUES ('p','original-three',99,X'AAAA')");
assert.deepEqual(snapshot(),before); // implicit REPLACE delete with recursive triggers off
db.exec("INSERT OR REPLACE INTO events VALUES ('p','original-four',99,X'AAAA')");
assert.deepEqual(snapshot(),before);
assert.equal(db.prepare('SELECT count(*) AS n FROM original_fragments WHERE event_rowid=4').get().n,3);
db.exec("UPDATE OR REPLACE events SET id='original-six' WHERE id='original-five'");
assert.deepEqual(snapshot(),before); // update plus implicit conflicting-row deletion
db.exec("INSERT OR REPLACE INTO events(rowid,project_id,id,created_at,payload) VALUES (9,'p','original-ten',21,X'0D')");
assert.deepEqual(snapshot(),before); // two separate original rows conflict
assert.equal(db.prepare('SELECT count(*) AS n FROM original_versions WHERE event_rowid IN (9,10)').get().n,2);
db.exec("UPDATE events SET payload=X'ABCD' WHERE id='original-negative'");
assert.deepEqual(snapshot(),before);
db.exec("DELETE FROM events WHERE id='original-two'");
assert.deepEqual(snapshot(),before);
db.exec("UPDATE events SET payload=X'01' WHERE id='new'; DELETE FROM events WHERE id='new'");
assert.deepEqual(snapshot(),before);
db.exec('BEGIN');
db.exec("UPDATE events SET payload=X'EF' WHERE project_id='p' AND id='original-seven'");
assert.equal(db.prepare('SELECT count(*) AS n FROM original_versions WHERE event_rowid=7').get().n,1);
db.exec('ROLLBACK');
assert.equal(db.prepare('SELECT count(*) AS n FROM original_versions WHERE event_rowid=7').get().n,0);
assert.deepEqual(snapshot(),before);
assert.ok(db.prepare('SELECT count(*) AS n FROM original_fragments WHERE length(data)>64').get().n===0);
db.close();
console.log('Native SQLite copy-on-write audit experiment passed');
