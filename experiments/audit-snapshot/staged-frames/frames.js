// Unmounted experiment: a scoped, append-only fragment spool. The caller must
// already have performed actual request authorization and provide a trusted,
// synchronous authority check. This alone is not a consistent event snapshot.
const FRAME_MAX = 64 * 1024;
const ZERO = '0'.repeat(64);
const hex = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const name = value => typeof value === 'string' && /^[0-9a-f]{32}$/.test(value);
const same = (left, right) => left.length === right.length && left.every((byte, i) => byte === right[i]);
const boundedText = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max &&
  value.isWellFormed() && new TextEncoder().encode(value).length <= max;

function scopeValid(scope) {
  // These experimental control bounds must be reconciled with the actual
  // owner's supported identifiers before this helper can be integrated.
  if (!scope || !name(scope.id) || !hex(scope.principal) || !hex(scope.request) || !boundedText(scope.epoch, 128) ||
      !scope.route || !boundedText(scope.route.projectId, 4096) || !boundedText(scope.route.origin, 4096) ||
      !boundedText(scope.route.objectName, 4096) || !Number.isSafeInteger(scope.route.generation) || scope.route.generation < 1) throw new Error('Invalid snapshot scope');
}

export function copyScope(scope) {
  if (!scope || typeof scope !== 'object') throw new Error('Invalid snapshot scope');
  const sourceRoute = scope.route;
  if (!sourceRoute || typeof sourceRoute !== 'object') throw new Error('Invalid snapshot scope');
  const route = Object.freeze({ projectId: sourceRoute.projectId, origin: sourceRoute.origin,
    objectName: sourceRoute.objectName, generation: sourceRoute.generation });
  const copy = Object.freeze({ id: scope.id, principal: scope.principal, request: scope.request, epoch: scope.epoch, route });
  scopeValid(copy);
  return copy;
}

function checkFence(storage, route) {
  const rows = storage.sql.exec(`SELECT CASE WHEN typeof(project_id) = 'text' AND project_id = ?
    AND typeof(origin) = 'text' AND origin = ? AND typeof(object_name) = 'text' AND object_name = ?
    AND typeof(generation) = 'integer' AND generation = ? AND state = 'active' THEN 1 ELSE 0 END AS matches
    FROM mapi_owner_fence WHERE singleton = 1 LIMIT 2`, route.projectId, route.origin, route.objectName, route.generation).toArray();
  if (rows.length !== 1 || rows[0].matches !== 1) throw new Error('Owner is fenced or route is stale');
}

function syncResult(value) {
  if (value !== null && (typeof value === 'object' || typeof value === 'function') && typeof value.then === 'function') {
    throw new Error('Snapshot authority must be synchronous');
  }
  if (value !== true) throw new Error('Snapshot authority denied');
}

function guard(storage, scope, authorize) {
  scopeValid(scope);
  if (typeof authorize !== 'function') throw new Error('Snapshot authority missing');
  checkFence(storage, scope.route);
  const epochs = storage.sql.exec("SELECT CASE WHEN typeof(epoch) = 'text' AND epoch = ? THEN 1 ELSE 0 END AS matches FROM mapi_recovery_epoch LIMIT 2", scope.epoch).toArray();
  if (epochs.length !== 1 || epochs[0].matches !== 1) throw new Error('Snapshot recovery era changed');
  syncResult(authorize(scope));
  // The supplied check is trusted and must be read-only. Recheck nevertheless
  // so an accidental synchronous change to owner/era cannot authorize a write.
  checkFence(storage, scope.route);
  const after = storage.sql.exec("SELECT CASE WHEN typeof(epoch) = 'text' AND epoch = ? THEN 1 ELSE 0 END AS matches FROM mapi_recovery_epoch LIMIT 2", scope.epoch).toArray();
  if (after.length !== 1 || after[0].matches !== 1) throw new Error('Snapshot recovery era changed');
}

function head(storage, scope) {
  const route = scope.route;
  // Mask malformed oversized control values before they cross into JS.
  const rows = storage.sql.exec(`SELECT
      CASE WHEN typeof(state) = 'text' AND length(CAST(state AS BLOB)) <= 8 THEN state END AS state,
      CASE WHEN typeof(frame_count) = 'integer' AND frame_count BETWEEN 0 AND 9007199254740991 THEN frame_count END AS frame_count,
      CASE WHEN typeof(total_bytes) = 'integer' AND total_bytes BETWEEN 0 AND 9007199254740991 THEN total_bytes END AS total_bytes,
      CASE WHEN typeof(digest) = 'text' AND length(CAST(digest AS BLOB)) = 64 THEN digest END AS digest
    FROM mapi_audit_spool_head
    WHERE snapshot_id = ? AND project_id = ? AND origin = ? AND object_name = ? AND generation = ?
      AND recovery_epoch = ? AND principal_digest = ? AND request_digest = ?`,
    scope.id, route.projectId, route.origin, route.objectName, route.generation,
    scope.epoch, scope.principal, scope.request).toArray();
  if (rows.length !== 1) throw new Error('Snapshot scope mismatch');
  const row = rows[0];
  if (!['building', 'sealed'].includes(row.state) || !Number.isSafeInteger(row.frame_count) || row.frame_count < 0 ||
      !Number.isSafeInteger(row.total_bytes) || row.total_bytes < 0 || !hex(row.digest)) throw new Error('Invalid snapshot head');
  if ((row.frame_count === 0 && (row.total_bytes !== 0 || row.digest !== ZERO)) ||
      (row.frame_count > 0 && (row.total_bytes < row.frame_count || Math.ceil(row.total_bytes / FRAME_MAX) > row.frame_count))) {
    throw new Error('Invalid snapshot head');
  }
  return row;
}

function frame(storage, scope, index) {
  const rows = storage.sql.exec(`SELECT
      CASE WHEN typeof(previous_digest) = 'text' AND length(CAST(previous_digest AS BLOB)) = 64 THEN previous_digest END AS previous_digest,
      CASE WHEN typeof(digest) = 'text' AND length(CAST(digest AS BLOB)) = 64 THEN digest END AS digest,
      CASE WHEN typeof(data) = 'blob' AND length(data) BETWEEN 1 AND ${FRAME_MAX} THEN data END AS data
    FROM mapi_audit_spool_frame WHERE snapshot_id = ? AND frame_index = ?`, scope.id, index).toArray();
  if (rows.length !== 1 || !hex(rows[0].previous_digest) || !hex(rows[0].digest)) throw new Error('Snapshot frame missing or invalid');
  const data = rows[0].data instanceof ArrayBuffer ? new Uint8Array(rows[0].data) : rows[0].data;
  if (!(data instanceof Uint8Array) || data.length < 1 || data.length > FRAME_MAX) throw new Error('Invalid snapshot frame');
  return { previous: rows[0].previous_digest, digest: rows[0].digest, data: new Uint8Array(data) };
}

async function frameHash(scope, index, previous, data) {
  // Fixed-width identifiers and a bounded frame make this encoding unambiguous.
  const prefix = new TextEncoder().encode(`mapi-audit-frame-v1:${scope.id}:${index}:${previous}:`);
  const input = new Uint8Array(prefix.length + data.length);
  input.set(prefix); input.set(data, prefix.length);
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', input))].map(b => b.toString(16).padStart(2, '0')).join('');
}

// Called once by a test fixture or future explicit schema migration. No
// CREATE IF NOT EXISTS: colliding names must not silently adopt unknown schema.
export function createSpoolSchema(storage) {
  storage.transactionSync(() => {
    storage.sql.exec(`CREATE TABLE mapi_audit_spool_head (
      snapshot_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, origin TEXT NOT NULL, object_name TEXT NOT NULL,
      generation INTEGER NOT NULL, recovery_epoch TEXT NOT NULL, principal_digest TEXT NOT NULL, request_digest TEXT NOT NULL,
      state TEXT NOT NULL, frame_count INTEGER NOT NULL, total_bytes INTEGER NOT NULL, digest TEXT NOT NULL
    )`);
    storage.sql.exec(`CREATE TABLE mapi_audit_spool_frame (
      snapshot_id TEXT NOT NULL, frame_index INTEGER NOT NULL, previous_digest TEXT NOT NULL, digest TEXT NOT NULL,
      data BLOB NOT NULL, PRIMARY KEY (snapshot_id, frame_index),
      FOREIGN KEY (snapshot_id) REFERENCES mapi_audit_spool_head(snapshot_id)
    )`);
  });
}

export function beginSpool(storage, scope, authorize) {
  scope = copyScope(scope);
  return storage.transactionSync(() => {
    guard(storage, scope, authorize);
    const r = scope.route;
    const existing = storage.sql.exec('SELECT 1 FROM mapi_audit_spool_head WHERE snapshot_id = ?', scope.id).toArray();
    if (existing.length) { head(storage, scope); return; }
    storage.sql.exec(`INSERT INTO mapi_audit_spool_head VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'building', 0, 0, ?)`,
      scope.id, r.projectId, r.origin, r.objectName, r.generation, scope.epoch, scope.principal, scope.request, ZERO);
    const after = head(storage, scope);
    if (after.state !== 'building' || after.frame_count !== 0 || after.total_bytes !== 0 || after.digest !== ZERO) throw new Error('Snapshot begin failed');
  });
}

export async function appendFrame(storage, scope, authorize, index, input) {
  scope = copyScope(scope);
  if (!Number.isSafeInteger(index) || index < 0 || !(input instanceof Uint8Array) || input.length < 1 || input.length > FRAME_MAX) throw new Error('Invalid snapshot frame');
  const data = new Uint8Array(input);
  const before = storage.transactionSync(() => {
    guard(storage, scope, authorize);
    const h = head(storage, scope);
    // Without a durable, independently authenticated history verifier, only
    // the immediately preceding frame can be checked against the head.
    if (index < h.frame_count) {
      if (index !== h.frame_count - 1) throw new Error('Historical snapshot replay is not verified');
      return { replay: frame(storage, scope, index), h };
    }
    if (h.state !== 'building' || index !== h.frame_count || h.total_bytes > Number.MAX_SAFE_INTEGER - data.length || index === Number.MAX_SAFE_INTEGER) throw new Error('Snapshot append out of order');
    return { previous: h.digest, h };
  });
  if (before.replay) {
    const digest = await frameHash(scope, index, before.replay.previous, data);
    return storage.transactionSync(() => {
      guard(storage, scope, authorize);
      const h = head(storage, scope);
      const old = frame(storage, scope, index);
      if (index !== h.frame_count - 1 || old.digest !== h.digest || old.previous !== before.replay.previous || old.digest !== digest || !same(old.data, data)) throw new Error('Conflicting snapshot replay');
      return { index, digest, replayed: true };
    });
  }
  const digest = await frameHash(scope, index, before.previous, data);
  return storage.transactionSync(() => {
    guard(storage, scope, authorize);
    const h = head(storage, scope);
    if (h.state !== 'building' || h.frame_count !== index || h.digest !== before.previous || h.total_bytes !== before.h.total_bytes) throw new Error('Snapshot head changed');
    storage.sql.exec('INSERT INTO mapi_audit_spool_frame VALUES (?, ?, ?, ?, ?)', scope.id, index, before.previous, digest, data);
    storage.sql.exec('UPDATE mapi_audit_spool_head SET frame_count = ?, total_bytes = ?, digest = ? WHERE snapshot_id = ?', index + 1, h.total_bytes + data.length, digest, scope.id);
    const after = head(storage, scope), stored = frame(storage, scope, index);
    if (after.frame_count !== index + 1 || after.total_bytes !== h.total_bytes + data.length || after.digest !== digest || stored.previous !== before.previous || stored.digest !== digest || !same(stored.data, data)) throw new Error('Snapshot append failed');
    return { index, digest, replayed: false };
  });
}

export function sealSpool(storage, scope, authorize, expectedCount, expectedDigest) {
  scope = copyScope(scope);
  return storage.transactionSync(() => {
    guard(storage, scope, authorize);
    const h = head(storage, scope);
    if (!Number.isSafeInteger(expectedCount) || expectedCount < 0 || !hex(expectedDigest) || h.frame_count !== expectedCount || h.digest !== expectedDigest) throw new Error('Snapshot seal mismatch');
    if (h.state === 'building') storage.sql.exec("UPDATE mapi_audit_spool_head SET state = 'sealed' WHERE snapshot_id = ?", scope.id);
    const after = head(storage, scope);
    if (after.state !== 'sealed' || after.frame_count !== h.frame_count || after.total_bytes !== h.total_bytes || after.digest !== h.digest) throw new Error('Snapshot seal failed');
    return { count: h.frame_count, bytes: h.total_bytes, digest: h.digest };
  });
}

// Experimental verification helpers. The caller must supply an independently
// trusted head, keep the spool immutable while verification spans invocations,
// and authenticate its checkpoints outside this SQLite database.
export function inspectSpoolHead(storage, scope, authorize) {
  scope = copyScope(scope);
  return storage.transactionSync(() => { guard(storage, scope, authorize); return { ...head(storage, scope) }; });
}

export async function readFrameAtHead(storage, scope, authorize, anchor, index, expectedPrevious) {
  scope = copyScope(scope);
  if (!anchor || typeof anchor !== 'object') throw new Error('Invalid snapshot verification');
  anchor = { state: anchor.state, frame_count: anchor.frame_count, total_bytes: anchor.total_bytes, digest: anchor.digest };
  if (!anchor || !['building', 'sealed'].includes(anchor.state) || !Number.isSafeInteger(anchor.frame_count) ||
      !Number.isSafeInteger(anchor.total_bytes) || !hex(anchor.digest) || !Number.isSafeInteger(index) || index < 0 ||
      !hex(expectedPrevious) || (index === 0 && expectedPrevious !== ZERO)) throw new Error('Invalid snapshot verification');
  const matches = h => h.state === anchor.state && h.frame_count === anchor.frame_count &&
    h.total_bytes === anchor.total_bytes && h.digest === anchor.digest;
  const before = storage.transactionSync(() => {
    guard(storage, scope, authorize);
    const h = head(storage, scope);
    if (!matches(h) || index >= h.frame_count) throw new Error('Snapshot head changed');
    const f = frame(storage, scope, index);
    if (f.previous !== expectedPrevious || (index === h.frame_count - 1 && f.digest !== h.digest)) throw new Error('Snapshot chain mismatch');
    return f;
  });
  const computed = await frameHash(scope, index, before.previous, before.data);
  return storage.transactionSync(() => {
    guard(storage, scope, authorize);
    const h = head(storage, scope), f = frame(storage, scope, index);
    if (!matches(h) || f.previous !== expectedPrevious || f.digest !== computed ||
        (index === h.frame_count - 1 && f.digest !== h.digest) || !same(f.data, before.data)) throw new Error('Snapshot verification changed');
    return { data: f.data, digest: f.digest };
  });
}

// Private consumer must independently follow every link from ZERO to the
// sealed head and validate all output before publishing any successful HTTP
// response. This function checks one bounded frame, not the whole history.
export async function readSealedFrame(storage, scope, authorize, index, expectedPrevious) {
  scope = copyScope(scope);
  if (!Number.isSafeInteger(index) || index < 0 || !hex(expectedPrevious)) throw new Error('Invalid snapshot cursor');
  if (index === 0 && expectedPrevious !== ZERO) throw new Error('Snapshot chain mismatch');
  const before = storage.transactionSync(() => {
    guard(storage, scope, authorize);
    const h = head(storage, scope);
    if (h.state !== 'sealed' || index >= h.frame_count) throw new Error('Snapshot not sealed or cursor invalid');
    const f = frame(storage, scope, index);
    if (f.previous !== expectedPrevious || (index === h.frame_count - 1 && f.digest !== h.digest)) throw new Error('Snapshot chain mismatch');
    return { h, f };
  });
  const computed = await frameHash(scope, index, before.f.previous, before.f.data);
  return storage.transactionSync(() => {
    guard(storage, scope, authorize);
    const h = head(storage, scope), f = frame(storage, scope, index);
    if (h.state !== 'sealed' || h.frame_count !== before.h.frame_count || h.total_bytes !== before.h.total_bytes || h.digest !== before.h.digest ||
        f.previous !== expectedPrevious || f.digest !== computed || (index === h.frame_count - 1 && f.digest !== h.digest) || !same(f.data, before.f.data)) throw new Error('Snapshot integrity mismatch');
    return { data: f.data, digest: f.digest, count: h.frame_count, totalBytes: h.total_bytes, finalDigest: h.digest };
  });
}

export const initialDigest = ZERO;
export const maxFrameBytes = FRAME_MAX;
