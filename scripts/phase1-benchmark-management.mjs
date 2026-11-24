import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { verifyUserAudit } from './phase1-benchmark-control.mjs';
import { requestFailure, requestJson } from './phase1-request.mjs';

// Only the status and operation name are retained on failures; response
// bodies and credentials remain private to the fixture and request.
const failure = operation => requestFailure(operation, 'invalid', null);

export async function runBenchmarkManagement(project, otherUserId, wave, { fetcher = fetch, control } = {}) {
  const start = performance.now();
  const auth = { authorization: `Bearer ${project.managementToken}`, origin: project.origin, 'sec-fetch-site': 'same-origin' };
  const query = `/api/v1/users/query?project_id=${encodeURIComponent(project.projectId)}`;
  const hasCreate = wave === 1 || wave === 3;
  let operations = 0, attempts = 0, auditVerified = false;
  const operationIntervals = [];
  async function request(path, options, operation) {
    attempts++;
    const startedAtMs = performance.timeOrigin + performance.now();
    try { return await requestJson(new URL(path, project.origin), { ...options, redirect: 'error' }, { operation, fetcher }); }
    finally { operationIntervals.push({ operation, startedAtMs, endedAtMs: performance.timeOrigin + performance.now() }); }
  }
  const readOperations = async () => {
    for (let index = 0; index < 4; index++) {
      const isQuery = index % 2 === 1;
      const data = await request(isQuery ? query : `/api/v1/users/${encodeURIComponent(project.userId)}`, {
        method: isQuery ? 'POST' : 'GET', headers: { ...auth, ...(isQuery ? { 'content-type': 'application/json' } : {}) },
        ...(isQuery ? { body: '{}' } : {}),
      }, isQuery ? 'query' : 'get');
      if (isQuery ? !Array.isArray(data?.users) || !data.users.some(user => user?.id === project.userId) || data.users.some(user => user?.id === otherUserId) : data?.id !== project.userId) throw failure(isQuery ? 'query-identity' : 'get-identity');
      operations++;
    }
  };
  const createOperation = async () => {
    if (!hasCreate) return;
    const created = await request('/_mapi/admin/users', { method: 'POST', headers: { authorization: `Bearer ${project.operator}`, 'content-type': 'application/json' }, body: JSON.stringify({ email: `phase1-${randomUUID()}@example.invalid`, password: `Example-${randomUUID()}!` }) }, 'create');
    if (typeof created?.userId !== 'string' || !created.userId || created.userId === otherUserId || created.userId === project.userId) throw failure('create-identity');
    operations++;
    return created.userId;
  };
  // The create write may overlap the regular read chain, but its verification
  // read starts only after that chain settles. Both branches settle even when
  // one fails so the report accounts for all attempted operations.
  const results = await Promise.allSettled([readOperations(), createOperation()]);
  const errors = results.filter(item => item.status === 'rejected').map(item => item.reason?.phase1Failure ?? { operation: 'unknown' });
  if (hasCreate && results[1].status === 'fulfilled') {
    const userId = results[1].value;
    try {
      const found = await request(`/api/v1/users/${encodeURIComponent(userId)}`, { headers: auth }, 'created-get');
      if (found?.id !== userId) throw failure('created-get-identity');
      operations++;
      if (control) {
        try { await verifyUserAudit(control, project, userId); auditVerified = true; }
        catch (error) { throw error?.phase1Failure ? requestFailure('audit', error.phase1Failure.kind, error.phase1Failure.status) : failure('audit'); }
      }
    } catch (error) { errors.push(error?.phase1Failure ?? { operation: 'unknown' }); }
  }
  return { operations, attempts, expectedAttempts: hasCreate ? 6 : 4, auditVerified: hasCreate ? auditVerified : null, operationIntervals, elapsedMs: performance.now() - start, ...(errors.length ? { error: 'management_operation_failed', failureCategories: errors } : {}) };
}

export function benchmarkWorkloadPassed(mixed, waves) {
  if (!mixed) return true;
  return waves.length === 5 && waves.every(({ management }, wave) => {
    const expected = wave === 1 || wave === 3 ? 6 : 4;
    return management.length === 2 && management.every(result => !result.error && result.expectedAttempts === expected && result.attempts === expected && result.operations === expected && (expected !== 6 || result.auditVerified === true));
  });
}
