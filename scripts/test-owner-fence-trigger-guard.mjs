// Distinct native SQLite test for side effects that leave the fence row valid.
// This does not exercise the registry, a real owner, or a hosted deployment.
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createOwnerFenceTable, initializeOwnerFence, freezeOwnerFence } from '../worker/owner-fence.js';

function fixture(uppercase = false) {
  const db = new DatabaseSync(':memory:');
  const storage = {
    sql: { exec(query, ...args) {
      const stmt = db.prepare(query);
      const rows = stmt.columns().length ? stmt.all(...args) : (stmt.run(...args), []);
      return { toArray: () => rows, one: () => { assert.equal(rows.length, 1); return rows[0]; } };
    } },
    transactionSync(fn) {
      db.exec('BEGIN');
      try { const result = fn(); db.exec('COMMIT'); return result; }
      catch (error) { db.exec('ROLLBACK'); throw error; }
    },
  };
  db.exec('CREATE TABLE business (value INTEGER NOT NULL); INSERT INTO business VALUES (0); CREATE TABLE audit (value INTEGER NOT NULL)');
  if (uppercase) db.exec(`CREATE TABLE MAPI_OWNER_FENCE (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1), project_id TEXT NOT NULL,
    origin TEXT NOT NULL, object_name TEXT NOT NULL, generation INTEGER NOT NULL CHECK (generation > 0),
    state TEXT NOT NULL CHECK (state IN ('pending', 'active', 'frozen', 'retired')), move_id TEXT, digest TEXT
  )`);
  else createOwnerFenceTable(storage);
  return { db, storage };
}

const route = { projectId: 'synthetic-project', origin: 'https://synthetic.invalid', objectName: 'synthetic-owner', generation: 1 };
{
  const { db, storage } = fixture();
  db.exec('CREATE TRIGGER fence_extra_insert AFTER INSERT ON mapi_owner_fence BEGIN UPDATE business SET value = 1; INSERT INTO audit VALUES (1); END');
  assert.throws(() => initializeOwnerFence(storage, route), /Owner fence initialization did not take effect/);
  assert.equal(db.prepare('SELECT count(*) AS n FROM mapi_owner_fence').get().n, 0);
  assert.equal(db.prepare('SELECT value FROM business').get().value, 0);
  assert.equal(db.prepare('SELECT count(*) AS n FROM audit').get().n, 0);
  db.exec('DROP TRIGGER fence_extra_insert');
  initializeOwnerFence(storage, route);
  initializeOwnerFence(storage, route);
  db.close();
}
{
  // SQLite resolves this table name case-insensitively, while sqlite_schema
  // retains its original case. A binary schema lookup must not miss it.
  const { db, storage } = fixture(true);
  db.exec('CREATE TRIGGER fence_upper_insert AFTER INSERT ON MAPI_OWNER_FENCE BEGIN UPDATE business SET value = 1; END');
  assert.throws(() => initializeOwnerFence(storage, route), /Owner fence initialization did not take effect/);
  assert.equal(db.prepare('SELECT value FROM business').get().value, 0);
  assert.equal(db.prepare('SELECT count(*) AS n FROM MAPI_OWNER_FENCE').get().n, 0);
  db.close();
}
{
  const { db, storage } = fixture();
  initializeOwnerFence(storage, route);
  db.exec('CREATE TRIGGER fence_extra_update AFTER UPDATE ON mapi_owner_fence BEGIN UPDATE business SET value = 1; INSERT INTO audit VALUES (1); END');
  assert.throws(() => freezeOwnerFence(storage, route, 'synthetic-move'), /Owner freeze did not take effect/);
  assert.equal(db.prepare('SELECT state FROM mapi_owner_fence').get().state, 'active');
  assert.equal(db.prepare('SELECT value FROM business').get().value, 0);
  assert.equal(db.prepare('SELECT count(*) AS n FROM audit').get().n, 0);
  db.exec('DROP TRIGGER fence_extra_update');
  freezeOwnerFence(storage, route, 'synthetic-move');
  freezeOwnerFence(storage, route, 'synthetic-move');
  assert.equal(db.prepare('SELECT state FROM mapi_owner_fence').get().state, 'frozen');
  db.close();
}
console.log('Owner fence trigger guard checks passed');
