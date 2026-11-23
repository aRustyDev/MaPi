// Unmounted experiment. The caller must authenticate the scope, prevent direct
// access to the shadow tables, and ensure every consumer holds a durable lease.
// A database writer able to modify both the schema and its stored manifest is
// outside this module's trust boundary. This does not provide snapshot export.
import { assertOwnerFence } from '../../worker/owner-fence.js';
import { installShadowSQLInTransaction } from './shadow-sql.mjs';

const lifecycleDDL = `CREATE TABLE mapi_audit_shadow_lifecycle (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1), snapshot_id TEXT NOT NULL,
  project_id TEXT NOT NULL, origin TEXT NOT NULL, object_name TEXT NOT NULL,
  generation INTEGER NOT NULL, recovery_epoch TEXT NOT NULL, principal_digest TEXT NOT NULL,
  request_digest TEXT NOT NULL, state TEXT NOT NULL, schema_manifest TEXT NOT NULL
)`;
const readerDDL = `CREATE TABLE mapi_audit_shadow_readers (
  reader_id TEXT NOT NULL, use_id TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('active','released')),
  PRIMARY KEY(reader_id, use_id)
)`;
// The sort engine is not implemented here. These tables provide private,
// lease-bound storage for a future resumable engine; opaque checkpoints must
// never be accepted as proof that a page is sorted or safe to publish.
const sortDDL = `CREATE TABLE mapi_audit_shadow_sort (
  sort_id TEXT PRIMARY KEY, reader_id TEXT NOT NULL, use_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('collecting','sorting','discarding','discarded')),
  count INTEGER NOT NULL, version INTEGER NOT NULL, program TEXT NOT NULL,
  UNIQUE(reader_id, use_id)
)`;
const sortItemsDDL = `CREATE TABLE mapi_audit_shadow_sort_items (
  sort_id TEXT NOT NULL, ordinal INTEGER NOT NULL, handle TEXT NOT NULL,
  PRIMARY KEY(sort_id, ordinal)
)`;
const triggers = ['mapi_shadow_before_insert','mapi_shadow_before_update','mapi_shadow_before_delete',
  'mapi_shadow_after_insert','mapi_shadow_after_update'];
// The transport limit applies to a complete encoded frame, not to an event
// or response page. Callers must fragment larger results before returning.
const maxFrameBytes = 128 * 1024;
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const typedArrayByteLength = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteLength').get;
const typedArrayBuffer = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'buffer').get;
const arrayBufferByteLength = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength').get;
const hex = (v, n) => typeof v === 'string' && v.length === n && /^[0-9a-f]+$/.test(v);
const text = v => typeof v === 'string' && v.length > 0 && v.isWellFormed();

function copyScope(input) {
  const r = input?.route;
  const scope = { id:input?.id, epoch:input?.epoch, principal:input?.principal, request:input?.request,
    route:{projectId:r?.projectId, origin:r?.origin, objectName:r?.objectName, generation:r?.generation} };
  if (!hex(scope.id,32) || !hex(scope.principal,64) || !hex(scope.request,64) || !text(scope.epoch) ||
      !text(scope.route.projectId) || !text(scope.route.origin) || !text(scope.route.objectName) ||
      !Number.isSafeInteger(scope.route.generation) || scope.route.generation < 1) throw Error('Invalid shadow scope');
  Object.freeze(scope.route); return Object.freeze(scope);
}
const rows = (storage, query, ...args) => storage.sql.exec(query, ...args).toArray();
const totalChanges = storage => {
  const result = rows(storage,"SELECT CAST(total_changes() AS TEXT) AS n");
  if (result.length !== 1 || typeof result[0].n !== 'string' || !/^(0|[1-9][0-9]*)$/.test(result[0].n)) throw Error('Invalid shadow change counter');
  return result[0].n;
};

// SQLite resolves TEMP objects before main and permits TEMP triggers on main
// tables. A main-schema manifest cannot detect either. Fail closed if TEMP
// inspection is unavailable or if any object shadows the source or snapshot
// namespace, or if a trigger targets one of those objects. This does not guard
// the separate fence and recovery-authority tables.
function assertNoTemporaryShadow(storage) {
  const found = rows(storage, `SELECT 1 FROM sqlite_temp_schema
    WHERE lower(name) = 'events' OR lower(name) GLOB 'mapi_shadow_*'
       OR lower(name) GLOB 'mapi_audit_shadow_*'
       OR (type = 'trigger' AND (lower(tbl_name) = 'events'
            OR lower(tbl_name) GLOB 'mapi_shadow_*'
            OR lower(tbl_name) GLOB 'mapi_audit_shadow_*'))
    LIMIT 1`);
  if (found.length) throw Error('Invalid shadow temporary schema');
}

function guard(storage, scope, authorize) {
  if (typeof authorize !== 'function') throw Error('Shadow authority missing');
  const check = () => {
    assertNoTemporaryShadow(storage);
    assertOwnerFence(storage, scope.route);
    const era = rows(storage, "SELECT CASE WHEN typeof(epoch)='text' AND epoch COLLATE BINARY=? THEN 1 ELSE 0 END AS ok FROM mapi_recovery_epoch LIMIT 2", scope.epoch);
    if (era.length !== 1 || era[0].ok !== 1) throw Error('Shadow recovery era changed');
  };
  check();
  // The callback is trusted and synchronous. Detect SQLite row writes even
  // when it changes a row back before returning. This does not detect DDL or
  // non-SQL side effects and does not cancel an async continuation: callers
  // must not schedule work that can mutate after the callback returns.
  const before=totalChanges(storage);
  const authorized=authorize(scope);
  if (totalChanges(storage) !== before) throw Error('Shadow authority must be read-only');
  if (authorized !== true) throw Error('Shadow authority denied');
  check();
}

// Read bounded schema descriptions. This detects changes relative to the
// installed manifest; authenticating that manifest independently is required.
function schemaManifest(storage) {
  const found = rows(storage, `SELECT
    CASE WHEN length(CAST(type AS BLOB)) <= 32 THEN type END AS type,
    CASE WHEN length(CAST(name AS BLOB)) <= 256 THEN name END AS name,
    CASE WHEN length(CAST(tbl_name AS BLOB)) <= 256 THEN tbl_name END AS tbl_name,
    CASE WHEN sql IS NULL OR length(CAST(sql AS BLOB)) <= 65536 THEN sql END AS sql,
    CASE WHEN sql IS NULL THEN 1 ELSE 0 END AS no_sql
    FROM sqlite_schema WHERE name='events' COLLATE NOCASE OR tbl_name='events' COLLATE NOCASE OR lower(name) GLOB 'mapi_shadow_*'
      OR lower(name) GLOB 'mapi_audit_shadow_*'
      OR tbl_name COLLATE NOCASE IN ('mapi_shadow_events','mapi_shadow_after','mapi_audit_shadow_lifecycle','mapi_audit_shadow_readers','mapi_audit_shadow_sort','mapi_audit_shadow_sort_items') ORDER BY type,name LIMIT 128`);
  if (found.length >= 128 || found.some(x => !x.type || !x.name || !x.tbl_name || (x.sql === null && x.no_sql !== 1))) throw Error('Invalid shadow schema');
  const encoded = JSON.stringify(found);
  if (new TextEncoder().encode(encoded).length > 65536) throw Error('Invalid shadow schema');
  return encoded;
}

function current(storage, scope) {
  const r=scope.route;
  const result=rows(storage, `SELECT CASE WHEN typeof(state)='text' AND state IN ('active','cleaning','complete') THEN state END AS state,
    CASE WHEN typeof(schema_manifest)='text' AND length(CAST(schema_manifest AS BLOB))<=65536 THEN schema_manifest END AS manifest
    FROM mapi_audit_shadow_lifecycle WHERE singleton=1 AND snapshot_id=? AND project_id=? COLLATE BINARY
      AND origin=? COLLATE BINARY AND object_name=? COLLATE BINARY AND generation=? AND recovery_epoch=? COLLATE BINARY
      AND principal_digest=? AND request_digest=?`, scope.id,r.projectId,r.origin,r.objectName,r.generation,scope.epoch,scope.principal,scope.request);
  if (result.length !== 1 || !result[0].state || typeof result[0].manifest !== 'string') throw Error('Shadow scope or lifecycle differs');
  if (schemaManifest(storage) !== result[0].manifest) throw Error('Shadow schema differs');
  return result[0].state;
}

function beginShadowScopedInTransaction(storage, scope, sourceDDL, sourceIndexes, authorize) {
  guard(storage,scope,authorize);
  if (rows(storage,"SELECT 1 FROM sqlite_schema WHERE name COLLATE NOCASE IN ('mapi_audit_shadow_lifecycle','mapi_audit_shadow_readers') OR lower(name) GLOB 'mapi_shadow_*' LIMIT 1").length) throw Error('Shadow already exists');
  storage.sql.exec(lifecycleDDL); storage.sql.exec(readerDDL); storage.sql.exec(sortDDL); storage.sql.exec(sortItemsDDL);
  installShadowSQLInTransaction(storage,sourceDDL,sourceIndexes,()=>{guard(storage,scope,authorize);return true;});
  const manifest=schemaManifest(storage), r=scope.route;
  storage.sql.exec('INSERT INTO mapi_audit_shadow_lifecycle VALUES (1,?,?,?,?,?,?,?,?,?,?)',
    scope.id,r.projectId,r.origin,r.objectName,r.generation,scope.epoch,scope.principal,scope.request,'active',manifest);
  if (current(storage,scope)!=='active') throw Error('Shadow start failed');
  guard(storage,scope,authorize);
}

// Trusted owner code may call this only while it already holds the same synchronous SQLite
// transaction as the real authorization decision. The caller is responsible
// for ensuring that transaction exists and for rolling it back on failure;
// this unmounted helper cannot itself prove either condition or authority.
export function beginShadowInTransaction(storage, input, sourceDDL, sourceIndexes, authorize) {
  return beginShadowScopedInTransaction(storage,copyScope(input),sourceDDL,sourceIndexes,authorize);
}

export function beginShadow(storage, input, sourceDDL, sourceIndexes, authorize) {
  const scope=copyScope(input);
  return storage.transactionSync(() => beginShadowScopedInTransaction(storage,scope,sourceDDL,sourceIndexes,authorize));
}

// A caller resolves a lost begin/close acknowledgement by rereading the
// durable scoped state. Absence is reported only if no shadow artifacts are
// present; an incomplete or foreign lifecycle fails closed.
export function shadowStatus(storage,input,authorize) {
  const scope=copyScope(input);
  return storage.transactionSync(()=>{
    guard(storage,scope,authorize);
    const found=rows(storage,"SELECT 1 FROM sqlite_schema WHERE name='mapi_audit_shadow_lifecycle' COLLATE NOCASE LIMIT 1");
    if (!found.length) {
      if (rows(storage,"SELECT 1 FROM sqlite_schema WHERE lower(name) GLOB 'mapi_shadow_*' OR lower(name) GLOB 'mapi_audit_shadow_*' LIMIT 1").length) throw Error('Shadow lifecycle missing');
      return null;
    }
    const state=current(storage,scope);
    guard(storage,scope,authorize);
    return {state};
  });
}

// Each logical consumer must receive a distinct, unpredictable use ID from a
// trusted allocator. Repeating the same pair is an idempotent lost-ACK retry,
// so this module cannot distinguish two consumers given the same pair. Every
// consumer must acquire before accessing the view and release only after all
// output is consumed. Crashes leave an active lease, blocking cleanup.
export function acquireShadowReader(storage,input,readerID,useID,authorize) {
  const scope=copyScope(input); if (!hex(readerID,32) || !hex(useID,32)) throw Error('Invalid shadow reader');
  return storage.transactionSync(()=>{
    guard(storage,scope,authorize);
    if (current(storage,scope)!=='active') throw Error('Shadow is closing');
    const found=rows(storage,"SELECT CASE WHEN typeof(state)='text' AND state IN ('active','released') THEN state END AS state FROM mapi_audit_shadow_readers WHERE reader_id=? AND use_id=?",readerID,useID);
    if (found.length===0) storage.sql.exec("INSERT INTO mapi_audit_shadow_readers VALUES (?, ?, 'active')",readerID,useID);
    else if (found.length!==1 || found[0].state!=='active') throw Error('Shadow reader cannot be reused');
    guard(storage,scope,authorize);
    if (current(storage,scope)!=='active') throw Error('Shadow is closing');
    if (rows(storage,"SELECT 1 FROM mapi_audit_shadow_readers WHERE reader_id=? AND use_id=? AND state='active'",readerID,useID).length!==1) throw Error('Shadow reader did not persist');
  });
}

export function releaseShadowReader(storage,input,readerID,useID,authorize) {
  const scope=copyScope(input); if (!hex(readerID,32) || !hex(useID,32)) throw Error('Invalid shadow reader');
  return storage.transactionSync(()=>{
    guard(storage,scope,authorize);
    if (current(storage,scope)!=='active') throw Error('Shadow is closing');
    if (rows(storage,"SELECT 1 FROM mapi_audit_shadow_sort WHERE reader_id=? AND use_id=? AND state<>'discarded' LIMIT 1",readerID,useID).length) throw Error('Shadow sort remains active');
    const found=rows(storage,"SELECT CASE WHEN typeof(state)='text' AND state IN ('active','released') THEN state END AS state FROM mapi_audit_shadow_readers WHERE reader_id=? AND use_id=?",readerID,useID);
    if (found.length!==1 || !['active','released'].includes(found[0].state)) throw Error('Unknown shadow reader');
    if (found[0].state==='active') storage.sql.exec("UPDATE mapi_audit_shadow_readers SET state='released' WHERE reader_id=? AND use_id=?",readerID,useID);
    guard(storage,scope,authorize);
    if (current(storage,scope)!=='active') throw Error('Shadow is closing');
    if (rows(storage,"SELECT 1 FROM mapi_audit_shadow_readers WHERE reader_id=? AND use_id=? AND state='released'",readerID,useID).length!==1) throw Error('Shadow release did not persist');
  });
}

// The callback must be synchronous and read-only and return exactly one
// already-encoded frame. Copy it inside the guarded transaction so no live
// storage handle or mutable source buffer escapes with the lease. A frame is
// not a complete response; callers still need an authenticated inventory and
// full validation before publishing. This does not prevent other SQL access
// from bypassing the lease or establish a bound on the callback's own work.
export function withShadowReader(storage,input,readerID,useID,authorize,read) {
  const scope=copyScope(input);
  if (!hex(readerID,32) || !hex(useID,32) || typeof read !== 'function') throw Error('Invalid shadow reader');
  return storage.transactionSync(()=>{
    const check=()=>{
      guard(storage,scope,authorize);
      if (current(storage,scope)!=='active') throw Error('Shadow is closing');
      const found=rows(storage,"SELECT 1 FROM mapi_audit_shadow_readers WHERE reader_id=? AND use_id=? AND state='active'",readerID,useID);
      if (found.length!==1) throw Error('Shadow reader is not active');
    };
    check();
    // A reader is not authorized to mutate business or snapshot rows. Checking
    // total_changes detects a write even when the callback changes a row back;
    // throwing inside this transaction also rolls back its side effects.
    const before=totalChanges(storage);
    const result=read();
    if (totalChanges(storage) !== before) throw Error('Shadow read must be read-only');
    if (result !== null && (typeof result==='object' || typeof result==='function') && typeof result.then==='function') throw Error('Shadow read must be synchronous');
    if (!(result instanceof Uint8Array) || !ArrayBuffer.isView(result)) throw Error('Shadow read must return an encoded frame');
    const length=typedArrayByteLength.call(result), buffer=typedArrayBuffer.call(result);
    // `instanceof SharedArrayBuffer` is not a brand check: a shared buffer
    // can come from another realm or have its prototype changed. The captured
    // ArrayBuffer getter accepts ordinary ArrayBuffers and rejects shared ones
    // based on their internal slots, independent of the prototype chain.
    try { arrayBufferByteLength.call(buffer); } catch { throw Error('Invalid shadow frame'); }
    if (!Number.isSafeInteger(length) || length<0 || length>maxFrameBytes) throw Error('Invalid shadow frame');
    const frame=new Uint8Array(result);
    check();
    return frame;
  });
}

// These primitives are a private transactional seam for a trusted resumable
// sort engine. They do not validate the engine's algorithm, candidate
// completeness, checkpoint semantics, or authorize a response. A row writer
// with direct SQL access can bypass them; the owner must protect these tables.
function sortGuard(storage,scope,readerID,useID,authorize) {
  guard(storage,scope,authorize);
  if (current(storage,scope)!=='active') throw Error('Shadow is closing');
  if (rows(storage,"SELECT 1 FROM mapi_audit_shadow_readers WHERE reader_id=? AND use_id=? AND state='active'",readerID,useID).length!==1) throw Error('Shadow reader is not active');
}
function sortIDs(readerID,useID,sortID) {
  if (!hex(readerID,32) || !hex(useID,32) || !hex(sortID,32)) throw Error('Invalid shadow sort identity');
}
function sortProgram(program) {
  if (typeof program!=='string' || !program.isWellFormed() || !program || new TextEncoder().encode(program).length>4096) throw Error('Invalid shadow sort checkpoint');
}
function sortJob(storage,readerID,useID,sortID) {
  const found=rows(storage,"SELECT state,count,version,program FROM mapi_audit_shadow_sort WHERE sort_id=? AND reader_id=? AND use_id=?",sortID,readerID,useID);
  const job=found[0];
  if(found.length!==1 || !['collecting','sorting','discarding','discarded'].includes(job.state) || !Number.isSafeInteger(job.count) || job.count<0 || !Number.isSafeInteger(job.version) || job.version<0 || typeof job.program!=='string' || new TextEncoder().encode(job.program).length>4096) throw Error('Invalid shadow sort state');
  return job;
}
function nextSortVersion(job,expected) {
  if(!Number.isSafeInteger(expected) || expected!==job.version || expected===Number.MAX_SAFE_INTEGER) throw Error('Stale shadow sort version');
  return expected+1;
}
function sortHandle(value) {
  if(typeof value!=='string' || value.length>20 || !/^(?:0|[1-9][0-9]*|-[1-9][0-9]*)$/.test(value)) throw Error('Invalid shadow sort handle');
  const n=BigInt(value); if(n<-(1n<<63n) || n>(1n<<63n)-1n) throw Error('Invalid shadow sort handle');
  return value;
}
export function beginShadowSort(storage,input,readerID,useID,sortID,authorize) {
  const scope=copyScope(input); sortIDs(readerID,useID,sortID);
  return storage.transactionSync(()=>{
    sortGuard(storage,scope,readerID,useID,authorize);
    const found=rows(storage,'SELECT sort_id FROM mapi_audit_shadow_sort WHERE reader_id=? AND use_id=?',readerID,useID);
    if(found.length===0) storage.sql.exec("INSERT INTO mapi_audit_shadow_sort VALUES (?,?,?,'collecting',0,0,'')",sortID,readerID,useID);
    else if(found.length!==1 || found[0].sort_id!==sortID) throw Error('Conflicting shadow sort');
    sortGuard(storage,scope,readerID,useID,authorize);
    const result=sortJob(storage,readerID,useID,sortID);
    if(result.state==='discarded') throw Error('Shadow sort cannot be reused');
    return result;
  });
}
export function appendShadowSortHandles(storage,input,readerID,useID,sortID,authorize,version,handles) {
  const scope=copyScope(input); sortIDs(readerID,useID,sortID);
  if(!Array.isArray(handles) || !handles.length || handles.length>64) throw Error('Invalid shadow sort batch');
  handles=handles.map(sortHandle);
  return storage.transactionSync(()=>{
    sortGuard(storage,scope,readerID,useID,authorize);
    const job=sortJob(storage,readerID,useID,sortID), next=nextSortVersion(job,version);
    if(job.state!=='collecting' || !Number.isSafeInteger(job.count+handles.length)) throw Error('Shadow sort is not collecting');
    for(let i=0;i<handles.length;i++) {
      if(rows(storage,"SELECT 1 FROM mapi_shadow_snapshot WHERE source_rowid=CAST(? AS INTEGER) AND typeof(project_id)='text' AND project_id COLLATE BINARY=? LIMIT 2",handles[i],scope.route.projectId).length!==1) throw Error('Foreign shadow sort handle');
      storage.sql.exec('INSERT INTO mapi_audit_shadow_sort_items VALUES (?,?,?)',sortID,job.count+i,handles[i]);
    }
    storage.sql.exec('UPDATE mapi_audit_shadow_sort SET count=?,version=? WHERE sort_id=? AND version=?',job.count+handles.length,next,sortID,version);
    sortGuard(storage,scope,readerID,useID,authorize);
    const after=sortJob(storage,readerID,useID,sortID);
    if(after.count!==job.count+handles.length || after.version!==next || after.state!=='collecting') throw Error('Shadow sort append did not commit');
    return after;
  });
}
export function advanceShadowSort(storage,input,readerID,useID,sortID,authorize,version,program,swap=null) {
  const scope=copyScope(input); sortIDs(readerID,useID,sortID); sortProgram(program);
  return storage.transactionSync(()=>{
    sortGuard(storage,scope,readerID,useID,authorize);
    const job=sortJob(storage,readerID,useID,sortID), next=nextSortVersion(job,version);
    if(!['collecting','sorting'].includes(job.state)) throw Error('Shadow sort is not active');
    if(swap!==null) {
      if(job.state!=='sorting' || !Array.isArray(swap) || swap.length!==2 || swap.some(n=>!Number.isSafeInteger(n) || n<0 || n>=job.count) || swap[0]===swap[1]) throw Error('Invalid shadow sort swap');
      const read=n=>rows(storage,'SELECT handle FROM mapi_audit_shadow_sort_items WHERE sort_id=? AND ordinal=?',sortID,n);
      const a=read(swap[0]), b=read(swap[1]); if(a.length!==1 || b.length!==1) throw Error('Shadow sort spool differs');
      storage.sql.exec('UPDATE mapi_audit_shadow_sort_items SET handle=? WHERE sort_id=? AND ordinal=?',b[0].handle,sortID,swap[0]);
      storage.sql.exec('UPDATE mapi_audit_shadow_sort_items SET handle=? WHERE sort_id=? AND ordinal=?',a[0].handle,sortID,swap[1]);
      if(read(swap[0])[0]?.handle!==b[0].handle || read(swap[1])[0]?.handle!==a[0].handle) throw Error('Shadow sort swap did not commit');
    }
    storage.sql.exec("UPDATE mapi_audit_shadow_sort SET state='sorting',version=?,program=? WHERE sort_id=? AND version=?",next,program,sortID,version);
    sortGuard(storage,scope,readerID,useID,authorize);
    const after=sortJob(storage,readerID,useID,sortID);
    if(after.state!=='sorting' || after.count!==job.count || after.version!==next || after.program!==program) throw Error('Shadow sort checkpoint did not commit');
    return after;
  });
}
export function readShadowSort(storage,input,readerID,useID,sortID,authorize,offset,limit) {
  const scope=copyScope(input); sortIDs(readerID,useID,sortID);
  if(!Number.isSafeInteger(offset) || offset<0 || !Number.isSafeInteger(limit) || limit<1 || limit>64) throw Error('Invalid shadow sort page');
  return storage.transactionSync(()=>{
    sortGuard(storage,scope,readerID,useID,authorize);
    const job=sortJob(storage,readerID,useID,sortID);
    const items=rows(storage,'SELECT ordinal,handle FROM mapi_audit_shadow_sort_items WHERE sort_id=? AND ordinal>=? ORDER BY ordinal LIMIT ?',sortID,offset,limit);
    sortGuard(storage,scope,readerID,useID,authorize);
    return {job,items};
  });
}
export function discardShadowSortStep(storage,input,readerID,useID,sortID,authorize,limit) {
  const scope=copyScope(input); sortIDs(readerID,useID,sortID);
  if(!Number.isSafeInteger(limit) || limit<1 || limit>64) throw Error('Invalid shadow sort discard limit');
  return storage.transactionSync(()=>{
    sortGuard(storage,scope,readerID,useID,authorize);
    const job=sortJob(storage,readerID,useID,sortID);
    if(job.state==='discarded') return {complete:true,removed:0};
    if(job.state!=='discarding') storage.sql.exec("UPDATE mapi_audit_shadow_sort SET state='discarding' WHERE sort_id=?",sortID);
    storage.sql.exec('DELETE FROM mapi_audit_shadow_sort_items WHERE rowid IN (SELECT rowid FROM mapi_audit_shadow_sort_items WHERE sort_id=? LIMIT ?)',sortID,limit);
    const removed=rows(storage,'SELECT changes() AS n')[0]?.n;
    if(!Number.isSafeInteger(removed) || removed<0 || removed>limit) throw Error('Invalid shadow sort discard count');
    const remaining=rows(storage,'SELECT 1 FROM mapi_audit_shadow_sort_items WHERE sort_id=? LIMIT 1',sortID).length>0;
    if(!remaining) storage.sql.exec("UPDATE mapi_audit_shadow_sort SET state='discarded' WHERE sort_id=?",sortID);
    sortGuard(storage,scope,readerID,useID,authorize);
    if(sortJob(storage,readerID,useID,sortID).state!==(remaining?'discarding':'discarded')) throw Error('Shadow sort discard did not commit');
    return {complete:!remaining,removed};
  });
}

// Atomically close acquisition only after every registered reader is released.
// The view and mutation triggers disappear in the same transaction; data is
// subsequently removed in bounded-row steps while normal writes continue.
export function closeShadow(storage,input,authorize) {
  const scope=copyScope(input);
  return storage.transactionSync(()=>{
    guard(storage,scope,authorize);
    const state=current(storage,scope);
    if (state==='cleaning' || state==='complete') return;
    // Any non-released row, including malformed state, blocks cleanup.
    if (rows(storage,"SELECT 1 FROM mapi_audit_shadow_readers WHERE typeof(state)<>'text' OR state<>'released' LIMIT 1").length) throw Error('Shadow readers remain active');
    if (rows(storage,"SELECT 1 FROM mapi_audit_shadow_sort WHERE state<>'discarded' LIMIT 1").length || rows(storage,'SELECT 1 FROM mapi_audit_shadow_sort_items LIMIT 1').length) throw Error('Shadow sort remains active');
    storage.sql.exec('DROP TABLE mapi_audit_shadow_sort_items'); storage.sql.exec('DROP TABLE mapi_audit_shadow_sort');
    for (const trigger of triggers) storage.sql.exec(`DROP TRIGGER ${trigger}`);
    storage.sql.exec('DROP VIEW mapi_shadow_snapshot');
    const manifest=schemaManifest(storage);
    storage.sql.exec("UPDATE mapi_audit_shadow_lifecycle SET state='cleaning',schema_manifest=? WHERE singleton=1",manifest);
    if (current(storage,scope)!=='cleaning') throw Error('Shadow close failed');
    guard(storage,scope,authorize);
  });
}

// A row-count limit is not a CPU, byte, or SQLite-internal-memory bound. The
// caller must establish resource budgets and a safe post-recovery policy.
export function cleanupShadowStep(storage,input,authorize,limit) {
  const scope=copyScope(input);
  if (!Number.isSafeInteger(limit) || limit<1 || limit>64) throw Error('Invalid shadow cleanup limit');
  return storage.transactionSync(()=>{
    guard(storage,scope,authorize);
    const state=current(storage,scope);
    if (state==='complete') return {complete:true, removed:0};
    if (state!=='cleaning') throw Error('Shadow is not closed');
    let removed=0;
    for (const table of ['mapi_shadow_events','mapi_shadow_after','mapi_audit_shadow_readers']) {
      if (removed===limit) break;
      storage.sql.exec(`DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} LIMIT ?)`,limit-removed);
      const count=rows(storage,'SELECT changes() AS n')[0]?.n;
      if (!Number.isSafeInteger(count) || count<0 || count>limit-removed) throw Error('Shadow cleanup count differs');
      removed+=count;
    }
    const remaining=['mapi_shadow_events','mapi_shadow_after','mapi_audit_shadow_readers']
      .some(table=>rows(storage,`SELECT 1 FROM ${table} LIMIT 1`).length>0);
    if (!remaining) {
      storage.sql.exec('DROP TABLE mapi_shadow_events');
      storage.sql.exec('DROP TABLE mapi_shadow_after');
      storage.sql.exec('DROP TABLE mapi_audit_shadow_readers');
      // Retain a terminal tombstone so a lost completion acknowledgement can
      // be reconciled. Reuse for a new snapshot requires a future separately
      // authorized archive/reset protocol, which this experiment does not have.
      storage.sql.exec("UPDATE mapi_audit_shadow_lifecycle SET state='complete',schema_manifest=? WHERE singleton=1",schemaManifest(storage));
      if (current(storage,scope)!=='complete') throw Error('Shadow completion differs');
    } else if (current(storage,scope)!=='cleaning') throw Error('Shadow cleanup state differs');
    guard(storage,scope,authorize);
    return {complete:!remaining, removed};
  });
}
