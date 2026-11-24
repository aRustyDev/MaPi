import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';

// Exercise the SQL used by the Go guard directly, without running a recovery
// workflow or emulating the bridge. The guard needs to distinguish exactly
// one authority row from zero or multiple rows.
const source = await readFile(new URL('../upstream/overlay/apps/api/cmd/mapi-wasm/recovery_token_guard_wasip1.go', import.meta.url), 'utf8');
const query = source.match(/db\.QueryContext\(ctx, "([^"]+)"\)/)?.[1];
assert.ok(query, 'missing recovery authority query');
const db = new DatabaseSync(':memory:');
try {
  db.exec('CREATE TABLE mapi_project(project_id TEXT PRIMARY KEY); CREATE TABLE mapi_recovery_epoch(epoch TEXT NOT NULL)');
  const rows = () => db.prepare(query).all();
  assert.equal(rows().length, 0);
  db.exec("INSERT INTO mapi_project VALUES ('p');");
  assert.equal(rows().length, 0);
  db.exec("INSERT INTO mapi_recovery_epoch VALUES ('era');");
  assert.deepEqual({ ...rows()[0] }, { project_id: 'p', epoch: 'era' });
  assert.equal(rows().length, 1);
  db.exec("INSERT INTO mapi_recovery_epoch VALUES ('era');");
  assert.equal(rows().length, 2, 'duplicate authority must remain ambiguous');
  db.exec("WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<999) INSERT INTO mapi_project SELECT 'p' || i FROM n");
  db.exec("WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<998) INSERT INTO mapi_recovery_epoch SELECT 'e' || i FROM n");
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM mapi_project').get().n, 1000);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM mapi_recovery_epoch').get().n, 1000);
  assert.equal(rows().length, 2, 'large Cartesian product must return at most two rows');
  db.exec('DELETE FROM mapi_project');
  assert.equal(rows().length, 0, 'missing project remains missing');
} finally {
  db.close();
}
console.log('Recovery token authority query bounds passed (native SQLite)');
