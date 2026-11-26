import { MAX_ROW_VALUE_BYTES } from './relocation-chunks.js';
import { serialTypeBytes, recordValueBytes } from './relocation-record-size.js';

const MAX_ROWS = 64;
const MAX_BYTES = 256 * 1024;
const MAX_QUERIES = 128;
const SLICE_BYTES = 64 * 1024;
// Fragment envelopes include both the previous cursor and the row cursor.
const MAX_CURSOR_BYTES = 4096;
const FRAGMENT_BASE64_BYTES = Math.ceil((80 * 1024) / 3) * 4;
const MAX_CHUNK_BYTES = 128 * 1024;
const MAX_INT64 = 9223372036854775807n;
const MIN_INT64 = -9223372036854775808n;
const quote = name => '"' + name.replaceAll('"', '""') + '"';
export const RELOCATION_TEXT_PREFLIGHT_VERSION = 5;

function validRowid(value) {
  if (typeof value !== 'string' || !/^(0|-?[1-9][0-9]*)$/.test(value)) return false;
  const number = BigInt(value);
  return number >= MIN_INT64 && number <= MAX_INT64;
}

function initial() {
  return { version: RELOCATION_TEXT_PREFLIGHT_VERSION, table: 0, after: null, row: null, column: 0, rowBytes: 0, recordBytes: 0, recordHeader: 0, cursorBytes: 2, length: null, offset: 0, remaining: 0, minimum: 128, maximum: 191, done: false };
}

function validCheckpoint(value, tables) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).sort().join(',') !== 'after,column,cursorBytes,done,length,maximum,minimum,offset,recordBytes,recordHeader,remaining,row,rowBytes,table,version' ||
      value.version !== RELOCATION_TEXT_PREFLIGHT_VERSION || !Number.isSafeInteger(value.table) || value.table < 0 || value.table > tables.length ||
      !(value.after === null || validRowid(value.after)) || !(value.row === null || validRowid(value.row)) ||
      !Number.isSafeInteger(value.column) || value.column < 0 || value.column > 100 ||
      !Number.isSafeInteger(value.rowBytes) || value.rowBytes < 0 || value.rowBytes > MAX_ROW_VALUE_BYTES ||
      !Number.isSafeInteger(value.recordBytes) || value.recordBytes < 0 || value.recordBytes > 8_388_608 ||
      !Number.isSafeInteger(value.recordHeader) || value.recordHeader < 0 || value.recordHeader > 400 ||
      !Number.isSafeInteger(value.cursorBytes) || value.cursorBytes < 2 || value.cursorBytes > MAX_CURSOR_BYTES ||
      !(value.length === null || Number.isSafeInteger(value.length) && value.length >= 0 && value.length <= 8_388_608) ||
      !Number.isSafeInteger(value.offset) || value.offset < 0 ||
      !Number.isInteger(value.remaining) || value.remaining < 0 || value.remaining > 3 ||
      !Number.isInteger(value.minimum) || value.minimum < 128 || value.minimum > 191 ||
      !Number.isInteger(value.maximum) || value.maximum < value.minimum || value.maximum > 191 ||
      typeof value.done !== 'boolean' || value.done !== (value.table === tables.length)) return false;
  if (value.row === null && (value.column !== 0 || value.rowBytes !== 0 || value.recordBytes !== 0 || value.recordHeader !== 0 || value.cursorBytes !== 2 || value.length !== null || value.offset !== 0 || value.remaining !== 0)) return false;
  if (value.length === null && (value.offset !== 0 || value.remaining !== 0)) return false;
  if (value.length !== null && (value.row === null || value.offset > value.length || value.offset === 0 && value.remaining !== 0)) return false;
  if (value.row !== null && value.after !== null && BigInt(value.row) <= BigInt(value.after)) return false;
  const utf8Range = `${value.remaining}:${value.minimum}:${value.maximum}`;
  if (!['0:128:191', '1:128:191', '2:128:191', '2:160:191', '2:128:159',
    '3:128:191', '3:144:191', '3:128:143'].includes(utf8Range)) return false;
  if (value.done && (value.row !== null || value.after !== null)) return false;
  return true;
}

function tableDetails(query, name, identity) {
  const table = quote(name);
  const list = query(`PRAGMA table_list(${table})`).toArray().filter(row => row.schema === 'main' && row.name === name);
  const info = query(`PRAGMA table_xinfo(${table})`).toArray();
  if (list.length !== 1 || list[0].type !== 'table' || list[0].wr !== 0 || !info.length || info.length > 100 ||
      info.some(column => typeof column.name !== 'string' || !column.name)) throw Error('Unsupported TEXT preflight table');
  const names = new Set(info.map(column => column.name.toLowerCase()));
  const rowid = ['rowid', '_rowid_', 'oid'].find(name => !names.has(name));
  if (!rowid) throw Error('Unsupported TEXT preflight rowid');
  const columns = info.filter(column => column.hidden === 0 || column.hidden === 3);
  const primary = info.filter(column => column.pk > 0);
  const alias = primary.length === 1 && String(primary[0].type).toUpperCase() === 'INTEGER' && !query(`PRAGMA index_list(${table})`).toArray().some(index => index.origin === 'pk') ? primary[0].name : null;
  // These singleton values are represented in the manifest, not transferred
  // as rows, so they legitimately have no primary key.
  if (!columns.some(column => column.pk > 0) && !['mapi_project_origin', 'mapi_recovery_epoch'].includes(name)) throw Error('Export primary key changed');
  const header = {
    projectId: identity.projectId, generation: Number.MAX_SAFE_INTEGER, moveId: identity.moveId,
    index: Number.MAX_SAFE_INTEGER, prev: 'f'.repeat(64), table: name,
    columns: columns.filter(column => column.hidden === 0).map(column => column.name), offset: Number.MAX_SAFE_INTEGER,
    rows: [], last: false, done: false, cursor: null,
    fragment: { offset: Number.MAX_SAFE_INTEGER, total: Number.MAX_SAFE_INTEGER, data: 'A'.repeat(FRAGMENT_BASE64_BYTES), cursor: null },
  };
  const headerBytes = new TextEncoder().encode(JSON.stringify(header)).length;
  if (headerBytes - 8 + 2 * MAX_CURSOR_BYTES > MAX_CHUNK_BYTES) throw Error('Relocation fragment metadata exceeds limit');
  return { table, rowid, columns: columns.map(column => ({ name: quote(column.name), key: column.pk > 0, rowidAlias: column.name === alias, writable: column.hidden === 0 })) };
}

function consumeUtf8(checkpoint, bytes, key) {
  for (const byte of bytes) {
    if (checkpoint.remaining) {
      if (byte < checkpoint.minimum || byte > checkpoint.maximum) throw Error('Invalid UTF-8 TEXT in relocation row');
      checkpoint.remaining--;
      checkpoint.minimum = 128;
      checkpoint.maximum = 191;
    } else if (byte <= 127) {
      // ASCII bytes need no UTF-8 continuation state.
    } else if (byte >= 194 && byte <= 223) {
      checkpoint.remaining = 1;
    } else if (byte >= 224 && byte <= 239) {
      checkpoint.remaining = 2;
      if (byte === 224) checkpoint.minimum = 160;
      if (byte === 237) checkpoint.maximum = 159;
    } else if (byte >= 240 && byte <= 244) {
      checkpoint.remaining = 3;
      if (byte === 240) checkpoint.minimum = 144;
      if (byte === 244) checkpoint.maximum = 143;
    } else {
      throw Error('Invalid UTF-8 TEXT in relocation row');
    }
    if (key) {
      // JSON.stringify emits UTF-8 unchanged except for ASCII control bytes,
      // quotes and backslashes. Count these bytes while validating each slice
      // so an incomplete multibyte character can resume without re-reading.
      checkpoint.cursorBytes += byte < 0x20
        ? ([8, 9, 10, 12, 13].includes(byte) ? 2 : 6)
        : (byte === 0x22 || byte === 0x5c ? 2 : 1);
      if (checkpoint.cursorBytes > MAX_CURSOR_BYTES) throw Error('Relocation primary key exceeds cursor limit');
    }
  }
}

// Run within the caller's source transaction after validating the trusted
// registry checkpoint, source identity, and durable mutation marker. The
// caller persists the returned checkpoint separately from source storage.
export function advanceRelocationTextPreflight(storage, tables, checkpoint = null, identity) {
  if (!Array.isArray(tables) || !tables.length || tables.some(name => typeof name !== 'string' || !name) || new Set(tables).size !== tables.length) {
    throw Error('Invalid TEXT preflight tables');
  }
  if (!identity || typeof identity.projectId !== 'string' || !identity.projectId || identity.projectId.length > 4096 || typeof identity.moveId !== 'string' || !identity.moveId || identity.moveId.length > 4096) throw Error('Invalid TEXT preflight identity');
  checkpoint = checkpoint === null ? initial() : { ...checkpoint };
  if (!validCheckpoint(checkpoint, tables)) throw Error('Invalid TEXT preflight checkpoint');
  let queries = 0, rows = 0, bytes = 0;
  const query = (...args) => {
    if (queries >= MAX_QUERIES) throw Error('TEXT preflight query budget exhausted');
    queries++;
    return storage.sql.exec(...args);
  };
  if (checkpoint.row !== null) rows = 1;
  const cache = new Map();
  while (!checkpoint.done && queries < MAX_QUERIES && bytes < MAX_BYTES) {
    const name = tables[checkpoint.table];
    if (!cache.has(name)) {
      if (queries + 3 > MAX_QUERIES) break;
      cache.set(name, tableDetails(query, name, identity));
    }
    const { table, rowid, columns } = cache.get(name);
    if (!columns.length) throw Error('Unsupported TEXT preflight columns');
    if (checkpoint.row === null) {
      if (rows >= MAX_ROWS) break;
      const where = checkpoint.after === null ? '' : `WHERE ${rowid} > CAST(? AS INTEGER)`;
      const args = checkpoint.after === null ? [] : [checkpoint.after];
      const result = query(`SELECT printf('%lld', ${rowid}) AS row_id FROM ${table} ${where} ORDER BY ${rowid} LIMIT 1`, ...args).toArray();
      if (!result.length) {
        checkpoint.table++;
        checkpoint.after = null;
        checkpoint.done = checkpoint.table === tables.length;
        continue;
      }
      if (!validRowid(result[0].row_id)) throw Error('Invalid TEXT preflight rowid');
      checkpoint.row = result[0].row_id;
      rows++;
    }
    if (checkpoint.column >= columns.length) {
      if (checkpoint.column !== columns.length || checkpoint.length !== null) throw Error('Invalid TEXT preflight checkpoint');
      checkpoint.after = checkpoint.row;
      checkpoint.row = null;
      checkpoint.column = 0;
      checkpoint.rowBytes = 0;
      checkpoint.recordBytes = 0;
      checkpoint.recordHeader = 0;
      checkpoint.cursorBytes = 2;
      continue;
    }
    const column = columns[checkpoint.column].name;
    const key = columns[checkpoint.column].key;
    const rowidAlias = columns[checkpoint.column].rowidAlias;
    if (checkpoint.length === null) {
      if (queries >= MAX_QUERIES) break;
      const keyValues = key
        ? `CASE WHEN typeof(${column}) = 'integer' THEN printf('%lld', ${column}) END AS integer_value, CASE WHEN typeof(${column}) = 'real' AND ${column} <= 1.7976931348623157e308 AND ${column} >= -1.7976931348623157e308 THEN ${column} END AS real_value`
        : `CASE WHEN typeof(${column}) = 'integer' THEN printf('%lld', ${column}) END AS integer_value, NULL AS real_value`;
      const result = query(`SELECT typeof(${column}) AS kind, CASE WHEN typeof(${column}) IN ('text', 'blob') THEN length(CAST(${column} AS BLOB)) END AS size, CASE WHEN typeof(${column}) = 'real' AND (${column} > 1.7976931348623157e308 OR ${column} < -1.7976931348623157e308) THEN 1 ELSE 0 END AS nonfinite, ${keyValues} FROM ${table} WHERE ${rowid} = CAST(? AS INTEGER)`, checkpoint.row).toArray();
      if (result.length !== 1) throw Error('TEXT preflight source changed');
      if (result[0].nonfinite) throw Error('Non-finite REAL is not supported by relocation');
      // Match encodeFragmentRow's aggregate accounting. With at most 100
      // columns, base64 expansion and per-value JSON wrappers stay below the
      // exporter's 12 MiB fragment-envelope limit at this value-byte cap.
      const size = ['text', 'blob'].includes(result[0].kind) ? result[0].size : result[0].kind === 'null' ? 0 : 8;
      if (!Number.isSafeInteger(size) || size < 0 || size > 8_388_608) throw Error('TEXT preflight value exceeds SQLite limit');
      if (columns[checkpoint.column].writable) checkpoint.rowBytes += size;
      checkpoint.recordHeader += serialTypeBytes(result[0].kind, size);
      checkpoint.recordBytes += recordValueBytes(result[0].kind, size, result[0].integer_value, rowidAlias);
      if (checkpoint.recordBytes + checkpoint.recordHeader + (checkpoint.recordHeader + 1 < 128 ? 1 : 2) > 8_388_608) throw Error('Row exceeds SQLite record size limit');
      if (checkpoint.rowBytes > MAX_ROW_VALUE_BYTES) throw Error('Row exceeds conservative SQLite size limit');
      if (key) {
        if (result[0].kind === 'null') throw Error('Export primary key contains NULL');
        // The bridge wraps integers and blobs in tagged objects. Their JSON
        // sizes are exact without reading the full blob into JavaScript.
        const keySize = result[0].kind === 'text' ? 2
          : result[0].kind === 'blob' ? 11 + 4 * Math.ceil(size / 3)
          : result[0].kind === 'integer' ? JSON.stringify({ integer: result[0].integer_value }).length
          : JSON.stringify(result[0].real_value).length;
        const comma = columns.slice(0, checkpoint.column).some(item => item.key) ? 1 : 0;
        checkpoint.cursorBytes += keySize + comma;
        if (checkpoint.cursorBytes > MAX_CURSOR_BYTES) throw Error('Relocation primary key exceeds cursor limit');
      }
      if (result[0].kind !== 'text') {
        checkpoint.column++;
        continue;
      }
      checkpoint.length = size;
    }
    if (checkpoint.offset < checkpoint.length) {
      if (queries >= MAX_QUERIES || bytes >= MAX_BYTES) break;
      const amount = Math.min(SLICE_BYTES, MAX_BYTES - bytes, checkpoint.length - checkpoint.offset);
      const result = query(`SELECT substr(CAST(${column} AS BLOB), ?, ?) AS data FROM ${table} WHERE ${rowid} = CAST(? AS INTEGER)`, checkpoint.offset + 1, amount, checkpoint.row).toArray();
      if (result.length !== 1 || !(result[0].data instanceof ArrayBuffer) || result[0].data.byteLength !== amount) throw Error('TEXT preflight source changed');
      consumeUtf8(checkpoint, new Uint8Array(result[0].data), key);
      checkpoint.offset += amount;
      bytes += amount;
    }
    if (checkpoint.offset === checkpoint.length) {
      if (checkpoint.remaining !== 0) throw Error('Invalid UTF-8 TEXT in relocation row');
      checkpoint.length = null;
      checkpoint.offset = 0;
      checkpoint.column++;
    }
  }
  if (!validCheckpoint(checkpoint, tables)) throw Error('Invalid TEXT preflight checkpoint');
  return { checkpoint, done: checkpoint.done, rows, bytes, queries };
}
