import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const quote = name => '"' + name.replaceAll('"', '""') + '"';
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const bindKey = value => value && typeof value === 'object' && 'integer' in value ? BigInt(value.integer)
  : value && typeof value === 'object' && 'blob' in value ? Buffer.from(value.blob, 'base64') : value;
const typed = value => typeof value === 'bigint' ? { integer: String(value) }
  : value instanceof Uint8Array ? { blob: Buffer.from(value).toString('base64') } : value;

async function sqliteFiles(path) {
  const result = [];
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const file = join(path, entry.name);
    if (entry.isDirectory()) result.push(...await sqliteFiles(file));
    else if (entry.name.endsWith('.sqlite')) result.push(file);
  }
  return result;
}

// This is used only for the disposable local fixture. The separate native
// connection reads the frozen source database; it does not modify its state.
export async function verifyNativeRelocationEvidence(directory, projectId, evidence) {
  const candidates = [];
  for (const file of await sqliteFiles(directory)) {
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      if (!db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='mapi_owner_fence'").get()) continue;
      const fence = db.prepare('SELECT project_id, state FROM mapi_owner_fence WHERE singleton = 1').get();
      if (fence?.project_id === projectId && fence.state === 'frozen') candidates.push(file);
    } finally { db.close(); }
  }
  assert.equal(candidates.length, 1, 'Expected one frozen synthetic source database');
  const db = new DatabaseSync(candidates[0], { readOnly: true });
  try {
    const totals = new Map();
    for (const page of evidence) {
      const name = page.table;
      const schema = db.prepare(`PRAGMA table_xinfo(${quote(name)})`).all();
      const columns = schema.filter(item => item.hidden === 0).map(item => item.name);
      const keys = schema.filter(item => item.pk > 0).sort((a, b) => a.pk - b.pk).map(item => item.name);
      assert.ok(keys.length, `${name} has a primary key`);
      const ddl = db.prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = ?").get(name).sql;
      const order = keys.map(key => quote(key) + (/\bCOLLATE\b/i.test(ddl) ? ' COLLATE BINARY' : '')).join(', ');
      const incoming = page.cursor;
      const sliced = incoming !== null && !Array.isArray(incoming);
      const starting = sliced ? incoming.after : incoming;
      const fetchRow = cursor => {
        const where = cursor ? ` WHERE (${order}) > (${keys.map(() => '?').join(', ')})` : '';
        const statement = db.prepare(`SELECT ${columns.map(quote).join(', ')} FROM ${quote(name)}${where} ORDER BY ${order} LIMIT 1`);
        statement.setReadBigInts(true);
        statement.setReturnArrays(true);
        return statement.get(...(cursor ?? []).map(bindKey));
      };
      const nextIsSlice = page.nextCursor !== null && !Array.isArray(page.nextCursor);
      const first = !sliced && !nextIsSlice && page.count === 1 ? fetchRow(starting) : null;
      const singleLarge = first && first.reduce((size, value) => size + (typeof value === 'string' ? Buffer.byteLength(value) : value instanceof Uint8Array ? value.byteLength : 8), 0) > 32768;
      let payload;
      if (sliced || nextIsSlice || singleLarge) {
        const row = first ?? fetchRow(starting);
        assert.ok(row, `${name} sliced row missing`);
        const key = keys.map(key => typed(row[columns.indexOf(key)]));
        const state = sliced ? incoming : { column: 0, offset: 0 };
        const value = row[state.column];
        const kind = value === null ? 'null' : typeof value === 'bigint' ? 'integer' : typeof value === 'number' ? 'real' : typeof value === 'string' ? 'text' : 'blob';
        const bytes = kind === 'text' ? Buffer.from(value, 'utf8') : kind === 'blob' ? Buffer.from(value) : null;
        const total = bytes ? bytes.length : 8;
        const part = bytes ? bytes.subarray(state.offset, state.offset + 65536).toString('base64') : typed(value);
        payload = { table: name, columns, key, column: state.column, kind, total, offset: state.offset, value: part };
      } else {
        let cursor = starting;
        const rows = [];
        for (let index = 0; index < page.count; index++) {
          const row = fetchRow(cursor);
          assert.ok(row, `${name} row missing`);
          rows.push(row.map(typed));
          cursor = keys.map(key => typed(row[columns.indexOf(key)]));
        }
        payload = { table: name, columns, rows };
      }
      assert.equal(hash(payload), page.digest, `${name} native page digest`);
      const prior = totals.get(name) ?? { count: 0, digests: [] };
      prior.count += page.count;
      prior.digests.push(page.digest);
      totals.set(name, prior);
    }
    for (const [table, total] of totals) {
      const count = db.prepare(`SELECT count(*) AS n FROM ${quote(table)}`).get().n;
      assert.equal(total.count, count, `${table} native row count`);
      total.digest = createHash('sha256').update(total.digests.join('')).digest('hex');
      delete total.digests;
    }
    return Object.fromEntries(totals);
  } finally { db.close(); }
}
