// A local SQLite experiment, not a deployed snapshot fence. A DELETE trigger
// cannot be assumed to stop replacement of an original audit row.
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

for (const recursive of [false, true]) {
  const db = new DatabaseSync(':memory:');
  db.exec(`PRAGMA recursive_triggers = ${recursive ? 'ON' : 'OFF'}`);
  assert.equal(db.prepare('PRAGMA recursive_triggers').get().recursive_triggers, recursive ? 1 : 0);
  db.exec(`CREATE TABLE events (project_id TEXT NOT NULL, id TEXT NOT NULL,
             payload TEXT NOT NULL, PRIMARY KEY(project_id, id));
           INSERT INTO events VALUES ('p', 'one', 'original');
           CREATE TRIGGER guard_event_delete BEFORE DELETE ON events
           BEGIN SELECT RAISE(ABORT, 'snapshot active'); END;
           CREATE TRIGGER guard_event_update BEFORE UPDATE ON events
           BEGIN SELECT RAISE(ABORT, 'snapshot active'); END;`);
  assert.throws(() => db.exec("UPDATE events SET payload='changed' WHERE id='one'"), /snapshot active/);
  assert.throws(() => db.exec("DELETE FROM events WHERE id='one'"), /snapshot active/);
  assert.throws(() => db.exec("INSERT INTO events VALUES ('p','one','changed') ON CONFLICT(project_id,id) DO UPDATE SET payload=excluded.payload"), /snapshot active/);
  // DO NOTHING remains a valid no-op even while the triggers exist.
  db.exec("INSERT INTO events VALUES ('p','one','ignored') ON CONFLICT(project_id,id) DO NOTHING");
  assert.equal(db.prepare("SELECT payload FROM events WHERE id='one'").get().payload, 'original');
  if (recursive) {
    assert.throws(() => db.exec("INSERT OR REPLACE INTO events VALUES ('p','one','replaced')"), /snapshot active/);
    assert.equal(db.prepare("SELECT payload FROM events WHERE id='one'").get().payload, 'original');
  } else {
    db.exec("INSERT OR REPLACE INTO events VALUES ('p','one','replaced')");
    assert.equal(db.prepare("SELECT payload FROM events WHERE id='one'").get().payload, 'replaced');
  }
  db.close();
}
console.log('Native SQLite audit replacement trigger experiment passed');
