import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createRpOperations } from './phase1-rp-operations.mjs';

const tracker = createRpOperations({ settleTimeoutMs: 500 });
const upstream = createServer((request, response) => {
  if (request.url === '/slow') return setTimeout(() => { if (!response.destroyed) response.end('{}'); }, 200);
  if (request.url === '/failed') { response.writeHead(503); response.end('private-response-body'); return; }
  response.end('{}');
});
upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
const upstreamOrigin = `http://127.0.0.1:${upstream.address().port}`;
let markSlowStarted;
const slowStarted = new Promise(resolve => { markSlowStarted = resolve; });
const rp = createServer(async (request, response) => {
  const state = new URL(request.url, 'http://localhost').searchParams.get('state');
  let signal;
  try {
    signal = tracker.begin(state);
    if (state === 'slow') markSlowStarted();
    const result = await fetch(`${upstreamOrigin}/${state}`, { signal });
    if (!result.ok) { const status = result.status; await result.arrayBuffer(); const error = new Error('private'); error.phase1RpFailure = { stage: 'token', kind: 'http', status }; throw error; }
    await result.arrayBuffer(); tracker.complete(state); response.end('ok');
  } catch (error) {
    tracker.complete(state, signal?.aborted ? { stage: 'token', kind: 'timeout', status: null } : error.phase1RpFailure ?? { stage: 'token', kind: 'internal', status: null });
    if (!response.destroyed) { response.writeHead(500); response.end('failed'); }
  }
});
rp.listen(0, '127.0.0.1'); await once(rp, 'listening');
try {
  for (const state of ['slow', 'failed', 'ok']) tracker.register(state);
  const origin = `http://127.0.0.1:${rp.address().port}`;
  const attempts = ['slow', 'failed', 'ok'].map(state => fetch(`${origin}/callback?state=${state}`));
  await slowStarted;
  const slow = await tracker.finish('slow', { abort: true, reason: 'timeout' });
  const responses = await Promise.all(attempts);
  assert.deepEqual(responses.map(value => value.status), [500, 500, 200]);
  const failed = await tracker.finish('failed'), ok = await tracker.finish('ok');
  assert.deepEqual(slow, { stage: 'token', kind: 'timeout', status: null });
  assert.deepEqual(failed, { stage: 'token', kind: 'http', status: 503 });
  assert.equal(ok, null); assert.equal(tracker.size(), 0);
  assert.ok(!JSON.stringify([slow, failed, ok]).includes('private'));
  console.log('Delayed concurrent local RP callbacks settle on abort and retain scoped status.');
} finally {
  rp.closeAllConnections(); upstream.closeAllConnections();
  await Promise.all([new Promise(done => rp.close(done)), new Promise(done => upstream.close(done))]);
}
