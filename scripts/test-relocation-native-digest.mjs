import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

const db = new DatabaseSync(':memory:');
db.exec('CREATE TABLE large_fixture (id TEXT PRIMARY KEY, value TEXT, data BLOB, number INTEGER, absent TEXT)');
const bytes = Uint8Array.from({ length: 70000 }, (_, index) => index % 251);
db.prepare('INSERT INTO large_fixture VALUES (?, ?, ?, 9223372036854775807, NULL)').run('key', 'a'.repeat(65535) + 'é😀' + 'z'.repeat(90000), bytes);
db.exec("CREATE TABLE small_fixture (id INTEGER PRIMARY KEY, value TEXT); INSERT INTO small_fixture VALUES (1, 'small')");

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
db.close();

const bundle = await build({ entryPoints: ['scripts/relocation-native-digest-worker.mjs'], bundle: true, format: 'esm', platform: 'neutral', write: false, external: ['cloudflare:workers'] });
const mf = new Miniflare(convertV4MiniflareOptions({ workers: [{ name: 'native-digest', compatibilityDate: '2026-11-19', modules: [{ type: 'ESModule', path: 'worker.js', contents: bundle.outputFiles[0].text }], durableObjects: { PROJECT: { className: 'DigestFixture', useSQLite: true } } }], host: '127.0.0.1', port: 0, telemetry: { enabled: false } }));
try {
  const response = await mf.dispatchFetch('http://127.0.0.1/');
  assert.equal(response.status, 200, await response.clone().text());
  const actual = await response.json();
  for (const [table, expected] of [['large_fixture', expectedLarge], ['small_fixture', expectedSmall]]) {
    const pages = actual[table];
    assert.equal(pages.reduce((sum, page) => sum + page.count, 0), 1, `${table} row count`);
    const digests = pages.filter(page => page.count || !page.done).map(page => page.digest);
    assert.deepEqual(digests, expected, `${table} page digests`);
    assert.equal(fold(digests), fold(expected), `${table} canonical digest`);
    console.log(`${table}: one row, ${digests.length} matching native digest pages, SHA-256 ${fold(digests)}`);
  }
} finally { await mf.dispose(); }
