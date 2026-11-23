// Unmounted experiment. The caller must obtain the selected source row from
// an authorized pinned query, keep its shadow and lease immutable, and hold
// an independently protected HMAC key. This is not an audit HTTP endpoint.
import { auditSourceColumns } from '../../worker/audit-source-capture.js';
import { withShadowReader } from './shadow-lifecycle.mjs';

const enc = new TextEncoder();
const fragmentBytes = 64 * 1024;
const zero = '0'.repeat(64);
const hex = (s, n) => typeof s === 'string' && s.length === n && /^[0-9a-f]+$/.test(s);
const toHex = b => [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('');
const sha = async b => toHex(await crypto.subtle.digest('SHA-256', b));
const jsonBytes = value => enc.encode(JSON.stringify(value));
const same = (a,b) => a.length === b.length && a.every((v,i) => v === b[i]);

// Copy the primitive scope before any asynchronous operation. The lifecycle
// performs its own authorization, route and recovery-era checks at each read.
function copyScope(input) {
  const r = input?.route;
  const s = { id:input?.id, epoch:input?.epoch, principal:input?.principal, request:input?.request,
    route:{projectId:r?.projectId, origin:r?.origin, objectName:r?.objectName, generation:r?.generation} };
  if (!hex(s.id,32) || !hex(s.principal,64) || !hex(s.request,64) ||
      typeof s.epoch !== 'string' || !s.epoch || !s.epoch.isWellFormed() ||
      !s.route || ![s.route.projectId,s.route.origin,s.route.objectName].every(x => typeof x === 'string' && x && x.isWellFormed()) ||
      !Number.isSafeInteger(s.route.generation) || s.route.generation < 1) throw Error('Invalid audit transfer scope');
  Object.freeze(s.route); return Object.freeze(s);
}
function validRowID(value) {
  return typeof value === 'string' && /^(?:0|-[1-9][0-9]{0,18}|[1-9][0-9]{0,18})$/.test(value) &&
    BigInt(value) >= -9223372036854775808n && BigInt(value) <= 9223372036854775807n;
}
function rowQuery(storage, column, rowid, project, projection, ...args) {
  const rows = storage.sql.exec(`SELECT ${projection} FROM mapi_shadow_snapshot
    WHERE source_rowid = CAST(? AS INTEGER) AND typeof(project_id) = 'text' AND project_id COLLATE BINARY = ? LIMIT 2`,
    ...args,rowid,project).toArray();
  if (rows.length !== 1) throw Error('Selected audit row unavailable');
  return rows[0];
}
function bytesOfBlob(value) {
  const bytes = value instanceof ArrayBuffer ? new Uint8Array(value) : value;
  if (!(bytes instanceof Uint8Array)) throw Error('Invalid audit fragment');
  return bytes;
}

// Builds only one bounded field fragment. For integer values SQLite prints
// decimal text before crossing JS's number boundary. REAL values use the
// binary64 bits delivered by the local SQL API; non-finite values fail closed
// until the separately interrupted type-fidelity work is resolved.
function readFrame(storage, scopeHash, scope, rowid, state) {
  const column=auditSourceColumns[state.column];
  if (!column) throw Error('Invalid audit transfer position');
  const m=rowQuery(storage,column,rowid,scope.route.projectId,
    `typeof(${column}) AS kind, CASE WHEN typeof(${column}) IN ('text','blob') THEN length(CAST(${column} AS BLOB)) ELSE 0 END AS size`);
  if (!['null','integer','real','text','blob'].includes(m.kind) || !Number.isSafeInteger(m.size) || m.size < 0) throw Error('Invalid audit value');
  let payload, size;
  if (m.kind === 'text' || m.kind === 'blob') {
    size=m.size;
    if (state.offset % fragmentBytes !== 0 || (size === 0 ? state.offset !== 0 : state.offset >= size)) throw Error('Invalid audit transfer position');
    const row=rowQuery(storage,column,rowid,scope.route.projectId,
      `CASE WHEN typeof(${column}) = ? AND length(CAST(${column} AS BLOB)) = ? THEN CASE WHEN ? = 0 THEN X'' ELSE substr(CAST(${column} AS BLOB), ?, ?) END END AS value`,
      m.kind,size,size,state.offset+1,fragmentBytes);
    payload=bytesOfBlob(row.value);
    if (payload.length !== Math.min(fragmentBytes, size-state.offset)) throw Error('Audit fragment differs');
  } else {
    if (state.offset !== 0) throw Error('Invalid audit transfer position');
    if (m.kind === 'integer') {
      const row=rowQuery(storage,column,rowid,scope.route.projectId,`CASE WHEN typeof(${column}) = 'integer' THEN printf('%lld', ${column}) END AS value`);
      if (typeof row.value !== 'string' || !/^(?:0|-[1-9][0-9]*|[1-9][0-9]*)$/.test(row.value)) throw Error('Invalid audit integer');
      payload=enc.encode(row.value);
    } else if (m.kind === 'real') {
      const row=rowQuery(storage,column,rowid,scope.route.projectId,`CASE WHEN typeof(${column}) = 'real' THEN ${column} END AS value`);
      if (typeof row.value !== 'number' || !Number.isFinite(row.value)) throw Error('Unsupported audit REAL');
      payload=new Uint8Array(8); new DataView(payload.buffer).setFloat64(0,row.value,false);
    } else payload=new Uint8Array();
    size=payload.length;
  }
  const last = m.kind !== 'text' && m.kind !== 'blob' || state.offset + payload.length === size;
  const value={version:1,scope:scopeHash,rowid,column:state.column,offset:state.offset,kind:m.kind,size,
    last,sequence:state.sequence,previous:state.previous,data:payload.toBase64()};
  return jsonBytes(value);
}
function nextPosition(state, frame, digest) {
  const finished=frame.last;
  return {version:1,scope:state.scope,rowid:state.rowid,reader:state.reader,use:state.use,
    column:finished ? state.column+1 : state.column,offset:finished ? 0 : state.offset+fragmentBytes,
    sequence:state.sequence+1,previous:digest};
}
function validateState(state, binding) {
  if (!state || typeof state !== 'object' || Array.isArray(state) ||
      Object.keys(state).sort().join(',') !== 'column,offset,previous,reader,rowid,scope,sequence,use,version' ||
      state.version !== 1 || state.scope !== binding.scope || state.rowid !== binding.rowid || state.reader !== binding.reader || state.use !== binding.use ||
      !Number.isSafeInteger(state.column) || state.column < 0 || state.column > auditSourceColumns.length ||
      !Number.isSafeInteger(state.offset) || state.offset < 0 || state.offset % fragmentBytes !== 0 ||
      !Number.isSafeInteger(state.sequence) || state.sequence < 0 || !hex(state.previous,64) ||
      (state.column === auditSourceColumns.length && state.offset !== 0)) throw Error('Invalid audit transfer cursor');
}
async function sign(key, payload) { return toHex(await crypto.subtle.sign('HMAC', key, enc.encode(payload))); }
function copyCursor(token) {
  if (!token || typeof token !== 'object' || Array.isArray(token) || Object.keys(token).sort().join(',') !== 'mac,payload') throw Error('Invalid audit transfer cursor');
  // Capture before the first await as well as before MAC verification.
  const payload=token.payload, mac=token.mac;
  if (typeof payload !== 'string' || payload.length > 2048 || !hex(mac,64)) throw Error('Invalid audit transfer cursor');
  return Object.freeze({payload,mac});
}
async function openCursor(key, token, binding) {
  const {payload,mac}=token;
  const signature=Uint8Array.from(mac.match(/../g), x => parseInt(x,16));
  if (!await crypto.subtle.verify('HMAC', key, signature, enc.encode(payload))) throw Error('Invalid audit transfer cursor');
  let state; try { state=JSON.parse(payload); } catch { throw Error('Invalid audit transfer cursor'); }
  if (JSON.stringify(state) !== payload) throw Error('Invalid audit transfer cursor');
  validateState(state,binding); return state;
}

// Return one immutable encoded frame and an HMAC-protected continuation.
// Retries use the same token and receive the same frame if the snapshot is
// immutable. The client must verify every frame, sequence and final digest
// against an independently trusted commitment before publishing a response.
export async function nextShadowAuditFrame(storage,input,reader,use,rowid,authorize,key,token=null) {
  const scope=copyScope(input);
  if (!hex(reader,32) || !hex(use,32) || !validRowID(rowid)) throw Error('Invalid audit transfer scope');
  const cursor=token === null ? null : copyCursor(token);
  const scopeHash=await sha(jsonBytes(['mapi-audit-transfer-scope-v1',scope]));
  const binding={scope:scopeHash,rowid,reader,use};
  const state=cursor === null ? {version:1,...binding,column:0,offset:0,sequence:0,previous:zero} : await openCursor(key,cursor,binding);
  validateState(state,binding);
  if (state.column === auditSourceColumns.length) {
    // Even a terminal continuation must not outlive its route, era or lease.
    withShadowReader(storage,scope,reader,use,authorize,()=>new Uint8Array());
    return {complete:true,sequence:state.sequence,digest:state.previous};
  }
  const read=()=>withShadowReader(storage,scope,reader,use,authorize,()=>readFrame(storage,scopeHash,scope,rowid,state));
  const frame=read();
  const hashInput=new Uint8Array(64+frame.length);
  hashInput.set(enc.encode(state.previous));hashInput.set(frame,64);
  const digest=await sha(hashInput);
  let parsed; try { parsed=JSON.parse(new TextDecoder().decode(frame)); } catch { throw Error('Invalid audit frame'); }
  if (!same(frame,read())) throw Error('Audit snapshot changed');
  const next=nextPosition(state,parsed,digest), payload=JSON.stringify(next), mac=await sign(key,payload);
  // Hashing and signing yield. Reject stale route, lease, era or changed frame
  // before acknowledging; independent nonrollback remains a separate gate.
  if (!same(frame,read())) throw Error('Audit snapshot changed');
  return {frame,digest,next:{payload,mac},complete:false};
}

export const auditTransferFragmentBytes = fragmentBytes;
export const auditTransferInitialDigest = zero;
