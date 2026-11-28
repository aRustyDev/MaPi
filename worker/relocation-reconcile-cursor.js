// The registry persists these cursors between requests. Keep both keysets small
// enough to cross the JS/SQLite boundary without materializing an unbounded key.
const MAX_KEY_BYTES = 4096;
const encoder = new TextEncoder();
function validBase64(value) {
  if (value.length % 4 !== 0) return false;
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  const end = value.length - padding;
  let last = 0;
  for (let i = 0; i < end; i++) {
    const c = value.charCodeAt(i);
    const n = c >= 65 && c <= 90 ? c - 65 : c >= 97 && c <= 122 ? c - 71 : c >= 48 && c <= 57 ? c + 4 : c === 43 ? 62 : c === 47 ? 63 : -1;
    if (n < 0) return false;
    last = n;
  }
  return padding === 0 || (padding === 1 ? !(last & 3) : !(last & 15));
}
function validKey(value) {
  if (typeof value === 'string') return value.length <= MAX_KEY_BYTES && value.isWellFormed();
  if (typeof value === 'number') return Number.isFinite(value);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  if (keys.length !== 1) return false;
  if (keys[0] === 'integer') {
    const n = value.integer;
    if (typeof n !== 'string' || n.length > 20 || !/^(?:0|-[1-9][0-9]*|[1-9][0-9]*)(?![\s\S])/.test(n)) return false;
    const v = BigInt(n);
    return v >= -9223372036854775808n && v <= 9223372036854775807n;
  }
  return keys[0] === 'blob' && typeof value.blob === 'string' && value.blob.length <= MAX_KEY_BYTES && validBase64(value.blob);
}
export function validReconciliationKeys(keys) {
  return Array.isArray(keys) && keys.length > 0 && keys.length <= 100 && keys.every(validKey) && encoder.encode(JSON.stringify(keys)).length <= MAX_KEY_BYTES;
}
export function validReconciliationCursor(cursor) {
  if (cursor === null) return true;
  if (Array.isArray(cursor)) return validReconciliationKeys(cursor);
  if (!cursor || typeof cursor !== 'object' || Object.keys(cursor).sort().join(',') !== 'after,column,key,maximum,minimum,offset,remaining,v' || cursor.v !== 1 ||
      !(cursor.after === null || validReconciliationKeys(cursor.after)) || !validReconciliationKeys(cursor.key) ||
      !Number.isInteger(cursor.column) || cursor.column < 0 || cursor.column >= 100 ||
      !Number.isSafeInteger(cursor.offset) || cursor.offset < 0 || cursor.offset > 8388608 ||
      !Number.isInteger(cursor.remaining) || !Number.isInteger(cursor.minimum) || !Number.isInteger(cursor.maximum)) return false;
  if (!['0:128:191','1:128:191','2:128:191','2:160:191','2:128:159','3:128:191','3:144:191','3:128:143'].includes(`${cursor.remaining}:${cursor.minimum}:${cursor.maximum}`)) return false;
  return cursor.offset !== 0 || cursor.remaining === 0;
}
export function consumeReconciliationUtf8(state, bytes) {
  for (let index = 0; index < bytes.length; index++) {
    const byte = bytes[index];
    if (state.remaining) {
      if (byte < state.minimum || byte > state.maximum) throw Error('Invalid UTF-8 TEXT in relocation row');
      state.remaining--; state.minimum = 128; state.maximum = 191;
    } else if (byte <= 127) {
      // ASCII.
    } else if (byte >= 194 && byte <= 223) state.remaining = 1;
    else if (byte >= 224 && byte <= 239) {
      state.remaining = 2;
      if (byte === 224) state.minimum = 160;
      if (byte === 237) state.maximum = 159;
    } else if (byte >= 240 && byte <= 244) {
      state.remaining = 3;
      if (byte === 240) state.minimum = 144;
      if (byte === 244) state.maximum = 143;
    } else throw Error('Invalid UTF-8 TEXT in relocation row');
  }
}
