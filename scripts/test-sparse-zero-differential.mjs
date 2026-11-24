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
let visits = 0, selected = '';
db.function('mapi_counted', () => { visits++; return 1; });
const storage = { sql: { exec(statement, ...args) {
  selected = statement;
  const needle = 'WHERE n>1 AND substr(v,';
  assert.ok(statement.includes(needle), 'Expected production sparse-zero CTE');
  statement = statement.replace(needle, 'WHERE mapi_counted() AND n>1 AND substr(v,');
  const prepared = db.prepare(statement);
  prepared.setReturnArrays(true);
  return { raw: () => ({ toArray: () => prepared.all(...args) }) };
} } };
const prefix = Uint8Array.from([255,0,0,0,0,0,0,0,0,...new TextEncoder().encode('@MaPiRun1')]);
const size = 8_388_000;
const sample = new Uint8Array(prefix.length + size + 64);
sample.set(prefix);
for (let i = 0; i < 64; i++) sample[prefix.length + size + i] = i * 3;
const cases = [
  [0], [size - 1], [1, 31, 812, 73_000, 2_000_000, 4_000_000, 5_000_000, size - 2],
  Array.from({ length: 9 }, (_, i) => Math.floor((i + 1) * size / 10)),
  Array.from({ length: 4096 }, (_, i) => i),
];
const write = db.prepare('INSERT INTO sample(id,value) VALUES(?,?)');
const padding = `/*${'x'.repeat(60000)}*/`;
const statement = `DELETE FROM sample ${padding} RETURNING id,value,${names.join(',')}`;
for (const [index, offsets] of cases.entries()) {
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
  // The native planner evaluates the capped scan twice for these inputs;
  // each pass admits at most 250 nodes and checks two children per node.
  assert.ok(visits > 0 && visits <= 1000, `Unbounded sparse tree: ${visits} visits`);
  assert.equal(db.prepare('SELECT n FROM audit').get().n, index + 1);
  console.log(`Sparse zero differential: ${offsets.length} nonzero bytes, ${visits} node checks.`);
}
db.close();
