// SQLite stores each column's serial type as a varint in the record header.
export function serialTypeBytes(kind, length) {
 let serial = kind === 'text' ? length * 2 + 13 : kind === 'blob' ? length * 2 + 12 : 0;
 let bytes = 1;
 while (serial >= 128) { serial = Math.floor(serial / 128); bytes++; }
 return bytes;
}

// SQLite uses compact integer serial types, and rowid aliases occupy a NULL
// serial type in the record payload. REAL values use up to eight bytes.
export function recordValueBytes(kind, length, integer, rowidAlias = false) {
 if (rowidAlias || kind === 'null') return 0;
 if (kind === 'text' || kind === 'blob') return length;
 if (kind === 'real') return 8;
 if (kind !== 'integer') throw Error('Unsupported SQLite record type');
 const value = BigInt(integer);
 if (value === 0n || value === 1n) return 0;
 for (const width of [1, 2, 3, 4, 6]) {
  const limit = 1n << BigInt(width * 8 - 1);
  if (value >= -limit && value < limit) return width;
 }
 return 8;
}
