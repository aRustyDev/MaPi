// Distinct native SQLite mechanism test. No production owner or Worker is used.
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

function database(conditional) {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE events(id INTEGER PRIMARY KEY, value INTEGER NOT NULL);
    CREATE TABLE original_versions(id INTEGER PRIMARY KEY, value INTEGER NOT NULL);
    CREATE TABLE after_capture(id INTEGER PRIMARY KEY);
    INSERT INTO events VALUES (1, 1);`);
  const originalInsert = (predicate) => conditional
    ? `INSERT INTO original_versions SELECT e.id,e.value FROM events e WHERE (${predicate})
         AND NOT EXISTS (SELECT 1 FROM after_capture a WHERE a.id=e.id)
         AND NOT EXISTS (SELECT 1 FROM original_versions v WHERE v.id=e.id);`
    : `INSERT OR IGNORE INTO original_versions SELECT e.id,e.value FROM events e WHERE (${predicate})
         AND NOT EXISTS (SELECT 1 FROM after_capture a WHERE a.id=e.id);`;
  const mark = conditional
    ? 'INSERT INTO after_capture SELECT NEW.id WHERE NOT EXISTS (SELECT 1 FROM after_capture WHERE id=NEW.id);'
    : 'INSERT OR IGNORE INTO after_capture VALUES (NEW.id);';
  db.exec(`CREATE TRIGGER before_insert BEFORE INSERT ON events BEGIN ${originalInsert('e.id=NEW.id')} END;
    CREATE TRIGGER before_update BEFORE UPDATE ON events BEGIN ${originalInsert('e.id=OLD.id OR e.id=NEW.id')} END;
    CREATE TRIGGER after_insert AFTER INSERT ON events BEGIN ${mark} END;
    CREATE TRIGGER after_update AFTER UPDATE ON events BEGIN ${mark} END;`);
  return db;
}

// A no-op conflict speculatively records the original, without marking the
// original row as new. OR FAIL on a later valid write overrides the trigger's
// OR IGNORE policy and turns that internal duplicate into an application error.
for (const policy of ['FAIL', 'ABORT']) {
  const db = database(false);
  db.exec('INSERT INTO events VALUES(1, 2) ON CONFLICT(id) DO NOTHING');
  assert.throws(() => db.exec(`UPDATE OR ${policy} events SET value=3 WHERE id=1`));
  assert.equal(db.prepare('SELECT value FROM events WHERE id=1').get().value, 1);
  db.close();
}
// An AFTER trigger conflict under OR FAIL can report failure after the new
// row's update has already happened. A real caller must not infer rollback.
for (const policy of ['FAIL', 'ABORT']) {
  const db = database(false);
  db.exec('INSERT INTO events VALUES(2, 2)');
  assert.throws(() => db.exec(`UPDATE OR ${policy} events SET value=3 WHERE id=2`));
  assert.equal(db.prepare('SELECT value FROM events WHERE id=2').get().value, policy === 'FAIL' ? 3 : 2);
  db.close();
}
// Conditional inserts avoid these specific duplicate conflicts in this
// single-connection fixture; this is not proof for the full event protocol.
for (const policy of ['FAIL', 'ABORT']) {
  const db = database(true);
  db.exec('INSERT INTO events VALUES(1, 2) ON CONFLICT(id) DO NOTHING');
  db.exec(`UPDATE OR ${policy} events SET value=3 WHERE id=1`);
  assert.equal(db.prepare('SELECT value FROM events WHERE id=1').get().value, 3);
  assert.equal(db.prepare('SELECT value FROM original_versions WHERE id=1').get().value, 1);
  db.exec('INSERT INTO events VALUES(2, 2)');
  db.exec(`UPDATE OR ${policy} events SET value=4 WHERE id=2`);
  assert.equal(db.prepare('SELECT value FROM events WHERE id=2').get().value, 4);
  db.exec('INSERT OR REPLACE INTO events VALUES(1, 5)');
  assert.equal(db.prepare('SELECT value FROM original_versions WHERE id=1').get().value, 1);
  db.close();
}
console.log('Native SQLite trigger conflict-policy checks passed');
