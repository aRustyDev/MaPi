import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { assertNoUnexpectedHttp, assertRuntimeStatus, benchmarkCompletion, classifyJourneyFailure, persistBenchmarkReport, recordUnexpectedHttp, unexpectedHttpSummary } from './phase1-benchmark-report.mjs';
const error = new Error('Timeout while handling private-secret');
error.phase1Stage = 'oauth_continue';
error.phase1HttpFailure = { group: 'flow', status: 503 };
const failure = classifyJourneyFailure(error);
assert.deepEqual(failure, { category: 'browser_timeout', stage: 'oauth_continue', lastHttpFailure: { group: 'flow', status: 503 }, unexpectedHttp: [], rpFailure: null, browserFailure: null });
const counts = new Map();
recordUnexpectedHttp(counts, '/__nextgen/flows/private-value', 429);
recordUnexpectedHttp(counts, '/__nextgen/flows/private-value', 429);
recordUnexpectedHttp(counts, '/oauth/project-private/authorize', 503);
recordUnexpectedHttp(counts, '/asset', 200);
const observed = unexpectedHttpSummary(counts);
assert.deepEqual(observed, [{ group: 'flow', status: 429, count: 2 }, { group: 'oauth', status: 503, count: 1 }]);
assert.ok(!JSON.stringify(observed).includes('private'));
recordUnexpectedHttp(counts, '/callback?private', 500, 'rp');
assert.deepEqual(unexpectedHttpSummary(counts).at(-1), { group: 'rp', status: 500, count: 1 });
assert.throws(() => assertNoUnexpectedHttp(counts), /Unexpected browser HTTP/);
assert.doesNotThrow(() => assertNoUnexpectedHttp(new Map()));
const status = { ready: true, fenceReady: true, recoveryReady: true, bootId: 'boot', reactorInitializations: 1, wasmMemoryBytes: 65536, wasmHighWaterBytes: 131072, wasmHighWaterPages: 2 };
assert.doesNotThrow(() => assertRuntimeStatus(status));
for (const key of Object.keys(status)) assert.throws(() => assertRuntimeStatus({ ...status, [key]: null }), /status evidence/);
const directory = await mkdtemp(resolve(tmpdir(), 'mapi-phase1-report-'));
try {
  const path = resolve(directory, 'report.json');
  const report = { plain: { projects: [{ measuredJourneys: 20 }], failures: 0 } };
  await persistBenchmarkReport(path, report);
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), report);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  report.failure = 'benchmark_incomplete';
  await persistBenchmarkReport(path, report);
  assert.equal(JSON.parse(await readFile(path, 'utf8')).plain.projects[0].measuredJourneys, 20);
  assert.ok(!JSON.stringify(failure).includes('private-secret'));
} finally { await rm(directory, { recursive: true, force: true }); }
const start = { attempts: 4, started: 4, parentSentAtMs: 1000, childReceivedAtMs: 1105, childAcknowledgedAtMs: 1120, parentReceivedAtMs: 1025 };
const managementIntervals = create => [
  { operation: 'get', startedAtMs: 1030, endedAtMs: 1040 },
  { operation: 'query', startedAtMs: 1041, endedAtMs: 1050 },
  { operation: 'get', startedAtMs: 1051, endedAtMs: 1060 },
  { operation: 'query', startedAtMs: 1061, endedAtMs: 1070 },
  ...(create ? [{ operation: 'create', startedAtMs: 1030, endedAtMs: 1050 }, { operation: 'created-get', startedAtMs: 1300, endedAtMs: 1310 }] : []),
];
const passedPhase = mixed => ({
  mixed, complete: true, failures: 0, elapsedMs: 10000, latencyPass: true, workloadPass: true, overlapPass: true,
  ready: Array.from({ length: 2 }, () => ({ first: { result: { signInMs: 204, journeyMs: 300 } }, warmup: { result: { signInMs: 204, journeyMs: 300 } } })),
  projects: Array.from({ length: 2 }, () => ({ measuredJourneys: 20, signInSamplesMs: Array(20).fill(204), signInP95Ms: 204, journeySamplesMs: Array(20).fill(300), journeyP95Ms: 300, replayAttempts: 22, replayRejections: 22 })),
  signInP95ByProject: [204, 204],
  waves: Array.from({ length: 5 }, (_, wave) => ({
    wave, complete: true, intendedJourneys: 8, starts: [structuredClone(start), structuredClone(start)],
    outcomes: Array.from({ length: 2 }, () => ({ wave, attempts: 4, failures: 0, failureCategories: [],
      latencyIntervals: Array.from({ length: 4 }, (_, i) => ({ startedAtMs: 1096 + i, endedAtMs: 1300 + i })),
      signInIntervals: Array.from({ length: 4 }, (_, i) => ({ startedAtMs: 1106 + i, endedAtMs: 1300 + i })) })),
    management: mixed ? Array.from({ length: 2 }, () => ({ attempts: wave === 1 || wave === 3 ? 6 : 4,
      operations: wave === 1 || wave === 3 ? 6 : 4, expectedAttempts: wave === 1 || wave === 3 ? 6 : 4,
      auditVerified: wave === 1 || wave === 3 ? true : null, operationIntervals: managementIntervals(wave === 1 || wave === 3) })) : [],
  })),
});
const completedTraffic = { plain: passedPhase(false), mixed: passedPhase(true), pendingEvidence: ['cold', 'platform', 'startup'] };
assert.deepEqual(benchmarkCompletion(completedTraffic), { trafficPass: true, phase1Pass: false, exitCode: 1 });
const explicitEmptyManagementFailures = structuredClone(completedTraffic);
explicitEmptyManagementFailures.mixed.waves[0].management[0].failureCategories = [];
assert.equal(benchmarkCompletion(explicitEmptyManagementFailures).trafficPass, true);
for (const name of ['plain', 'mixed']) for (const field of ['complete', 'latencyPass', 'workloadPass', 'overlapPass']) {
  const report = structuredClone(completedTraffic); report[name][field] = null;
  assert.deepEqual(benchmarkCompletion(report), { trafficPass: false, phase1Pass: false, exitCode: 1 });
}
for (const bad of [1, null, undefined, '0']) {
  const report = structuredClone(completedTraffic); report.mixed.failures = bad;
  assert.equal(benchmarkCompletion(report).trafficPass, false);
}
assert.deepEqual(benchmarkCompletion({ ...completedTraffic, pendingEvidence: [], phase1EvidenceVerified: true }), { trafficPass: true, phase1Pass: false, exitCode: 1 });
assert.deepEqual(benchmarkCompletion({}), { trafficPass: false, phase1Pass: false, exitCode: 1 });
assert.equal(benchmarkCompletion({ plain: { complete: true, failures: 0, latencyPass: true, workloadPass: true, overlapPass: true }, mixed: { complete: true, failures: 0, latencyPass: true, workloadPass: true, overlapPass: true } }).trafficPass, false);
for (const mutate of [
  report => { report.plain.projects.pop(); },
  report => { delete report.plain.projects[0]; },
  report => { report.mixed.waves.pop(); },
  report => { report.mixed.waves[0].management.pop(); },
  report => { report.plain.projects[0].signInSamplesMs[0] = null; },
  report => { delete report.plain.projects[0].journeySamplesMs; },
  report => { delete report.plain.projects[0].journeySamplesMs[0]; },
  report => { report.plain.projects[0].journeySamplesMs[0] = 203; },
  report => { report.plain.projects[0].journeyP95Ms = 301; },
  report => { report.mixed.ready[0].warmup.result.journeyMs = 203; },
  report => { report.plain.waves[0].outcomes[0].latencyIntervals[0].endedAtMs++; },
  report => { report.mixed.ready[0].first = { failure: {} }; },
  report => { report.mixed.signInP95ByProject[0] = 0; },
  report => { report.plain.mixed = true; },
  report => { report.plain.waves[0].outcomes[0].failureCategories = [{}]; },
  report => { report.plain.waves[0].outcomes[0].failureCategories = null; },
  report => { delete report.plain.waves[0].outcomes[0].failureCategories; },
  report => { report.mixed.waves[0].management[0].failureCategories = [{}]; },
  report => { report.mixed.waves[0].management[0].failureCategories = 'failed'; },
  report => { report.mixed.waves[0].management[0].error = null; },
  report => { report.plain.projects[0].replayAttempts = 21; },
  report => { report.mixed.projects[1].replayRejections = 21; },
  report => { delete report.plain.projects[1].replayRejections; },
]) {
  const report = structuredClone(completedTraffic); mutate(report);
  assert.equal(benchmarkCompletion(report).trafficPass, false);
}
console.log('Benchmark report retains completed phases and redacts journey failures.');
