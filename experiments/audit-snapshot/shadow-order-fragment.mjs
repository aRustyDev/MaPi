// Private, unmounted building block for an external audit sorter. The caller
// must authenticate the request and keep its sorting state and this capability
// private. Every call rechecks the owner route, recovery era, schema and active
// reader lease. It supplies one bounded ID fragment, not an authorization
// decision, a complete comparison, or a public response.
import { withShadowReader } from './shadow-lifecycle.mjs';

const maxFragment = 32 * 1024;
const min = -(1n << 63n), max = (1n << 63n) - 1n;
const encode = new TextEncoder();

export function readShadowOrderFragment(storage, input, readerId, useId, authorize, handle, offset) {
  // Snapshot the scope and handle before invoking any caller-controlled code.
  // withShadowReader performs its full validation on this detached copy.
  const route=input?.route;
  const scope={id:input?.id,epoch:input?.epoch,principal:input?.principal,request:input?.request,
    route:{projectId:route?.projectId,origin:route?.origin,objectName:route?.objectName,generation:route?.generation}};
  if (typeof handle !== 'string' || handle.length > 20 || !/^(?:0|[1-9][0-9]*|-[1-9][0-9]*)$/.test(handle)) throw Error('Invalid shadow event identifier');
  const rowid=BigInt(handle);
  if (rowid < min || rowid > max || !Number.isSafeInteger(offset) || offset < 0 || offset >= Number.MAX_SAFE_INTEGER) throw Error('Invalid shadow comparison position');
  return withShadowReader(storage,scope,readerId,useId,authorize,()=>{
    const rows=storage.sql.exec(`SELECT typeof(created_at) AS time_kind, CAST(created_at AS TEXT) AS time_value,
        typeof(id) AS id_kind, length(CAST(id AS BLOB)) AS id_length,
        substr(CAST(id AS BLOB), ?, ?) AS fragment
      FROM mapi_shadow_snapshot
      WHERE source_rowid=CAST(? AS INTEGER) AND typeof(project_id)='text' AND project_id COLLATE BINARY=?
      LIMIT 2`, offset+1,maxFragment,handle,scope.route.projectId).toArray();
    const row=rows[0];
    if (rows.length!==1 || row.time_kind!=='integer' || typeof row.time_value!=='string' || row.time_value.length>20 ||
        !/^(?:0|[1-9][0-9]*|-[1-9][0-9]*)$/.test(row.time_value) || !['text','blob'].includes(row.id_kind) ||
        !Number.isSafeInteger(row.id_length) || row.id_length<0 || offset>row.id_length) throw Error('Invalid shadow event ordering value');
    const timestamp=BigInt(row.time_value);
    if(timestamp<min || timestamp>max) throw Error('Invalid shadow event ordering value');
    const raw=row.fragment;
    const fragment=raw instanceof ArrayBuffer ? new Uint8Array(raw) : raw instanceof Uint8Array && ArrayBuffer.isView(raw) ? raw : null;
    const expected=Math.min(maxFragment,row.id_length-offset);
    if(!fragment || fragment.byteLength!==expected) throw Error('Invalid shadow ID fragment');
    const frame={timestamp:row.time_value,idKind:row.id_kind,idLength:row.id_length,offset,
      fragment:Uint8Array.from(fragment).toBase64(),done:offset+expected===row.id_length};
    return encode.encode(JSON.stringify(frame));
  });
}
