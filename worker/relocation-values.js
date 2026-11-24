// JSON cannot represent SQLite REAL infinities without changing their value.
// Until the relocation format supports them losslessly, fail before recording
// a chunk or calculating a reconciliation digest.
export const RELOCATION_RECONCILIATION_VERSION = 2;

export function assertRelocationValuesRepresentable(row) {
  if (!Array.isArray(row)) throw new Error('Invalid relocation row');
  if (row.some(value => typeof value === 'number' && !Number.isFinite(value))) {
    throw new Error('Non-finite REAL is not supported by relocation');
  }
}
