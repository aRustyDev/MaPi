import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { execute } from '../worker/sql.js';

// Instrument the actual rewritten SQLite CTE, including dense input. This
// bounds visited nodes in native SQLite, not bytes scanned or hosted CPU.
const db = new DatabaseSync(':memory:');
const names = Array.from({ length: 49 }, (_, i) => `c${i}`);
db.exec(`CREATE TABLE sample (id INTEGER PRIMARY KEY, value BLOB, ${names.join(',')})`);
db.exec('CREATE TABLE audit(n INTEGER NOT NULL); INSERT INTO audit VALUES(0)');
db.exec('CREATE TRIGGER audit_delete AFTER DELETE ON sample BEGIN UPDATE audit SET n=n+1; END');
let visits = 0, selected = '', encodedRow;
db.function('mapi_counted', () => { visits++; return 1; });
const storage = { sql: { exec(statement, ...args) {
  selected = statement;
  const needle = 'WHERE n>1 AND substr(v,';
  assert.ok(statement.includes(needle), 'Expected production sparse-zero CTE');
  statement = statement.replace(needle, 'WHERE mapi_counted() AND n>1 AND substr(v,');
  const prepared = db.prepare(statement);
  prepared.setReturnArrays(true);
  return { raw: () => ({ toArray: () => { const rows = prepared.all(...args); encodedRow = rows[0]; return rows; } }) };
} } };
const prefix = Uint8Array.from([255,0,0,0,0,0,0,0,0,...new TextEncoder().encode('@MaPiRun1')]);
const size = 8_388_000;
const sample = new Uint8Array(prefix.length + size + 64);
sample.set(prefix);
for (let i = 0; i < 64; i++) sample[prefix.length + size + i] = i * 3;
const spaced = count => Array.from({ length: count }, (_, i) => Math.floor((i + 1) * size / (count + 1)));
const clustered = count => Array.from({ length: count }, (_, i) => i);
const cases = [
  { offsets: [0], compact: true },
  { offsets: [size - 1], compact: true },
  { offsets: [1, 31, 812, 73_000, 2_000_000, 4_000_000, 5_000_000, size - 2], compact: true },
  { offsets: spaced(9), compact: true },
  { offsets: spaced(32), compact: true },
  { offsets: spaced(64), compact: true },
  { offsets: spaced(65), compact: true },
  { offsets: clustered(256), compact: true },
  { offsets: spaced(256), compact: false },
  { offsets: clustered(4096), compact: false },
];
const write = db.prepare('INSERT INTO sample(id,value) VALUES(?,?)');
const padding = `/*${'x'.repeat(60000)}*/`;
const statement = `DELETE FROM sample ${padding} RETURNING id,value,${names.join(',')}`;
for (const [index, { offsets, compact }] of cases.entries()) {
  sample.fill(0, prefix.length, prefix.length + size);
  for (const [i, offset] of offsets.entries()) sample[prefix.length + offset] = i % 255 + 1;
  write.run(index, sample);
  visits = 0;
  const result = execute(storage, { statement, args: [], query: true });
  assert.ok(selected.startsWith('WITH mapi_shared_value'), 'Shared rewrite not selected');
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0][0].integer, String(index));
  assert.equal(result.rows[0][1].blob, sample.toBase64());
  assert.ok(result.rows[0].slice(2).every(value => value === null));
  // Each scan admits at most 2,048 nodes and checks two children per node.
  // This native SQLite planner may evaluate the correlated scan twice.
  assert.ok(visits > 0 && visits <= 8192, `Unexpected sparse tree work: ${visits} visits`);
  const wire = encodedRow[1];
  assert.equal(wire[compact ? 18 : 9], compact ? 75 : 255,
    `Unexpected sparse encoding selection for ${offsets.length} bytes`);
  assert.equal(db.prepare('SELECT n FROM audit').get().n, index + 1);
  console.log(`Sparse zero differential: ${offsets.length} nonzero bytes, ${visits} node checks.`);
}
// The patch format adds 18 bytes plus 10 per patch compared with the
// ordinary escape. Use it only when it is strictly smaller.
for (const spanLength of [98, 99]) {
  const source = new Uint8Array(prefix.length + spanLength + 64);
  source.set(prefix);
  for (let i = 0; i < 8; i++) source[prefix.length + Math.floor(i * (spanLength - 1) / 7)] = i + 1;
  write.run(100 + spanLength, source);
  visits = 0;
  const result = execute(storage, { statement, args: [], query: true });
  assert.equal(result.rows[0][1].blob, source.toBase64());
  assert.equal(encodedRow[1][spanLength === 99 ? 18 : 9], spanLength === 99 ? 75 : 255,
    `Unexpected sparse encoding at the size break-even point ${spanLength}`);
}
db.close();
