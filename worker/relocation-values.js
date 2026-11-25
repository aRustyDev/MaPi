// Relocation chunks carry these REAL values as typed JSON objects, because
// JSON numbers cannot preserve their SQLite values.
export const RELOCATION_CHUNK_VERSION = 2;
export const RELOCATION_RECONCILIATION_VERSION = 3;

export function encodeRelocationRow(row) {
  return row.map(value => {
    if (value === Infinity) return { real: 'inf' };
    if (value === -Infinity) return { real: '-inf' };
    if (Object.is(value, -0)) return { real: '-0' };
    if (Number.isNaN(value)) throw new Error('Invalid SQLite REAL in relocation');
    return value;
  });
}

const realValues = { inf: Infinity, '-inf': -Infinity, '-0': -0 };

export function isRelocationRealTag(value) {
  return typeof value === 'string' && Object.hasOwn(realValues, value);
}

export function relocationSQLArgument(value) {
  if (value && typeof value === 'object') {
    if (Object.hasOwn(value, 'real')) {
      if (Object.keys(value).length !== 1 || !isRelocationRealTag(value.real)) throw new Error('Invalid relocation REAL tag');
      return { kind: 'value', value: realValues[value.real] };
    }
    if ('integer' in value) return { kind: 'int', value: value.integer };
    if ('blob' in value) return { kind: 'blob', value: value.blob };
  }
  if (typeof value === 'number' && (!Number.isFinite(value) || Object.is(value, -0))) {
    throw new Error('Non-finite REAL or signed zero requires a relocation tag');
  }
  return { kind: 'value', value };
}
