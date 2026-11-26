import { readRelocationRow } from './sql.js';
import { MAX_ROW_VALUE_BYTES } from './relocation-chunks.js';

// SQLite itself may materialize a cell for CAST/substr. The bridge receives at
// most one slice at a time, and the checkpoint is kept by the caller.
export const STREAM_SLICE_BYTES = 64 * 1024;
export const STREAM_SMALL_ROW_BYTES = 64 * 1024;
export const STREAM_OFFSET_BASE = 8_388_609;
const quote = value => '"' + value.replaceAll('"', '""') + '"';
const byteLength = value => new TextEncoder().encode(value).length;

export function relocationTableInfo(storage, table) {
 const rows = storage.sql.exec("SELECT CASE WHEN typeof(name) = 'text' AND length(CAST(name AS BLOB)) <= 1024 THEN CAST(name AS BLOB) END, pk, hidden FROM pragma_table_xinfo(?) LIMIT 101", table).raw().toArray();
 if (!rows.length || rows.length > 100) throw Error('Unsupported relocation stream table');
 let total = 0;
 return rows.map(([raw, pk, hidden]) => {
  if (!(raw instanceof ArrayBuffer) || !Number.isInteger(pk) || pk < 0 || !Number.isInteger(hidden) || hidden < 0) throw Error('Unsupported relocation stream table');
  total += raw.byteLength;
  if (total > 32768) throw Error('Unsupported relocation stream table');
  let name;
  try { name = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(raw); } catch { throw Error('Unsupported relocation stream table'); }
  if (!name) throw Error('Unsupported relocation stream table');
  return { name, pk, hidden };
 });
}

export function relocationTableDefinition(storage, table) {
 const row = storage.sql.exec("SELECT CASE WHEN typeof(sql) = 'text' AND length(CAST(sql AS BLOB)) <= 16384 THEN CAST(sql AS BLOB) END AS ddl FROM sqlite_schema WHERE type = 'table' AND name = ? LIMIT 1", table).toArray()[0];
 if (!(row?.ddl instanceof ArrayBuffer)) throw Error('Unsupported relocation stream schema');
 try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(row.ddl); } catch { throw Error('Unsupported relocation stream schema'); }
}

function cursorArgs(cursor) {
 const expressions = [], values = [];
 for (const value of cursor ?? []) {
  if (value && typeof value === 'object' && typeof value.integer === 'string') {
   expressions.push('CAST(? AS INTEGER)'); values.push(value.integer);
  } else if (value && typeof value === 'object' && typeof value.blob === 'string') {
   expressions.push('?'); values.push(Uint8Array.fromBase64(value.blob).buffer);
  } else { expressions.push('?'); values.push(value); }
 }
 return { expressions, values };
}

// This does not materialize non-key TEXT/BLOB values in JavaScript.
export function inspectStreamRow(storage, table, names, keys, cursor, explicitCollation) {
 const info = relocationTableInfo(storage, table);
 const used = new Set(info.map(column => column.name.toLowerCase()));
 const rowid = ['rowid', '_rowid_', 'oid'].find(name => !used.has(name));
 if (!rowid || names.length > 100) throw Error('Unsupported relocation stream table');
 const order = keys.map(key => quote(key) + (explicitCollation ? ' COLLATE BINARY' : '')).join(', ');
 const args = cursorArgs(cursor);
 const where = cursor ? ` WHERE (${order}) > (${args.expressions.join(', ')})` : '';
 const found = storage.sql.exec(`SELECT printf('%lld', ${rowid}) FROM ${quote(table)}${where} ORDER BY ${order} LIMIT 1`, ...args.values).raw().toArray()[0];
 if (!found) return null;
 // Workerd limits result columns. Read metadata in batches while the source
 // transaction and its frozen fence keep the selected row stable.
 const metadata = [];
 for (let start = 0; start < names.length; start += 20) {
  const projection = names.slice(start, start + 20).flatMap(name => {
   const c = quote(name);
   return [`typeof(${c})`, `CASE WHEN typeof(${c}) IN ('text','blob') THEN length(CAST(${c} AS BLOB)) END`, `CASE WHEN typeof(${c}) = 'integer' THEN printf('%lld', ${c}) END`, `CASE WHEN typeof(${c}) = 'real' THEN ${c} END`];
  });
  const values = storage.sql.exec(`SELECT ${projection.join(', ')} FROM ${quote(table)} WHERE ${rowid} = CAST(? AS INTEGER)`, found[0]).raw().toArray();
  if (values.length !== 1) throw Error('Relocation stream source changed');
  metadata.push(...values[0]);
 }
 const types = [], lengths = [];
 let size = 0;
 for (let i = 0; i < names.length; i++) {
  const [kind, length, integer, real] = metadata.slice(i * 4, (i + 1) * 4);
  if (kind === 'text' || kind === 'blob') {
   if (!Number.isSafeInteger(length) || length < 0 || length > 8_388_608) throw Error('Row exceeds conservative SQLite size limit');
   types.push({ kind, length }); lengths.push(length); size += length;
  } else if (kind === 'integer') { types.push({ kind, value: integer }); lengths.push(8); size += 8; }
  else if (kind === 'real' && Number.isFinite(real)) { types.push({ kind, value: real }); lengths.push(8); size += 8; }
  else if (kind === 'null') { types.push({ kind }); lengths.push(0); }
  else throw Error('Non-finite REAL is not supported by relocation');
 }
 if (size > MAX_ROW_VALUE_BYTES) throw Error('Row exceeds conservative SQLite size limit');
 // The serialized key is separately bounded by preflight. Check the raw
 // lengths before invoking the normal bridge so no unbounded key is returned.
 if (keys.reduce((sum, key) => sum + lengths[names.indexOf(key)], 0) > 4096) throw Error('Relocation primary key exceeds cursor limit');
 const nextCursor = readRelocationRow(storage, keys, `FROM ${quote(table)} WHERE ${rowid} = CAST(? AS INTEGER)`, [{ kind: 'value', value: found[0] }]);
 if (!nextCursor || nextCursor.some(value => value === null) || byteLength(JSON.stringify(nextCursor)) > 4096) throw Error('Relocation primary key exceeds cursor limit');
 return { table, names, rowid, row: found[0], types, size, cursor: nextCursor };
}

export function encodeStreamOffset(column, offset) {
 if (!Number.isSafeInteger(column) || column < 0 || column >= 100 || !Number.isSafeInteger(offset) || offset < 0 || offset >= STREAM_OFFSET_BASE) throw Error('Invalid stream offset');
 return (column + 1) * STREAM_OFFSET_BASE + offset;
}

export function makeStreamFragment(storage, info, checkpoint) {
 let column, offset;
 if (checkpoint === 0) { column = info.types.findIndex(value => value.kind === 'text' || value.kind === 'blob'); offset = 0; }
 else {
  if (!Number.isSafeInteger(checkpoint) || checkpoint < STREAM_OFFSET_BASE) throw Error('Legacy relocation transfer requires manual review');
  column = Math.floor(checkpoint / STREAM_OFFSET_BASE) - 1;
  offset = checkpoint % STREAM_OFFSET_BASE;
 }
 const descriptor = info.types[column];
 if (!descriptor || !['text', 'blob'].includes(descriptor.kind) || offset > descriptor.length || offset % STREAM_SLICE_BYTES !== 0 || offset === descriptor.length && offset !== 0) throw Error('Invalid stream checkpoint');
 const amount = Math.min(STREAM_SLICE_BYTES, descriptor.length - offset);
 const qcol = quote(info.names[column]);
 const prefix = descriptor.kind === 'text' ? Math.min(3, offset) : 0;
 const data = storage.sql.exec(`SELECT substr(CAST(${qcol} AS BLOB), ?, ?) AS data FROM ${quote(info.table)} WHERE ${info.rowid} = CAST(? AS INTEGER)`, offset + 1 - prefix, amount + prefix, info.row).toArray()[0]?.data;
 if (!(data instanceof ArrayBuffer) || data.byteLength !== amount + prefix) throw Error('Relocation stream source changed');
 const all = new Uint8Array(data), part = all.subarray(prefix);
 if (descriptor.kind === 'text') {
  let start = 0;
  while (start < prefix && (all[start] & 0xc0) === 0x80) start++;
  try { const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }); decoder.decode(all.subarray(start), { stream: true }); if (offset + amount === descriptor.length) decoder.decode(); }
  catch { throw Error('Invalid UTF-8 TEXT in relocation row'); }
 }
 const end = offset + amount;
 let nextColumn = column, nextOffset = end;
 if (end === descriptor.length) { nextColumn = info.types.findIndex((value, index) => index > column && ['text', 'blob'].includes(value.kind)); nextOffset = 0; }
 const rowDone = nextColumn === -1;
 return { v: 2, column, offset, total: descriptor.length, kind: descriptor.kind, data: part.toBase64(), cursor: info.cursor, rowDone, nextColumn: rowDone ? null : nextColumn, nextOffset: rowDone ? null : nextOffset, ...(checkpoint === 0 ? { types: info.types } : {}) };
}
