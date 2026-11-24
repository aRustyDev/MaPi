import assert from 'node:assert/strict';
import { benchmarkWorkloadPassed, runBenchmarkManagement } from './phase1-benchmark-management.mjs';

const project = { origin: 'https://synthetic.test', projectId: 'project-a', userId: 'user-a', operator: 'private-operator', managementToken: 'private-token' };
const calls = [];
const fetcher = async (url, options) => {
  calls.push({ path: url.pathname, method: options.method ?? 'GET' });
  assert.equal(options.redirect, 'error');
  if (url.pathname === '/_mapi/admin/users') return Response.json({ userId: 'new-user' });
  if (url.pathname === '/api/v1/users/query') return Response.json({ users: [{ id: 'user-a' }, { id: 'new-user' }] });
  return Response.json({ id: url.pathname.endsWith('/new-user') ? 'new-user' : 'user-a' });
};
const audits = [];
const valid = await runBenchmarkManagement(project, 'user-b', 1, { fetcher, control: async (_project, action, id) => { audits.push({ action, id }); return 1; } });
assert.equal(valid.operations, 6); assert.equal(valid.attempts, 6); assert.equal(valid.expectedAttempts, 6); assert.equal(valid.error, undefined);
assert.equal(valid.auditVerified, true);
assert.equal(valid.operationIntervals.length, 6);
assert.ok(valid.operationIntervals.every(item => Number.isFinite(item.startedAtMs) && item.endedAtMs >= item.startedAtMs));
assert.ok(!JSON.stringify(valid.operationIntervals).includes('private'));
assert.equal(calls.filter(c => c.method === 'POST' && c.path.endsWith('/query')).length, 2);
assert.deepEqual(audits, [{ action: 'user-audit', id: 'new-user' }]);
let inFlightReads = 0, peakReads = 0, createOverlappedRead = false;
const concurrency = await runBenchmarkManagement(project, 'user-b', 1, { fetcher: async (url) => {
  if (url.pathname === '/_mapi/admin/users') {
    createOverlappedRead = inFlightReads > 0;
    await new Promise(resolve => setTimeout(resolve, 5));
    return Response.json({ userId: 'new-user' });
  }
  inFlightReads++; peakReads = Math.max(peakReads, inFlightReads);
  await new Promise(resolve => setTimeout(resolve, 10));
  inFlightReads--;
  if (url.pathname.endsWith('/query')) return Response.json({ users: [{ id: 'user-a' }] });
  return Response.json({ id: url.pathname.endsWith('/new-user') ? 'new-user' : 'user-a' });
}, control: async () => 1 });
assert.equal(concurrency.operations, 6); assert.equal(peakReads, 1, 'only one management read may be in flight per project');
assert.equal(createOverlappedRead, true, 'create write must overlap the regular read chain');
const wrongUser = await runBenchmarkManagement(project, 'user-b', 0, { fetcher: async () => Response.json({ id: 'user-b' }) });
assert.equal(wrongUser.operations, 0); assert.equal(wrongUser.attempts, 1); assert.equal(wrongUser.expectedAttempts, 4); assert.equal(wrongUser.failureCategories[0].operation, 'get-identity');
const wrongQuery = await runBenchmarkManagement(project, 'user-b', 0, { fetcher: async (url) => Response.json(url.pathname.endsWith('/query') ? { users: [{ id: 'user-a' }, { id: 'user-b' }] } : { id: 'user-a' }) });
assert.equal(wrongQuery.operations, 1); assert.equal(wrongQuery.attempts, 2); assert.equal(wrongQuery.failureCategories[0].operation, 'query-identity');
const malformed = await runBenchmarkManagement(project, 'user-b', 0, { fetcher: async () => new Response('private malformed body') });
assert.equal(malformed.attempts, 1); assert.deepEqual(malformed.failureCategories, [{ operation: 'get', kind: 'response', status: 200 }]); assert.ok(!JSON.stringify(malformed).includes('private'));
let cancelled = 0;
const drained = await runBenchmarkManagement(project, 'user-b', 0, { fetcher: async (url) => {
  const data = url.pathname.endsWith('/query') ? { users: [{ id: 'user-a' }] } : { id: 'user-a' };
  return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(JSON.stringify(data))); controller.close(); }, cancel() { cancelled++; } }));
} });
assert.equal(drained.operations, 4); assert.equal(cancelled, 0);
let releaseCreate;
const held = new Promise(resolve => { releaseCreate = resolve; });
let completed = false;
const failed = runBenchmarkManagement(project, 'user-b', 1, { fetcher: async (url) => {
  if (url.pathname === '/_mapi/admin/users') { await held; return Response.json({ userId: 'new-user' }); }
  if (url.pathname.endsWith('/new-user')) return Response.json({ id: 'new-user' });
  return new Response('private response', { status: 429 });
} }).then(value => { completed = true; return value; });
await new Promise(resolve => setTimeout(resolve, 10));
assert.equal(completed, false, 'failure must wait for the concurrent create to settle');
releaseCreate();
const result = await failed;
assert.equal(result.attempts, 3); assert.equal(result.operations, 2); assert.equal(result.expectedAttempts, 6);
assert.equal(result.operationIntervals.length, 3, 'failed requests must retain their attempted interval');
assert.deepEqual(result.failureCategories, [{ operation: 'get', kind: 'http', status: 429 }]);
assert.ok(!JSON.stringify(result).includes('private'));
const bothFail = await runBenchmarkManagement(project, 'user-b', 1, { fetcher: async (url) => new Response(null, { status: url.pathname === '/_mapi/admin/users' ? 503 : 429 }) });
assert.equal(bothFail.attempts, 2); assert.equal(bothFail.operations, 0);
assert.deepEqual(bothFail.failureCategories, [{ operation: 'get', kind: 'http', status: 429 }, { operation: 'create', kind: 'http', status: 503 }]);
const auditFailure = await runBenchmarkManagement(project, 'user-b', 3, { fetcher, control: async () => 0 });
assert.equal(auditFailure.attempts, 6); assert.equal(auditFailure.operations, 6); assert.deepEqual(auditFailure.failureCategories, [{ operation: 'audit', kind: 'invalid', status: null }]);
const auditTimeout = await runBenchmarkManagement(project, 'user-b', 3, { fetcher, control: async () => { const error = new Error('private'); error.phase1Failure = { operation: 'user-audit', kind: 'timeout', status: 503 }; throw error; } });
assert.deepEqual(auditTimeout.failureCategories, [{ operation: 'audit', kind: 'timeout', status: 503 }]);
const noAudit = await runBenchmarkManagement(project, 'user-b', 1, { fetcher });
assert.equal(noAudit.auditVerified, false);
const waves = Array.from({ length: 5 }, (_, wave) => ({ management: Array.from({ length: 2 }, () => wave === 1 || wave === 3 ? { ...valid } : { operations: 4, attempts: 4, expectedAttempts: 4, auditVerified: null }) }));
assert.equal(benchmarkWorkloadPassed(true, waves), true);
waves[1].management[0] = noAudit;
assert.equal(benchmarkWorkloadPassed(true, waves), false, 'a complete workload requires create-audit evidence');
waves[1].management[0] = { ...valid, attempts: 5 };
assert.equal(benchmarkWorkloadPassed(true, waves), false, 'a partial workload cannot pass');
waves[1].management[0] = { operations: 4, attempts: 4, expectedAttempts: 4, auditVerified: true };
assert.equal(benchmarkWorkloadPassed(true, waves), false, 'reported expected count cannot change required workload');
assert.equal(benchmarkWorkloadPassed(false, []), true);
console.log('Benchmark management validates identity, accounts for attempts and settles concurrent failures.');
