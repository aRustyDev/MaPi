import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createOwnerFenceTable, retireOwnerFence } from '../worker/owner-fence.js';

const db = new DatabaseSync(':memory:');
let ignoreRetirement = false;
const storage = {
  transactionSync(fn) {
    db.exec('BEGIN');
    try { const value = fn(); db.exec('COMMIT'); return value; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  },
  sql: { exec(sql, ...args) {
    if (ignoreRetirement && sql.startsWith("UPDATE mapi_owner_fence SET state = 'retired'")) return { toArray: () => [] };
    const statement = db.prepare(sql);
    const rows = statement.columns().length ? statement.all(...args) : (statement.run(...args), []);
    return { toArray: () => rows, one: () => rows[0] };
  } },
};
const route = { projectId:'p', origin:'https://p.example', objectName:'source', generation:1 };
const fence = () => db.prepare('SELECT state, move_id, digest FROM mapi_owner_fence').get();
try {
  createOwnerFenceTable(storage);
  db.exec("INSERT INTO mapi_owner_fence VALUES (1, 'p', 'https://p.example', 'source', 1, 'frozen', 'move', 'digest')");
  db.exec('CREATE TABLE business (id INTEGER PRIMARY KEY)');
  db.exec("CREATE TRIGGER reject_retirement BEFORE UPDATE ON mapi_owner_fence BEGIN INSERT INTO business VALUES (1); SELECT RAISE(IGNORE); END");
  assert.throws(() => retireOwnerFence(storage, route, 'move', 'digest', true), /Owner retirement did not take effect/);
  assert.equal(fence().state, 'frozen');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM business').get().n, 0);
  db.exec('DROP TRIGGER reject_retirement');
  ignoreRetirement = true;
  assert.throws(() => retireOwnerFence(storage, route, 'move', 'digest', true), /Owner retirement did not take effect/);
  assert.equal(fence().state, 'frozen');
  ignoreRetirement = false;
  assert.throws(() => retireOwnerFence(storage, route, 'other', 'digest', true), /Source retirement mismatch/);
  assert.throws(() => retireOwnerFence(storage, route, 'move', 'digest', false), /manual review/);
  retireOwnerFence(storage, route, 'move', 'digest', true);
  assert.equal(fence().state, 'retired');
  retireOwnerFence(storage, route, 'move', 'digest', false);
  assert.throws(() => retireOwnerFence(storage, route, 'move', 'wrong', true), /Source retirement mismatch/);
  console.log('Native owner retirement postcondition and retry checks passed');
} finally { db.close(); }
