import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { execute } from '../worker/sql.js';

// Exercise the real wide RETURNING rewrite against native SQLite while using
// independently generated signed BigInts as the expected result.
const db = new DatabaseSync(':memory:');
const names = Array.from({ length: 51 }, (_, index) => `c${index}`);
db.exec(`CREATE TABLE values_to_delete (id INTEGER PRIMARY KEY,${names.join(',')})`);
const insert = db.prepare(`INSERT INTO values_to_delete VALUES (${Array.from({ length: 52 }, () => '?').join(',')})`);
const boundaries = [-(1n << 63n), (1n << 63n) - 1n, -1n, 0n, 1n];
for (const bit of [7n, 15n, 23n, 31n, 47n, 63n]) {
  for (const delta of [-1n, 0n, 1n]) for (const sign of [-1n, 1n]) {
    const value = sign * ((1n << bit) + delta);
    if (value >= -(1n << 63n) && value <= (1n << 63n) - 1n) boundaries.push(value);
  }
}
let state = 0xaad8236710fe85c9n;
const expected = [];
db.exec('BEGIN');
for (let row = 0; row < 1961; row++) {
  const values = names.map((_, column) => {
    const index = row * names.length + column;
    if (index < boundaries.length) return boundaries[index];
    state = BigInt.asUintN(64, state * 6364136223846793005n + 1442695040888963407n);
    return BigInt.asIntN(64, state);
  });
  expected.push(values);
  insert.run(row, ...values);
}
db.exec('COMMIT');
const useTerse = process.env.MAPI_TEST_TERSE === '1';
let selectedSQL;
const storage = { sql: { exec(statement, ...args) {
  selectedSQL = statement;
  const prepared = db.prepare(statement);
  prepared.setReturnArrays(true);
  return { raw: () => ({ toArray: () => prepared.all(...args) }) };
} } };
const padding = useTerse ? `/*${'x'.repeat(60000)}*/` : '';
const result = execute(storage, { statement: `DELETE FROM values_to_delete ${padding} RETURNING id,${names.join(',')}`, args: [], query: true });
assert.equal(selectedSQL.includes("X'4D615069233921403F'"), useTerse, 'Unexpected wide codec selected');
assert.equal(result.columns.length, 52);
assert.equal(result.rows.length, expected.length);
const seen = new Set();
for (const row of result.rows) {
  const index = Number(row[0].integer);
  assert.ok(Number.isSafeInteger(index) && expected[index] && !seen.has(index));
  seen.add(index);
  for (let column = 0; column < names.length; column++) {
    assert.equal(row[column + 1].integer, expected[index][column].toString(), `row ${index}, column ${column}`);
  }
}
assert.equal(seen.size, expected.length);
assert.equal(db.prepare('SELECT COUNT(*) AS n FROM values_to_delete').get().n, 0);
console.log(`Native SQLite ${useTerse ? 'terse' : 'compact'} wide RETURNING int64 differential passed ${expected.length * names.length} values.`);
db.close();
