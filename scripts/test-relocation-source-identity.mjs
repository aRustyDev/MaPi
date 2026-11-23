// Native SQLite and disposable local workerd checks for singleton identity
// comparison. This exercises no existing project or hosted binding.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { sourceIdentityMatches } from '../worker/relocation-source-identity.js';

function exercise(storage) {
  const sql = storage.sql;
  // Untyped NOCASE columns let the test preserve TEXT, INTEGER and BLOB
  // storage classes while checking that identity comparisons remain binary.
  sql.exec('CREATE TABLE projects (id COLLATE NOCASE)');
  sql.exec('CREATE TABLE mapi_project (project_id COLLATE NOCASE)');
  sql.exec('CREATE TABLE mapi_project_origin (origin COLLATE NOCASE)');
  let maxReturnedRows = 0, maxReturnedBytes = 0;
  const observed = { sql: { exec(statement, ...args) {
    const rows = sql.exec(statement, ...args).toArray();
    maxReturnedRows = Math.max(maxReturnedRows, rows.length);
    maxReturnedBytes = Math.max(maxReturnedBytes, new TextEncoder().encode(JSON.stringify(rows)).length);
    if (rows.some(row => Object.keys(row).length !== 1 || ![0, 1].includes(row.matches))) throw Error('Identity query returned stored values');
    return { toArray: () => rows };
  } } };
  const set = (table, value) => {
    sql.exec(`DELETE FROM ${table}`);
    sql.exec(`INSERT INTO ${table} VALUES (?)`, value);
  };
  const result = [];
  for (const [kind, table] of [['project', 'projects'], ['owner', 'mapi_project'], ['origin', 'mapi_project_origin']]) {
    set(table, 'CaseSensitive');
    result.push(sourceIdentityMatches(observed, kind, 'CaseSensitive'));
    result.push(sourceIdentityMatches(observed, kind, 'casesensitive'));
    set(table, 42);
    result.push(sourceIdentityMatches(observed, kind, '42'));
    set(table, new Uint8Array([0x34, 0x32]));
    result.push(sourceIdentityMatches(observed, kind, '42'));
    set(table, null);
    result.push(sourceIdentityMatches(observed, kind, ''));
    set(table, '\ufffd');
    result.push(sourceIdentityMatches(observed, kind, '\ud800'));
    result.push(sourceIdentityMatches(observed, kind, '\udc00'));
    set(table, '\u{10000}');
    result.push(sourceIdentityMatches(observed, kind, '\u{10000}'));
    set(table, 'a\0b');
    result.push(sourceIdentityMatches(observed, kind, 'a\0b'));
    result.push(sourceIdentityMatches(observed, kind, 'a'));
    sql.exec(`DELETE FROM ${table}`);
    result.push(sourceIdentityMatches(observed, kind, 'CaseSensitive'));
    set(table, 'CaseSensitive');
    sql.exec(`INSERT INTO ${table} VALUES (?)`, 'CaseSensitive');
    result.push(sourceIdentityMatches(observed, kind, 'CaseSensitive'));
    const large = 'x'.repeat(256 * 1024);
    set(table, large);
    result.push(sourceIdentityMatches(observed, kind, 'different'));
    result.push(sourceIdentityMatches(observed, kind, large));
  }
  return { result, maxReturnedRows, maxReturnedBytes };
}

const expected = { result: Array(3).fill([true, false, false, false, false, false, false, true, true, false, false, false, false, true]).flat(), maxReturnedRows: 2, maxReturnedBytes: 29 };
const db = new DatabaseSync(':memory:');
try {
  const storage = { sql: { exec(statement, ...args) {
    if (/^\s*SELECT/i.test(statement)) return { toArray: () => db.prepare(statement).all(...args).map(row => ({ ...row })) };
    db.prepare(statement).run(...args); return { toArray: () => [] };
  } } };
  assert.deepEqual(exercise(storage), expected);
} finally { db.close(); }

const source = `import { DurableObject } from 'cloudflare:workers';
import { sourceIdentityMatches } from './source-identity.js';
const exercise = ${exercise.toString()};
export class Probe extends DurableObject { run() { return exercise(this.ctx.storage); } }
export default { async fetch(request, env) { return Response.json(await env.PROBE.getByName('synthetic').run()); } };`;
const mf = new Miniflare(convertV4MiniflareOptions({
  workers: [{ name: 'local-relocation-identity', compatibilityDate: '2026-11-19',
    modules: [{ type: 'ESModule', path: 'probe.js', contents: source },
      { type: 'ESModule', path: 'source-identity.js', contents: await readFile('worker/relocation-source-identity.js', 'utf8') }],
    durableObjects: { PROBE: { className: 'Probe', useSQLite: true } } }],
  host: '127.0.0.1', port: 0, telemetry: { enabled: false },
}));
try {
  const response = await mf.dispatchFetch('http://127.0.0.1/');
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), expected);
  console.log('Native and local workerd singleton identity checks passed.');
} finally { await mf.dispose(); }
