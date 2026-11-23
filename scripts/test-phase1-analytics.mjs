import assert from 'node:assert/strict';
import { utcMillis, validateAnalyticsGroups } from './phase1-analytics-validation.mjs';
const original = { argv: process.argv, fetch: globalThis.fetch, log: console.log, account: process.env.CLOUDFLARE_ACCOUNT_ID, token: process.env.CLOUDFLARE_API_TOKEN };
const account = 'a'.repeat(32), namespace = 'b'.repeat(32), object = 'c'.repeat(64);
const start = utcMillis('2026-11-19T10:00:00Z'), end = utcMillis('2026-11-19T10:05:00Z');
const periodic = { count: 1, dimensions: { datetime: '2026-11-19T10:01:00Z', namespaceId: namespace, objectId: object }, sum: { cpuTime: 42, exceededCpuErrors: 0, exceededMemoryErrors: 0 }, max: { memoryUsageBytes: 100 }, secret: 'private-token' };
const invocation = { dimensions: { ...periodic.dimensions, status: 'success' }, sum: { requests: 2, errors: 0, wallTime: 10 } };
const wrap = (periodicRows, invocationRows) => ({ viewer: { accounts: [{ durableObjectsPeriodicGroups: periodicRows, durableObjectsInvocationsAdaptiveGroups: invocationRows }] } });
const valid = validateAnalyticsGroups(wrap([periodic], [invocation]), namespace, object, start, end);
assert.deepEqual(valid.atResultLimit, { periodic: false, invocations: false });
assert.ok(!JSON.stringify(valid).includes('private-token'));
for (const bad of [
  { ...periodic, dimensions: { ...periodic.dimensions, objectId: 'd'.repeat(64) } },
  { ...periodic, dimensions: { ...periodic.dimensions, namespaceId: 'd'.repeat(32) } },
  { ...periodic, dimensions: { ...periodic.dimensions, datetime: '2026-11-19T10:05:00Z' } },
  { ...periodic, dimensions: { ...periodic.dimensions, datetime: '2026-11-19T10:01:00' } },
  { ...periodic, sum: { ...periodic.sum, exceededCpuErrors: -1 } },
  { ...periodic, max: {} },
]) assert.throws(() => validateAnalyticsGroups(wrap([bad], []), namespace, object, start, end));
assert.throws(() => validateAnalyticsGroups({ viewer: { accounts: [] } }, namespace, object, start, end));
assert.throws(() => validateAnalyticsGroups({ viewer: { accounts: [{}, {}] } }, namespace, object, start, end));
assert.equal(validateAnalyticsGroups(wrap([{ ...periodic, max: { memoryUsageBytes: null } }], []), namespace, object, start, end).periodic[0].max.memoryUsageBytes, null);
assert.throws(() => validateAnalyticsGroups(wrap([], [{ ...invocation, dimensions: { ...invocation.dimensions, status: 'bad status' } }]), namespace, object, start, end));
assert.equal(validateAnalyticsGroups(wrap(Array(10000).fill(periodic), []), namespace, object, start, end).atResultLimit.periodic, true);
assert.throws(() => validateAnalyticsGroups(wrap(Array(10001).fill(periodic), []), namespace, object, start, end));
assert.equal(utcMillis('2026-02-30T10:00:00Z'), NaN);
assert.equal(utcMillis('2026-11-19T10:00:00'), NaN);
let calls = 0, output;
try {
  process.argv = ['node', 'collector', '2026-11-19T10:00:00Z', '2026-11-19T10:05:00Z', namespace, object];
  process.env.CLOUDFLARE_ACCOUNT_ID = account;
  process.env.CLOUDFLARE_API_TOKEN = 'private-token';
  console.log = value => { output = JSON.parse(value); };
  globalThis.fetch = async (_url, options) => {
    calls++;
    assert.equal(options.headers.authorization, 'Bearer private-token');
    assert.equal(options.redirect, 'error');
    assert.ok(options.signal instanceof AbortSignal);
    const request = JSON.parse(options.body);
    if (calls === 1) {
      const inputFields = ['datetime_geq', 'datetime_lt', 'namespaceId', 'objectId'].map(name => ({ name }));
      return Response.json({ data: { periodic: { inputFields }, invocation: { inputFields } } });
    }
    assert.equal(request.variables.account, account);
    assert.equal(request.variables.periodic.namespaceId, namespace);
    assert.equal(request.variables.periodic.objectId, object);
    return Response.json({ data: wrap([periodic], [invocation]) });
  };
  await import('./collect-phase1-analytics.mjs');
  assert.equal(calls, 2);
  assert.equal(output.results[0].periodic[0].max.memoryUsageBytes, 100);
  assert.ok(!JSON.stringify(output).includes('private-token'));
  process.env.CLOUDFLARE_API_TOKEN = 'privateToken';
  calls = 0;
  globalThis.fetch = async () => {
    calls++;
    if (calls === 1) {
      const inputFields = ['datetime_geq', 'datetime_lt', 'namespaceId', 'objectId'].map(name => ({ name }));
      return Response.json({ data: { periodic: { inputFields }, invocation: { inputFields } } });
    }
    return Response.json({ data: wrap([], [{ ...invocation, dimensions: { ...invocation.dimensions, status: 'privateToken' } }]) });
  };
  await assert.rejects(import('./collect-phase1-analytics.mjs?credential-output-test'), /Analytics output contains credential/);
  calls = 0;
  process.argv.push(object.toUpperCase());
  await assert.rejects(import('./collect-phase1-analytics.mjs?duplicate-object-test'), /Invalid account, namespace, object ID, or UTC interval/);
  assert.equal(calls, 0);
} finally {
  process.argv = original.argv;
  globalThis.fetch = original.fetch;
  console.log = original.log;
  if (original.account === undefined) delete process.env.CLOUDFLARE_ACCOUNT_ID; else process.env.CLOUDFLARE_ACCOUNT_ID = original.account;
  if (original.token === undefined) delete process.env.CLOUDFLARE_API_TOKEN; else process.env.CLOUDFLARE_API_TOKEN = original.token;
}
console.log('Analytics collection scopes object metrics and excludes the API credential.');
