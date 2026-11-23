// Unmounted diagnostic for a future external event-handle sort. The caller
// must hold a synchronous snapshot transaction and authorize its exact
// project, fence, recovery era and reader lease independently. It compares
// ID bytes only; it does not choose rows, compare timestamps, bind a result
// to a public response, or claim parity for malformed SQLite TEXT.
const CHUNK_BYTES = 32 * 1024;
const min = -(1n << 63n), max = (1n << 63n) - 1n;

function rowid(value) {
  if (typeof value !== 'string' || value.length > 20 || !/^(?:0|[1-9][0-9]*|-[1-9][0-9]*)$/.test(value)) throw Error('Invalid event row identifier');
  const parsed = BigInt(value);
  if (parsed < min || parsed > max) throw Error('Invalid event row identifier');
  return value;
}

function metadata(storage, project, handle) {
  const found = storage.sql.exec(`SELECT typeof(id) AS kind, length(CAST(id AS BLOB)) AS bytes
    FROM mapi_shadow_snapshot
    WHERE source_rowid=CAST(? AS INTEGER) AND typeof(project_id)='text' AND project_id COLLATE BINARY=?
    LIMIT 2`, handle, project).toArray();
  if (found.length !== 1 || !['text', 'blob'].includes(found[0].kind) || !Number.isSafeInteger(found[0].bytes) || found[0].bytes < 0) {
    throw Error('Invalid shadow event ID');
  }
  return found[0].bytes;
}

function fragment(storage, project, handle, offset, length) {
  const found = storage.sql.exec(`SELECT substr(CAST(id AS BLOB), ?, ?) AS part
    FROM mapi_shadow_snapshot
    WHERE source_rowid=CAST(? AS INTEGER) AND typeof(project_id)='text' AND project_id COLLATE BINARY=?
    LIMIT 2`, offset + 1, length, handle, project).toArray();
  if (found.length !== 1) throw Error('Shadow event changed');
  const value=found[0].part;
  let view;
  if (value instanceof ArrayBuffer) view=new Uint8Array(value);
  else if (value instanceof Uint8Array && ArrayBuffer.isView(value)) view=value;
  else throw Error('Invalid shadow ID fragment');
  if (view.byteLength !== length) throw Error('Shadow event changed');
  // Do not retain a host-backed view across the next SQLite call.
  return Uint8Array.from(view);
}

// Go compares strings as lexicographic byte sequences. SQLite TEXT must
// independently be known to arrive through the actual bridge with identical
// bytes; this diagnostic makes no malformed-TEXT or Workerd parity claim.
export function compareShadowEventIds(storage, project, left, right) {
  if (!storage || typeof storage.sql?.exec !== 'function' || typeof project !== 'string' || !project || !project.isWellFormed()) throw Error('Invalid shadow comparison scope');
  left=rowid(left); right=rowid(right);
  const leftLength=metadata(storage,project,left), rightLength=metadata(storage,project,right);
  const common=Math.min(leftLength,rightLength);
  for (let offset=0; offset<common; offset+=CHUNK_BYTES) {
    const size=Math.min(CHUNK_BYTES, common-offset);
    const a=fragment(storage,project,left,offset,size), b=fragment(storage,project,right,offset,size);
    for (let i=0; i<size; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return leftLength === rightLength ? 0 : leftLength < rightLength ? -1 : 1;
}
