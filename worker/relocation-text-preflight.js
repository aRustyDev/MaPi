const MAX_ROWS = 64;
const MAX_BYTES = 256 * 1024;
const MAX_QUERIES = 128;
const SLICE_BYTES = 64 * 1024;
const MAX_INT64 = 9223372036854775807n;
const MIN_INT64 = -9223372036854775808n;
const quote = name => '"' + name.replaceAll('"', '""') + '"';

function validRowid(value) {
  if (typeof value !== 'string' || !/^(0|-?[1-9][0-9]*)$/.test(value)) return false;
  const number = BigInt(value);
  return number >= MIN_INT64 && number <= MAX_INT64;
}

function initial() {
  return { version: 1, table: 0, after: null, row: null, column: 0, length: null, offset: 0, remaining: 0, minimum: 128, maximum: 191, done: false };
}

function validCheckpoint(value, tables) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).sort().join(',') !== 'after,column,done,length,maximum,minimum,offset,remaining,row,table,version' ||
      value.version !== 1 || !Number.isSafeInteger(value.table) || value.table < 0 || value.table > tables.length ||
      !(value.after === null || validRowid(value.after)) || !(value.row === null || validRowid(value.row)) ||
      !Number.isSafeInteger(value.column) || value.column < 0 || value.column > 100 ||
      !(value.length === null || Number.isSafeInteger(value.length) && value.length >= 0 && value.length <= 8_388_608) ||
      !Number.isSafeInteger(value.offset) || value.offset < 0 ||
      !Number.isInteger(value.remaining) || value.remaining < 0 || value.remaining > 3 ||
      !Number.isInteger(value.minimum) || value.minimum < 128 || value.minimum > 191 ||
      !Number.isInteger(value.maximum) || value.maximum < value.minimum || value.maximum > 191 ||
      typeof value.done !== 'boolean' || value.done !== (value.table === tables.length)) return false;
  if (value.row === null && (value.column !== 0 || value.length !== null || value.offset !== 0 || value.remaining !== 0)) return false;
  if (value.length === null && (value.offset !== 0 || value.remaining !== 0)) return false;
  if (value.length !== null && (value.row === null || value.offset > value.length || value.offset === 0 && value.remaining !== 0)) return false;
  if (value.row !== null && value.after !== null && BigInt(value.row) <= BigInt(value.after)) return false;
  const utf8Range = `${value.remaining}:${value.minimum}:${value.maximum}`;
  if (!['0:128:191', '1:128:191', '2:128:191', '2:160:191', '2:128:159',
    '3:128:191', '3:144:191', '3:128:143'].includes(utf8Range)) return false;
  if (value.done && (value.row !== null || value.after !== null)) return false;
  return true;
}

function tableDetails(query, name) {
  const table = quote(name);
  const list = query(`PRAGMA table_list(${table})`).toArray().filter(row => row.schema === 'main' && row.name === name);
  const info = query(`PRAGMA table_xinfo(${table})`).toArray();
  if (list.length !== 1 || list[0].type !== 'table' || list[0].wr !== 0 || !info.length || info.length > 100 ||
      info.some(column => typeof column.name !== 'string' || !column.name)) throw Error('Unsupported TEXT preflight table');
  const names = new Set(info.map(column => column.name.toLowerCase()));
  const rowid = ['rowid', '_rowid_', 'oid'].find(name => !names.has(name));
  if (!rowid) throw Error('Unsupported TEXT preflight rowid');
  return { table, rowid, columns: info.filter(column => column.hidden === 0).map(column => quote(column.name)) };
}

function consumeUtf8(checkpoint, bytes) {
  for (const byte of bytes) {
    if (checkpoint.remaining) {
      if (byte < checkpoint.minimum || byte > checkpoint.maximum) throw Error('Invalid UTF-8 TEXT in relocation row');
      checkpoint.remaining--;
      checkpoint.minimum = 128;
      checkpoint.maximum = 191;
    } else if (byte <= 127) {
      continue;
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
  }
}

// Run within the caller's source transaction after validating the trusted
// registry checkpoint, source identity, and durable mutation marker. The
// caller persists the returned checkpoint separately from source storage.
export function advanceRelocationTextPreflight(storage, tables, checkpoint = null) {
  if (!Array.isArray(tables) || !tables.length || tables.some(name => typeof name !== 'string' || !name) || new Set(tables).size !== tables.length) {
    throw Error('Invalid TEXT preflight tables');
  }
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
      if (queries + 2 >= MAX_QUERIES) break;
      cache.set(name, tableDetails(query, name));
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
      continue;
    }
    const column = columns[checkpoint.column];
    if (checkpoint.length === null) {
      if (queries >= MAX_QUERIES) break;
      const result = query(`SELECT typeof(${column}) AS kind, CASE WHEN typeof(${column}) = 'text' THEN length(CAST(${column} AS BLOB)) END AS size FROM ${table} WHERE ${rowid} = CAST(? AS INTEGER)`, checkpoint.row).toArray();
      if (result.length !== 1) throw Error('TEXT preflight source changed');
      if (result[0].kind !== 'text') {
        checkpoint.column++;
        continue;
      }
      if (!Number.isSafeInteger(result[0].size) || result[0].size < 0 || result[0].size > 8_388_608) throw Error('TEXT preflight value exceeds SQLite limit');
      checkpoint.length = result[0].size;
    }
    if (checkpoint.offset < checkpoint.length) {
      if (queries >= MAX_QUERIES || bytes >= MAX_BYTES) break;
      const amount = Math.min(SLICE_BYTES, MAX_BYTES - bytes, checkpoint.length - checkpoint.offset);
      const result = query(`SELECT substr(CAST(${column} AS BLOB), ?, ?) AS data FROM ${table} WHERE ${rowid} = CAST(? AS INTEGER)`, checkpoint.offset + 1, amount, checkpoint.row).toArray();
      if (result.length !== 1 || !(result[0].data instanceof ArrayBuffer) || result[0].data.byteLength !== amount) throw Error('TEXT preflight source changed');
      consumeUtf8(checkpoint, new Uint8Array(result[0].data));
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
