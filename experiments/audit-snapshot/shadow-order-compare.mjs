// Unmounted diagnostic. The caller must hold one synchronous snapshot
// transaction and independently validate the route, recovery era and lease.
// It orders rows only; it does not implement selection, serialization or auth.
import { compareShadowEventIds } from './shadow-id-compare.mjs';

function timestamp(storage, project, handle) {
  const rows=storage.sql.exec(`SELECT typeof(created_at) AS kind, CAST(created_at AS TEXT) AS value
    FROM mapi_shadow_snapshot
    WHERE source_rowid=CAST(? AS INTEGER) AND typeof(project_id)='text' AND project_id COLLATE BINARY=?
    LIMIT 2`, handle, project).toArray();
  if(rows.length!==1 || rows[0].kind!=='integer' || typeof rows[0].value!=='string' ||
      !/^(?:0|[1-9][0-9]*|-[1-9][0-9]*)$/.test(rows[0].value) || rows[0].value.length>20) {
    throw Error('Invalid shadow event timestamp');
  }
  const result=BigInt(rows[0].value);
  if(result < -(1n<<63n) || result > (1n<<63n)-1n) throw Error('Invalid shadow event timestamp');
  return result;
}

export function compareShadowEvents(storage, project, left, right, direction) {
  if(direction!=='asc' && direction!=='desc') throw Error('Invalid shadow event order');
  // Validate handles before CAST can coerce an invalid value. The shared
  // comparator's bounded ID reads are needed only when timestamps tie.
  const validHandle=value=>typeof value==='string' && value.length<=20 && /^(?:0|[1-9][0-9]*|-[1-9][0-9]*)$/.test(value) && BigInt(value)>=-(1n<<63n) && BigInt(value)<=(1n<<63n)-1n;
  if(typeof project!=='string' || !project || !project.isWellFormed() || !validHandle(left) || !validHandle(right)) throw Error('Invalid shadow comparison scope');
  const a=timestamp(storage,project,left), b=timestamp(storage,project,right);
  const order=a<b?-1:a>b?1:compareShadowEventIds(storage,project,left,right);
  return direction==='desc' ? -order : order;
}
