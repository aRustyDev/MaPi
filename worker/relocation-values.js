// Version 4 requires bounded per-cell slices for large reconciliation rows.
export const RELOCATION_RECONCILIATION_VERSION = 4;
export const RELOCATION_TEXT_GUARD_VERSION = 2;

export function assertRelocationTextGuard(checkpoint) {
  if (checkpoint?.text_guard !== RELOCATION_TEXT_GUARD_VERSION) {
    throw new Error('Legacy relocation transfer requires manual review');
  }
}

export function assertRelocationValuesRepresentable(row) {
  if (!Array.isArray(row)) throw new Error('Invalid relocation row');
  if (row.some(value => typeof value === 'string' && !value.isWellFormed())) {
    throw new Error('Invalid UTF-8 TEXT in relocation row');
  }
  if (row.some(value => typeof value === 'number' && !Number.isFinite(value))) {
    throw new Error('Non-finite REAL is not supported by relocation');
  }
}
