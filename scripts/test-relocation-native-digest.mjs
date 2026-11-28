import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

const db = new DatabaseSync(':memory:');
db.exec('CREATE TABLE large_fixture (id TEXT PRIMARY KEY, value TEXT, data BLOB, number INTEGER, absent TEXT)');
const bytes = Uint8Array.from({ length: 70000 }, (_, index) => index % 251);
db.prepare('INSERT INTO large_fixture VALUES (?, ?, ?, 9223372036854775807, NULL)').run('key', 'a'.repeat(65535) + 'é😀' + 'z'.repeat(8234459), bytes);
db.exec("CREATE TABLE small_fixture (id INTEGER PRIMARY KEY, value TEXT); INSERT INTO small_fixture VALUES (1, 'small')");

db.exec("CREATE TABLE typed_fixture (number INTEGER NOT NULL, binary_key BLOB NOT NULL, value TEXT NOT NULL, PRIMARY KEY(number, binary_key)); INSERT INTO typed_fixture VALUES (-9223372036854775808, X'0080', 'small'), (9223372036854775807, X'00FF', replace(hex(zeroblob(32769)), '00', 'zz'))");

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fold = digests => createHash('sha256').update(digests.join('')).digest('hex');
const nativeLarge = db.prepare('SELECT id, CAST(value AS BLOB) AS value, data, printf(\'%lld\', number) AS number FROM large_fixture').get();
const largeColumns = ['id', 'value', 'data', 'number', 'absent'];
const values = [Buffer.from(nativeLarge.id), nativeLarge.value, nativeLarge.data, nativeLarge.number, null];
const kinds = ['text', 'text', 'blob', 'integer', 'null'];
const expectedLarge = [];
for (let column = 0; column < values.length; column++) {
  const kind = kinds[column], value = values[column];
  const total = kind === 'text' || kind === 'blob' ? value.length : 8;
  for (let offset = 0; offset < Math.max(total, 1); offset += 65536) {
    const part = kind === 'text' || kind === 'blob' ? Buffer.from(value.subarray(offset, offset + 65536)).toString('base64') : kind === 'integer' ? { integer: value } : null;
    expectedLarge.push(hash({ table: 'large_fixture', columns: largeColumns, key: ['key'], column, kind, total, offset, value: part }));
  }
}
const small = db.prepare('SELECT printf(\'%lld\', id) AS id, value FROM small_fixture').get();
const expectedSmall = [hash({ table: 'small_fixture', columns: ['id', 'value'], rows: [[{ integer: small.id }, small.value]] })];
const expectedWide = [hash({table:'wide_fixture', columns:['id', ...Array.from({length:99}, (_, i) => 'c' + i)], rows:[[{integer:'1'}, ...Array.from({length:99}, (_, i) => i % 4 === 0 ? 'text' : i % 4 === 1 ? {blob:'AP8='} : i % 4 === 2 ? 1.25 : {integer:'9223372036854775807'})]]})];
const typedColumns = ['number', 'binary_key', 'value'];
const typedRows = db.prepare("SELECT printf('%lld', number) AS number, binary_key, CAST(value AS BLOB) AS value FROM typed_fixture ORDER BY number, binary_key").all();
const typedKey = row => [{integer:row.number}, {blob:Buffer.from(row.binary_key).toString('base64')}];
const typedFirst = typedRows[0], typedSecond = typedRows[1];
const expectedTyped = [hash({ table:'typed_fixture', columns:typedColumns, rows:[[...typedKey(typedFirst), Buffer.from(typedFirst.value).toString('utf8')]] })];
const typedKeyValue = typedKey(typedSecond);
for (const [column, kind, value] of [[0, 'integer', typedKeyValue[0]], [1, 'blob', typedSecond.binary_key], [2, 'text', typedSecond.value]]) {
  const total = kind === 'integer' ? 8 : value.length;
  for (let offset = 0; offset < Math.max(total, 1); offset += 65536) {
    const part = kind === 'integer' ? value : Buffer.from(value.subarray(offset, offset + 65536)).toString('base64');
    expectedTyped.push(hash({table:'typed_fixture', columns:typedColumns, key:typedKeyValue, column, kind, total, offset, value:part}));
  }
}
db.close();

const bundle = await build({ entryPoints: ['scripts/relocation-native-digest-worker.mjs'], bundle: true, format: 'esm', platform: 'neutral', write: false, external: ['cloudflare:workers'] });
const mf = new Miniflare(convertV4MiniflareOptions({ workers: [{ name: 'native-digest', compatibilityDate: '2026-11-19', modules: [{ type: 'ESModule', path: 'worker.js', contents: bundle.outputFiles[0].text }], durableObjects: { PROJECT: { className: 'DigestFixture', useSQLite: true } } }], host: '127.0.0.1', port: 0, telemetry: { enabled: false } }));
try {
  const response = await mf.dispatchFetch('http://127.0.0.1/');
  assert.equal(response.status, 200, await response.clone().text());
  const actual = await response.json();
  for (const [table, expected] of [['large_fixture', expectedLarge], ['small_fixture', expectedSmall], ['typed_fixture', expectedTyped], ['empty_fixture', []], ['wide_fixture', expectedWide]]) {
    const pages = actual[table];
    const count = table === 'empty_fixture' ? 0 : table === 'typed_fixture' ? 2 : 1;
    assert.equal(pages.reduce((sum, page) => sum + page.count, 0), count, `${table} row count`);
    if (!count) assert.deepEqual({done: pages[0].done, cursor: pages[0].cursor}, {done:true, cursor:null});
    const digests = pages.filter(page => page.count || !page.done).map(page => page.digest);
    assert.deepEqual(digests, expected, `${table} page digests`);
    assert.equal(fold(digests), fold(expected), `${table} canonical digest`);
    console.log(`${table}: ${count} rows, ${digests.length} matching native digest pages, SHA-256 ${fold(digests)}`);
  }
} finally { await mf.dispose(); }
