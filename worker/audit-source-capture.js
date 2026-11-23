// Private, unmounted building block for a future audit snapshot. It copies
// one explicitly selected event inside the owner's fenced SQLite transaction;
// it does not select an authorized page, freeze the source across rows, or
// authorize publishing a response. Do not expose this module as an RPC.
import { assertOwnerFence } from './owner-fence.js';

const columns = Object.freeze([
  'project_id', 'id', 'event_type', 'category', 'occurred_at', 'created_at',
  'team_id', 'actor_id', 'actor_type', 'entity_type', 'entity_id', 'user_id',
  'client_id', 'token_id', 'delegation_type', 'delegation_id', 'grantor', 'fingerprint',
  'request_id', 'session_id', 'flow_id', 'operation_status', 'status_class', 'payload', 'metadata',
]);
const fragmentBytes = 64 * 1024;
const headsSQL = `CREATE TABLE mapi_audit_capture_rows (
  snapshot_id TEXT NOT NULL, ordinal INTEGER NOT NULL, source_rowid TEXT NOT NULL,
  project_id TEXT NOT NULL, origin TEXT NOT NULL, object_name TEXT NOT NULL,
  generation INTEGER NOT NULL, recovery_epoch TEXT NOT NULL, principal_digest TEXT NOT NULL,
  request_digest TEXT NOT NULL, fragment_count INTEGER NOT NULL,
  PRIMARY KEY(snapshot_id, ordinal)
)`;
const fragmentsSQL = `CREATE TABLE mapi_audit_capture_fragments (
  snapshot_id TEXT NOT NULL, ordinal INTEGER NOT NULL, column_no INTEGER NOT NULL,
  part_no INTEGER NOT NULL, storage_type TEXT NOT NULL, data BLOB,
  PRIMARY KEY(snapshot_id, ordinal, column_no, part_no)
)`;
const isHex = (s, n) => typeof s === 'string' && s.length === n && /^[0-9a-f]+$/.test(s);
const isText = s => typeof s === 'string' && s.length > 0 && s.isWellFormed();

// The caller is trusted to provide a server-resolved route and authorization
// callback. Copy its primitives once so an accessor cannot change them between
// validation and use. No untrusted caller can acquire a capability here.
function copyScope(scope) {
  const r = scope?.route;
  const out = { id: scope?.id, ordinal: scope?.ordinal, rowid: scope?.rowid,
    epoch: scope?.epoch, principal: scope?.principal, request: scope?.request,
    route: { projectId: r?.projectId, origin: r?.origin, objectName: r?.objectName, generation: r?.generation } };
  const id = out.rowid;
  if (!isHex(out.id, 32) || !Number.isSafeInteger(out.ordinal) || out.ordinal < 0 ||
      typeof id !== 'string' || !/^(?:0|-[1-9][0-9]{0,18}|[1-9][0-9]{0,18})$/.test(id) ||
      BigInt(id) < -9223372036854775808n || BigInt(id) > 9223372036854775807n ||
      !isText(out.epoch) || !isHex(out.principal, 64) || !isHex(out.request, 64) ||
      !isText(out.route.projectId) || !isText(out.route.origin) || !isText(out.route.objectName) ||
      !Number.isSafeInteger(out.route.generation) || out.route.generation < 1) throw Error('Invalid audit capture scope');
  Object.freeze(out.route);
  return Object.freeze(out);
}
function guard(storage, s, authorize) {
  assertOwnerFence(storage, s.route);
  const rows = storage.sql.exec("SELECT CASE WHEN typeof(epoch) = 'text' AND epoch COLLATE BINARY = ? THEN 1 ELSE 0 END AS matches FROM mapi_recovery_epoch LIMIT 2", s.epoch).toArray();
  if (rows.length !== 1 || rows[0].matches !== 1) throw Error('Audit capture recovery era changed');
  if (typeof authorize !== 'function') throw Error('Audit capture authority missing');
  const result = authorize(s);
  if (result !== true) throw Error('Audit capture authority denied');
  assertOwnerFence(storage, s.route);
  const after = storage.sql.exec("SELECT CASE WHEN typeof(epoch) = 'text' AND epoch COLLATE BINARY = ? THEN 1 ELSE 0 END AS matches FROM mapi_recovery_epoch LIMIT 2", s.epoch).toArray();
  if (after.length !== 1 || after[0].matches !== 1) throw Error('Audit capture recovery era changed');
}
function schema(storage) {
  // Unqualified SQLite names resolve TEMP objects before main objects, and a
  // TEMP trigger can attach to a main table without appearing in sqlite_schema.
  // Reject both before accessing any source or capture rows. A runtime that
  // cannot inspect its TEMP schema must fail closed rather than assume it is
  // empty. The surrounding authority and fence tables have separate guards.
  if (storage.sql.exec(`SELECT 1 FROM sqlite_temp_schema
      WHERE name COLLATE NOCASE IN ('events', 'mapi_audit_capture_rows', 'mapi_audit_capture_fragments')
         OR (type = 'trigger' AND tbl_name COLLATE NOCASE IN ('events', 'mapi_audit_capture_rows', 'mapi_audit_capture_fragments'))
      LIMIT 1`).toArray().length) throw Error('Invalid audit capture schema');
  for (const [name, definition] of [['mapi_audit_capture_rows', headsSQL], ['mapi_audit_capture_fragments', fragmentsSQL]]) {
    const found = storage.sql.exec("SELECT CASE WHEN type = 'table' AND sql = ? THEN 1 ELSE 0 END AS matches FROM sqlite_schema WHERE name = ? LIMIT 2", definition, name).toArray();
    if (found.length !== 1 || found[0].matches !== 1) throw Error('Invalid audit capture schema');
  }
  if (storage.sql.exec("SELECT 1 FROM sqlite_schema WHERE tbl_name IN ('mapi_audit_capture_rows', 'mapi_audit_capture_fragments') AND (type = 'trigger' OR (type = 'index' AND sql IS NOT NULL)) LIMIT 1").toArray().length) throw Error('Invalid audit capture schema');
  // This row-copy primitive only supports the pinned event column set and a
  // trigger-free source. A future integration must reconcile these checks
  // with any supported schema upgrades; it must not silently adopt one.
  const source = storage.sql.exec("SELECT CASE WHEN type = 'table' THEN 1 ELSE 0 END AS ok FROM sqlite_schema WHERE name = 'events' LIMIT 2").toArray();
  const colNames = columns.map(c => `'${c}'`).join(',');
  const observed = storage.sql.exec(`SELECT count(*) AS total, sum(CASE WHEN hidden = 0 AND name IN (${colNames}) THEN 1 ELSE 0 END) AS matched FROM pragma_table_xinfo('events')`).one();
  if (source.length !== 1 || source[0].ok !== 1 || observed.total !== columns.length || observed.matched !== columns.length ||
      storage.sql.exec("SELECT 1 FROM sqlite_schema WHERE tbl_name = 'events' AND type = 'trigger' LIMIT 1").toArray().length) throw Error('Invalid audit source schema');
}
function sourceMetadata(storage, s) {
  const projection = columns.map((c,i) => `typeof(${c}) AS t${i}, CASE WHEN typeof(${c}) IN ('text','blob') THEN length(CAST(${c} AS BLOB)) ELSE 0 END AS n${i}`).join(', ');
  const rows = storage.sql.exec(`SELECT ${projection} FROM events WHERE rowid = CAST(? AS INTEGER) AND typeof(project_id) = 'text' AND project_id COLLATE BINARY = ?`, s.rowid,s.route.projectId).toArray();
  if (rows.length !== 1) throw Error('Audit source row missing');
  return rows[0];
}
function partsFor(metadata, i) {
  const type = metadata[`t${i}`], n = metadata[`n${i}`];
  if (!['null','integer','real','text','blob'].includes(type) || !Number.isSafeInteger(n) || n < 0) throw Error('Invalid audit source value');
  return { type, parts:type === 'text' || type === 'blob' ? Math.max(1,Math.ceil(n/fragmentBytes)) : 1 };
}

// Call only as part of a separately reviewed owner schema migration. This is
// never invoked by the current Worker. Unexpected pre-existing names fail.
export function createAuditCaptureSchema(storage, route, epoch, authorize) {
  const s = copyScope({id:'0'.repeat(32),ordinal:0,rowid:'1',epoch,principal:'0'.repeat(64),request:'0'.repeat(64),route});
  storage.transactionSync(() => {
    guard(storage, s, authorize);
    storage.sql.exec(headsSQL);
    storage.sql.exec(fragmentsSQL);
    schema(storage);
    guard(storage, s, authorize);
  });
}

// Rowid is a canonical signed decimal SQLite rowid obtained by the trusted
// selector, not a Go-converted ID. The source project is checked in SQL.
// SQLite performs all source-value copies; JavaScript sees only bounded type
// and byte-count metadata. The transaction commits either the complete row
// and marker or neither. Tables and source are assumed inaccessible to other
// writers except through their reviewed owner protocol.
export function captureAuditSourceRow(storage, scope, authorize) {
  const s = copyScope(scope);
  return storage.transactionSync(() => {
    guard(storage, s, authorize);
    schema(storage);
    const args = [s.id,s.ordinal,s.rowid,s.route.projectId,s.route.origin,s.route.objectName,s.route.generation,s.epoch,s.principal,s.request];
    const existing = storage.sql.exec('SELECT 1 FROM mapi_audit_capture_rows WHERE snapshot_id = ? AND ordinal = ?', s.id, s.ordinal).toArray();
    if (existing.length) {
      const same = storage.sql.exec(`SELECT CASE WHEN typeof(fragment_count) = 'integer' AND fragment_count BETWEEN 0 AND 9007199254740991 THEN fragment_count END AS fragment_count FROM mapi_audit_capture_rows
        WHERE snapshot_id = ? AND ordinal = ? AND source_rowid = ? AND project_id = ? AND origin = ? AND object_name = ?
          AND generation = ? AND recovery_epoch = ? AND principal_digest = ? AND request_digest = ?`, ...args).toArray();
      if (same.length !== 1 || !Number.isSafeInteger(same[0].fragment_count) || same[0].fragment_count < columns.length) throw Error('Conflicting audit capture');
      const actual = storage.sql.exec('SELECT count(*) AS n FROM mapi_audit_capture_fragments WHERE snapshot_id = ? AND ordinal = ?', s.id, s.ordinal).one().n;
      if (actual !== same[0].fragment_count) throw Error('Audit capture incomplete');
      // A rowid may have been reused or its contents changed since capture.
      // Replays fail closed unless the still-present source and every saved
      // fragment agree by storage type and raw bytes/scalar value. This does
      // not establish an independently authenticated snapshot or support a
      // retry after source deletion; those require a trusted source version.
      const metadata = sourceMetadata(storage, s); let expected = 0;
      for (let i=0; i<columns.length; i++) {
        const {type,parts} = partsFor(metadata,i);
        // SQLite numeric equality does not demonstrate bit-exact REAL
        // identity (for example signed zero). Never treat it as verified.
        if (type === 'real') throw Error('REAL audit replay is not verified');
        const expression = type === 'text' || type === 'blob' ? `CASE WHEN length(CAST(e.${columns[i]} AS BLOB)) = 0 THEN X'' ELSE substr(CAST(e.${columns[i]} AS BLOB), f.part_no * ${fragmentBytes} + 1, ${fragmentBytes}) END` : `e.${columns[i]}`;
        const expectedType = type === 'text' || type === 'blob' ? 'blob' : type;
        const matched = storage.sql.exec(`SELECT count(*) AS n FROM mapi_audit_capture_fragments f, events e
          WHERE f.snapshot_id = ? AND f.ordinal = ? AND f.column_no = ? AND f.part_no >= 0 AND f.part_no < ?
            AND f.storage_type = ? AND typeof(f.data) = ? AND f.data IS ${expression}
            AND e.rowid = CAST(? AS INTEGER) AND typeof(e.project_id) = 'text' AND e.project_id COLLATE BINARY = ?`,s.id,s.ordinal,i,parts,type,expectedType,s.rowid,s.route.projectId).one().n;
        if (matched !== parts) throw Error(`Audit source or capture changed at column ${i}`);
        expected += parts;
      }
      if (actual !== expected) throw Error('Audit source or capture changed');
      guard(storage, s, authorize); schema(storage);
      return { replayed:true, fragments:actual };
    }
    // Pre-existing orphaned fragments are never adopted by a new marker.
    if (storage.sql.exec('SELECT 1 FROM mapi_audit_capture_fragments WHERE snapshot_id = ? AND ordinal = ? LIMIT 1', s.id, s.ordinal).toArray().length) throw Error('Orphaned audit capture fragments');
    const metadata = sourceMetadata(storage, s); let count = 0;
    for (let i=0; i<columns.length; i++) {
      const {type,parts} = partsFor(metadata,i);
      if (!Number.isSafeInteger(count + parts)) throw Error('Audit capture too large');
      for (let part=0; part<parts; part++) {
        const expression = type === 'text' || type === 'blob' ? `CASE WHEN length(CAST(${columns[i]} AS BLOB)) = 0 THEN X'' ELSE substr(CAST(${columns[i]} AS BLOB), ?, ${fragmentBytes}) END` : columns[i];
        const values = [s.id,s.ordinal,i,part,type,...(type === 'text' || type === 'blob' ? [part*fragmentBytes+1] : []),s.rowid,s.route.projectId];
        storage.sql.exec(`INSERT INTO mapi_audit_capture_fragments
          SELECT ?, ?, ?, ?, ?, ${expression} FROM events WHERE rowid = CAST(? AS INTEGER) AND typeof(project_id) = 'text' AND project_id COLLATE BINARY = ?`, ...values);
        if (storage.sql.exec('SELECT changes() AS n').one().n !== 1) throw Error('Audit capture fragment not inserted');
        count++;
      }
    }
    storage.sql.exec('INSERT INTO mapi_audit_capture_rows VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', ...args,count);
    if (storage.sql.exec('SELECT changes() AS n').one().n !== 1) throw Error('Audit capture marker not inserted');
    const actual = storage.sql.exec('SELECT count(*) AS n FROM mapi_audit_capture_fragments WHERE snapshot_id = ? AND ordinal = ?',s.id,s.ordinal).one().n;
    if (actual !== count) throw Error('Audit capture incomplete');
    guard(storage, s, authorize); schema(storage);
    return { replayed:false, fragments:count };
  });
}

export const auditSourceColumns = columns;
export const auditSourceFragmentBytes = fragmentBytes;
