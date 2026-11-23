// Drives only the fixed-project, no-route synthetic restart service. Every
// deliberate abort is followed by a new boot ID and a durable stage marker.
import { setTimeout as delay } from 'node:timers/promises';
import { rehearsalManagementRead } from './rehearsal-management.mjs';
import { createRehearsalTraffic, classifyClosure } from './rehearsal-traffic.mjs';
import { drainBounded, jsonBounded } from './rehearsal-body.mjs';
import { requireEnabledProof } from './relocation-rehearsal-enabled-proof.mjs';

const directory = process.argv[2], endpoint = new URL(process.env.MAPI_REHEARSAL_CONTROL_URL ?? '');
const operator = process.env.MAPI_REHEARSAL_OPERATOR_TOKEN, managementToken = process.env.MAPI_REHEARSAL_OTHER_MANAGEMENT_TOKEN;
if (!directory || endpoint.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(endpoint.hostname) || !operator || !managementToken) throw Error('Verified synthetic fixture and loopback control credentials are required');
const { fixture } = await requireEnabledProof(directory);
const traffic = createRehearsalTraffic(fixture);
await traffic.prepare();
const maxTrafficSamples = 8;
let index = 0, reads = 0, trafficSamples = 0, closedSamples = 0;
function log(value) { console.log(JSON.stringify({ at: new Date().toISOString(), ...value })); }
const responseControllers = new WeakMap();
async function request(path) {
  const target = new URL(endpoint); target.pathname = path.split('?')[0]; target.search = path.includes('?') ? '?' + path.split('?')[1] : '';
  const controller = new AbortController();
  const response = await fetch(target, { method: 'POST', headers: { authorization: `Bearer ${operator}` }, redirect: 'error', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(60000)]) });
  responseControllers.set(response, controller);
  return response;
}
const json = r => jsonBounded(r, responseControllers.get(r));
async function concurrently(path, { sample = false } = {}) {
  const controlStarted = performance.now();
  const callPromise = request(path).then(response => ({ response, ended: performance.now() }));
  const [call, management, trafficResult] = await Promise.allSettled([callPromise, rehearsalManagementRead(fixture, managementToken, ++index), sample ? traffic.sample() : Promise.resolve(null)]);
  if (management.status === 'rejected') { if (call.status === 'fulfilled') await drainBounded(call.value.response, responseControllers.get(call.value.response)); log({ kind: 'management-error', name: management.reason?.name, code: management.reason?.cause?.code }); throw Error('Concurrent management read failed'); }
  reads++;
  if (call.status === 'rejected') { log({ kind: 'control-error', name: call.reason?.name, code: call.reason?.cause?.code }); throw Error('Control request failed'); }
  if (trafficResult.status === 'rejected') { await drainBounded(call.value.response, responseControllers.get(call.value.response)); throw trafficResult.reason; }
  if (trafficResult.value) {
    const results = trafficResult.value;
    for (const value of Object.values(results)) if (!(value.started < call.value.ended && controlStarted < value.ended)) { await drainBounded(call.value.response, responseControllers.get(call.value.response)); throw Error('Traffic client request intervals did not overlap the control request'); }
    trafficSamples++;
    return { response: call.value.response, traffic: { timeOriginUtc: new Date(performance.timeOrigin).toISOString(), controlStarted, controlEnded: call.value.ended, results } };
  }
  return { response: call.value.response, traffic: null };
}
async function probe() { const r = await request('/restart-probe'); if (!r.ok) { await drainBounded(r, responseControllers.get(r)); throw Error(`Restart probe returned ${r.status}`); } return json(r); }
async function restart(stage) {
  const before = await probe(), { response: r } = await concurrently(`/restart?stage=${stage}`);
  log({ kind: 'intentional-abort-response', stage, status: r.status });
  await drainBounded(r, responseControllers.get(r));
  if (r.status !== 503) throw Error(`Unexpected abort response ${r.status}`);
  let after;
  for (let n = 0; n < 10; n++) { try { after = await probe(); break; } catch (error) { log({ kind: 'restart-probe-wait', stage, attempt: n + 1, error: String(error) }); await delay(300); } }
  if (!after || after.bootId === before.bootId || after.markers.length !== before.markers.length + 1 || after.markers.at(-1).stage !== stage || after.markers.at(-1).boot_id !== before.bootId) throw Error(`Coordinator restart proof failed at ${stage}`);
  log({ kind: 'restart-proven', stage, beforeBoot: before.bootId, afterBoot: after.bootId, marker: after.markers.at(-1) });
}
await restart('frozen');
let calls = 0, progress, previousPhase = 'frozen';
for (;;) {
  const { response: r, traffic: sample } = await concurrently('/', { sample: calls % 20 === 0 && trafficSamples < maxTrafficSamples && previousPhase !== 'committed' });
  if (!r.ok) { await drainBounded(r, responseControllers.get(r)); log({ kind: 'advance-error', status: r.status }); throw Error(`Advance returned HTTP ${r.status}`); }
  progress = await json(r); calls++; log({ kind: 'advance', calls, managementHttpSuccesses: reads, managementIdentityVerified: reads, ...progress });
  if (sample) {
    const classification = classifyClosure(previousPhase, progress.phase);
    if (classification === 'fenced') closedSamples++;
    log({ kind: 'client-request-overlap', advance: calls, previousPhase, nextPhase: progress.phase, classification, ...sample });
  }
  previousPhase = progress.phase;
  if (progress.phase === 'importing' && progress.nextChunk >= 2 && !(await probe()).markers.some(m => m.stage === 'importing')) await restart('importing');
  if (progress.phase === 'committed') { await restart('committed'); await restart('activated'); }
  if (progress.done) break;
  if (calls >= 1000) throw Error('Advance limit exceeded');
}
if (progress.phase !== 'retired' || progress.generation !== 2 || !closedSamples || !trafficSamples) throw Error('Unexpected completed route or missing traffic overlap');
let cursor = 0, evidencePages = 0; const tables = new Map();
for (;;) {
  const r = await request(`/evidence?after=${cursor}`); if (!r.ok) { await drainBounded(r, responseControllers.get(r)); throw Error('Evidence read failed'); }
  const result = await json(r); if (!result.complete || !Array.isArray(result.pages)) throw Error('Evidence is incomplete');
  for (const page of result.pages) { if (!/^[a-f0-9]{64}$/.test(page.digest) || page.sequence <= cursor) throw Error('Invalid evidence'); cursor = page.sequence; evidencePages++; tables.set(page.table, (tables.get(page.table) ?? 0) + page.count); }
  if (result.next !== cursor) throw Error('Evidence cursor differs');
  if (result.done) break;
  if (!result.pages.length) throw Error('Evidence did not advance');
}
if (tables.get('users') !== 1 || !(tables.get('events') > 0)) throw Error('User or audit reconciliation failed');
const stale = await request('/stale-probe'); if (!stale.ok) { await drainBounded(stale, responseControllers.get(stale)); throw Error('Stale write probe failed'); }
if ((await json(stale)).rejected !== true) throw Error('Stale write not rejected');
log({ kind: 'complete', calls, managementHttpSuccesses: reads, managementIdentityVerified: reads, trafficSamples, closedSamples, maxTrafficSamples, otherSuccessfulLogins: trafficSamples + 1, generation: progress.generation, evidencePages, userCount: tables.get('users'), eventCount: tables.get('events'), staleSourceRejected: true });
