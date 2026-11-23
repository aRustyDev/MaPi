// Unmounted diagnostic: authenticate bounded verification checkpoints with a
// caller-owned HMAC key, and reconcile an old append against a pinned head.
// The caller must independently authenticate the head, protect the key, and
// prevent modification/deletion of previously scanned frames until completion.
import { copyScope, initialDigest, inspectSpoolHead, maxFrameBytes, readFrameAtHead } from './frames.js';

const enc = new TextEncoder();
const isDigest = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const toHex = bytes => [...new Uint8Array(bytes)].map(x => x.toString(16).padStart(2, '0')).join('');
const fromHex = text => Uint8Array.from(text.match(/../g), byte => parseInt(byte, 16));
const json = value => enc.encode(JSON.stringify(value));

function snapshotAnchor(anchor) {
  if (!anchor || typeof anchor !== 'object') throw Error('Invalid trusted head');
  const value = { state:anchor.state, frame_count:anchor.frame_count, total_bytes:anchor.total_bytes, digest:anchor.digest };
  if (!['building','sealed'].includes(value.state) || !Number.isSafeInteger(value.frame_count) || value.frame_count < 1 ||
      !Number.isSafeInteger(value.total_bytes) || value.total_bytes < value.frame_count ||
      Math.ceil(value.total_bytes / maxFrameBytes) > value.frame_count || !isDigest(value.digest)) throw Error('Invalid trusted head');
  return Object.freeze(value);
}
function anchorEquals(a, b) {
  return a.state === b.state && a.frame_count === b.frame_count && a.total_bytes === b.total_bytes && a.digest === b.digest;
}
function identity(scope) {
  return [scope.id, scope.principal, scope.request, scope.epoch, scope.route.projectId,
    scope.route.origin, scope.route.objectName, scope.route.generation];
}
function payload(scope, anchor, state) {
  return ['mapi-audit-replay-v1', identity(scope), [anchor.state, anchor.frame_count, anchor.total_bytes, anchor.digest],
    state.target, state.expected, state.next, state.previous, state.bytes, state.matched];
}
async function mac(key, body) { return toHex(await crypto.subtle.sign('HMAC', key, json(body))); }
async function readState(key, scope, anchor, token) {
  if (!token || typeof token !== 'object') throw Error('Invalid replay checkpoint');
  const b = token.body, signature = token.mac;
  if (!Array.isArray(b) || b.length !== 9 || !isDigest(signature)) throw Error('Invalid replay checkpoint');
  // Copy only bounded primitives before asynchronous verification.
  const state = { target:b[3], expected:b[4], next:b[5], previous:b[6], bytes:b[7], matched:b[8] };
  if (!Number.isSafeInteger(state.target) || state.target < 0 || state.target >= anchor.frame_count || !isDigest(state.expected) ||
      !Number.isSafeInteger(state.next) || state.next < 0 || state.next > anchor.frame_count || !isDigest(state.previous) ||
      !Number.isSafeInteger(state.bytes) || state.bytes < 0 || state.bytes > anchor.total_bytes || typeof state.matched !== 'boolean' ||
      (state.next === 0 && (state.previous !== initialDigest || state.bytes !== 0 || state.matched)) ||
      (state.next <= state.target && state.matched)) throw Error('Invalid replay checkpoint');
  const body = payload(scope, anchor, state);
  // Strictly bind to the original received identity and anchor as well as the
  // normalized fields, without retaining attacker-controlled objects.
  const equalArray = (a, expected) => Array.isArray(a) && a.length === expected.length && expected.every((value, i) => a[i] === value);
  if (b[0] !== body[0] || !equalArray(b[1], body[1]) || !equalArray(b[2], body[2]) ||
      !await crypto.subtle.verify('HMAC', key, fromHex(signature), json(body))) throw Error('Invalid replay checkpoint');
  return state;
}
async function issue(key, scope, anchor, state) {
  const body = payload(scope, anchor, state);
  return { body, mac:await mac(key, body) };
}
function recheck(storage, scope, authorize, anchor) {
  if (!anchorEquals(inspectSpoolHead(storage, scope, authorize), anchor)) throw Error('Snapshot head changed');
}

export async function beginHistoricalReplay(storage, scope, authorize, trustedHead, key, target, data) {
  scope = copyScope(scope);
  const anchor = snapshotAnchor(trustedHead);
  if (!Number.isSafeInteger(target) || target < 0 || target >= anchor.frame_count || !(data instanceof Uint8Array) ||
      data.length < 1 || data.length > maxFrameBytes) throw Error('Invalid replay request');
  const bytes = new Uint8Array(data);
  recheck(storage, scope, authorize, anchor);
  const expected = toHex(await crypto.subtle.digest('SHA-256', bytes));
  const token = await issue(key, scope, anchor, { target, expected, next:0, previous:initialDigest, bytes:0, matched:false });
  recheck(storage, scope, authorize, anchor);
  return token;
}

export async function advanceHistoricalReplay(storage, scope, authorize, trustedHead, key, token, maxFrames) {
  scope = copyScope(scope);
  const anchor = snapshotAnchor(trustedHead);
  if (!Number.isSafeInteger(maxFrames) || maxFrames < 1 || maxFrames > 4) throw Error('Invalid replay batch');
  const state = await readState(key, scope, anchor, token);
  recheck(storage, scope, authorize, anchor);
  for (let step = 0; step < maxFrames && state.next < anchor.frame_count; step++) {
    const f = await readFrameAtHead(storage, scope, authorize, anchor, state.next, state.previous);
    if (state.next === state.target) {
      const hash = toHex(await crypto.subtle.digest('SHA-256', f.data));
      if (hash !== state.expected) throw Error('Conflicting historical snapshot replay');
      state.matched = true;
    }
    state.next++;
    state.previous = f.digest;
    state.bytes += f.data.length;
    if (!Number.isSafeInteger(state.bytes) || state.bytes > anchor.total_bytes) throw Error('Snapshot byte count differs');
  }
  const complete = state.next === anchor.frame_count;
  if (complete && (!state.matched || state.previous !== anchor.digest || state.bytes !== anchor.total_bytes)) throw Error('Snapshot history differs');
  const next = await issue(key, scope, anchor, state);
  recheck(storage, scope, authorize, anchor);
  return { complete, checkpoint:next, ...(complete ? { index:state.target, replayed:true } : {}) };
}
