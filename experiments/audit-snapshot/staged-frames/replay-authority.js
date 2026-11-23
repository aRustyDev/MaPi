// Unmounted diagnostic. The caller supplies an independently administered,
// monotonic authority and configures each job for exactly one snapshot scope.
// A mutable or rollbackable authority cannot provide these guarantees.
import { beginHistoricalReplay, advanceHistoricalReplay } from './verified-replay.js';
import { copyScope, inspectSpoolHead } from './frames.js';

function copyAnchor(value) {
  if (!value || typeof value !== 'object') throw Error('Invalid trusted head');
  return Object.freeze({state:value.state,frame_count:value.frame_count,total_bytes:value.total_bytes,digest:value.digest});
}
function recheckHead(storage, scope, authorize, anchor) {
  const head=inspectSpoolHead(storage,scope,authorize);
  if (head.state !== anchor.state || head.frame_count !== anchor.frame_count || head.total_bytes !== anchor.total_bytes || head.digest !== anchor.digest) throw Error('Snapshot head changed');
}

function validAuthority(authority, job) {
  if (!authority || typeof authority.read !== 'function' || typeof authority.create !== 'function' ||
      typeof authority.compareAndSwap !== 'function' || typeof job !== 'string' || !/^[0-9a-f]{32}$/.test(job)) throw Error('Replay authority required');
}
function sameToken(a, b) {
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object' ||
      typeof a.mac !== 'string' || !/^[0-9a-f]{64}$/.test(a.mac) || a.mac !== b.mac ||
      !Array.isArray(a.body) || !Array.isArray(b.body) || a.body.length !== 9 || b.body.length !== 9) return false;
  const sameArray = (x,y) => Array.isArray(x) && Array.isArray(y) && x.length === y.length && x.length <= 8 && Array.from({length:x.length},(_,index) => x[index] === y[index]).every(Boolean);
  return a.body[0] === b.body[0] && sameArray(a.body[1],b.body[1]) && sameArray(a.body[2],b.body[2]) &&
    Array.from({length:6},(_,index) => a.body[index+3] === b.body[index+3]).every(Boolean);
}
function copyToken(token) {
  if (!token || typeof token !== 'object') throw Error('Invalid replay checkpoint');
  const source = token.body, signature = token.mac;
  if (!Array.isArray(source) || source.length !== 9 || typeof signature !== 'string' || !/^[0-9a-f]{64}$/.test(signature)) throw Error('Invalid replay checkpoint');
  const identity=source[1], anchor=source[2];
  if (!Array.isArray(identity) || identity.length !== 8 || !Array.isArray(anchor) || anchor.length !== 4) throw Error('Invalid replay checkpoint');
  const i=Array.from({length:8},(_,index)=>identity[index]), a=Array.from({length:4},(_,index)=>anchor[index]);
  if (i.some(x => typeof x !== 'string' && typeof x !== 'number') || a.some(x => typeof x !== 'string' && typeof x !== 'number') ||
      i.some(x => typeof x === 'string' && x.length > 4096) || a.some(x => typeof x === 'string' && x.length > 64)) throw Error('Invalid replay checkpoint');
  const body=[source[0],Object.freeze(i),Object.freeze(a),source[3],source[4],source[5],source[6],source[7],source[8]];
  if (body[0] !== 'mapi-audit-replay-v1' || !Number.isSafeInteger(body[3]) || typeof body[4] !== 'string' || body[4].length !== 64 ||
      !Number.isSafeInteger(body[5]) || typeof body[6] !== 'string' || body[6].length !== 64 || !Number.isSafeInteger(body[7]) || typeof body[8] !== 'boolean') throw Error('Invalid replay checkpoint');
  return Object.freeze({body:Object.freeze(body),mac:signature});
}
async function current(authority, job, expected) {
  if (!sameToken(await authority.read(job), expected)) throw Error('Replay authority changed');
}

export async function beginAuthoritativeReplay(storage, scope, authorize, anchor, key, target, data, authority, job) {
  validAuthority(authority, job);
  scope=copyScope(scope); anchor=copyAnchor(anchor);
  const first = copyToken(await beginHistoricalReplay(storage, scope, authorize, anchor, key, target, data));
  // Resolve a lost create acknowledgement only through the authority's read.
  let failure;
  try { await authority.create(job, first); } catch (error) { failure = error; }
  try { await current(authority, job, first); } catch (error) { throw failure ?? error; }
  recheckHead(storage,scope,authorize,anchor);
  return first;
}

export async function advanceAuthoritativeReplay(storage, scope, authorize, anchor, key, expected, maxFrames, authority, job) {
  validAuthority(authority, job);
  scope=copyScope(scope); anchor=copyAnchor(anchor);
  expected = copyToken(expected);
  await current(authority, job, expected);
  const result = await advanceHistoricalReplay(storage, scope, authorize, anchor, key, expected, maxFrames);
  result.checkpoint = copyToken(result.checkpoint);
  // A terminal checkpoint is immutable; it need not create a new revision.
  if (sameToken(expected, result.checkpoint)) { await current(authority, job, expected); recheckHead(storage,scope,authorize,anchor); return result; }
  let failure;
  try { await authority.compareAndSwap(job, expected, result.checkpoint); } catch (error) { failure = error; }
  try { await current(authority, job, result.checkpoint); } catch (error) { throw failure ?? error; }
  recheckHead(storage,scope,authorize,anchor);
  return result;
}
