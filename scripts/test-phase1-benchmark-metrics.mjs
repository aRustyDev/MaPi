import assert from 'node:assert/strict';
import { benchmarkOverlapPassed, benchmarkPhaseMetrics } from './phase1-benchmark-metrics.mjs';

const start = { attempts: 4, started: 4, parentSentAtMs: 1000, childReceivedAtMs: 1105, childAcknowledgedAtMs: 1120, parentReceivedAtMs: 1025 };
const signInIntervals = Array.from({ length: 4 }, (_, index) => ({ startedAtMs: 1106 + index, endedAtMs: 1300 + index }));
const operationIntervals = create => [
  { operation: 'get', startedAtMs: 1030, endedAtMs: 1040 },
  { operation: 'query', startedAtMs: 1041, endedAtMs: 1050 },
  { operation: 'get', startedAtMs: 1051, endedAtMs: 1060 },
  { operation: 'query', startedAtMs: 1061, endedAtMs: 1070 },
  ...(create ? [{ operation: 'create', startedAtMs: 1030, endedAtMs: 1050 }, { operation: 'created-get', startedAtMs: 1300, endedAtMs: 1310 }] : []),
];
const waves = Array.from({ length: 5 }, (_, wave) => ({
  starts: [structuredClone(start), structuredClone(start)],
  outcomes: [0, 1].map(project => ({ attempts: 4, failures: wave === 1 && project === 0 ? 1 : wave === 3 && project === 1 ? 2 : 0, signInIntervals: structuredClone(signInIntervals) })),
  management: [0, 1].map(project => ({ attempts: wave === 0 && project === 0 ? 3 : wave === 2 && project === 1 ? 2 : wave === 1 || wave === 3 ? 6 : 4, operations: wave === 0 && project === 0 ? 2 : wave === 2 && project === 1 ? 1 : wave === 1 || wave === 3 ? 6 : 4, expectedAttempts: wave === 1 || wave === 3 ? 6 : 4, operationIntervals: operationIntervals(wave === 1 || wave === 3) })),
}));
const results = [{ result: { measuredJourneys: 19 } }, { result: { measuredJourneys: 18 } }];
const metrics = benchmarkPhaseMetrics(results, waves, 10000, true);
assert.deepEqual(metrics.projects[0], { projectIndex: 0, attemptedMeasuredJourneys: 20, completedMeasuredJourneys: 19, failedMeasuredJourneys: 1, attemptedManagement: 23, completedManagement: 22, expectedManagement: 24, journeysPerSecond: 1.9, managementOperationsPerSecond: 2.2 });
assert.deepEqual(metrics.projects[1], { projectIndex: 1, attemptedMeasuredJourneys: 20, completedMeasuredJourneys: 18, failedMeasuredJourneys: 2, attemptedManagement: 22, completedManagement: 21, expectedManagement: 24, journeysPerSecond: 1.8, managementOperationsPerSecond: 2.1 });
assert.equal(metrics.journeysPerSecond, 3.7);
assert.equal(metrics.managementOperationsPerSecond, 4.3);
assert.throws(() => benchmarkPhaseMetrics([{ result: { measuredJourneys: 20 } }, results[1]], waves, 10000, true), /counts disagree/);
assert.throws(() => benchmarkPhaseMetrics(results, waves, 0, true), /Invalid/);
const overlapWaves = structuredClone(waves);
for (const wave of overlapWaves) for (const management of wave.management) management.attempts = management.operationIntervals.length;
assert.equal(benchmarkOverlapPassed(true, overlapWaves), true);
const zeroDuration = structuredClone(overlapWaves);
zeroDuration[0].management[0].operationIntervals[0].endedAtMs = zeroDuration[0].management[0].operationIntervals[0].startedAtMs;
assert.equal(benchmarkOverlapPassed(true, zeroDuration), false, 'a zero-duration request cannot prove overlap');
const parallelReads = structuredClone(overlapWaves);
parallelReads[0].management[0].operationIntervals[1].startedAtMs = 1035;
assert.equal(benchmarkOverlapPassed(true, parallelReads), false, 'overlapping management reads must not satisfy the serial-read workload');
const reorderedReads = structuredClone(overlapWaves);
reorderedReads[0].management[0].operationIntervals[0].operation = 'query';
reorderedReads[0].management[0].operationIntervals[1].operation = 'get';
assert.equal(benchmarkOverlapPassed(true, reorderedReads), false, 'read operation order must match the planned workload');
const earlyVerification = structuredClone(overlapWaves);
earlyVerification[1].management[0].operationIntervals.at(-1).startedAtMs = 1065;
assert.equal(benchmarkOverlapPassed(true, earlyVerification), false, 'created-user verification must follow the read chain');
const verificationBeforeCreate = structuredClone(overlapWaves);
verificationBeforeCreate[1].management[0].operationIntervals[4].endedAtMs = 1250;
verificationBeforeCreate[1].management[0].operationIntervals[5].startedAtMs = 1200;
assert.equal(benchmarkOverlapPassed(true, verificationBeforeCreate), false, 'created-user verification must follow create completion');
const strayVerification = structuredClone(overlapWaves);
strayVerification[0].management[0].operationIntervals.push({ operation: 'created-get', startedAtMs: 1300, endedAtMs: 1310 });
strayVerification[0].management[0].attempts++;
assert.equal(benchmarkOverlapPassed(true, strayVerification), false, 'verification requires a create in the same wave');
const late = structuredClone(overlapWaves); late[0].management[0].operationIntervals[0] = { operation: 'get', startedAtMs: 1300, endedAtMs: 1310 };
assert.equal(benchmarkOverlapPassed(true, late), false, 'a non-overlapping operation must fail');
const borderline = structuredClone(overlapWaves); borderline[0].management[0].operationIntervals[0] = { operation: 'get', startedAtMs: 1198, endedAtMs: 1200 };
assert.equal(benchmarkOverlapPassed(true, borderline), false, 'apparent overlap inside the clock uncertainty must fail');
const missing = structuredClone(overlapWaves); missing[0].management[1].operationIntervals.pop();
assert.equal(benchmarkOverlapPassed(true, missing), false, 'a missing query must fail');
const wrongProject = structuredClone(overlapWaves); wrongProject[2].outcomes[1].signInIntervals = wrongProject[2].outcomes[1].signInIntervals.map(x => ({ startedAtMs: x.startedAtMs + 1000, endedAtMs: x.endedAtMs + 1000 }));
assert.equal(benchmarkOverlapPassed(true, wrongProject), false, 'another project\'s journey must not establish overlap');
const badClock = structuredClone(overlapWaves); badClock[2].starts[1].childReceivedAtMs = 900;
assert.equal(benchmarkOverlapPassed(true, badClock), false, 'inconsistent IPC clock bounds must fail');
const unstarted = structuredClone(overlapWaves); unstarted[0].starts[0].started = 3;
assert.equal(benchmarkOverlapPassed(true, unstarted), false, 'all browser requests must actually start');
const sequential = structuredClone(overlapWaves);
sequential[0].outcomes[0].signInIntervals = [
  { startedAtMs: 1106, endedAtMs: 1107 }, { startedAtMs: 1107, endedAtMs: 1108 },
  { startedAtMs: 1108, endedAtMs: 1109 }, { startedAtMs: 1109, endedAtMs: 1110 },
];
assert.equal(benchmarkOverlapPassed(true, sequential), false, 'four sequential starts do not prove concurrency four');
const plain = waves.map(wave => ({ ...wave, management: [] }));
assert.equal(benchmarkOverlapPassed(false, plain), true);
assert.equal(benchmarkOverlapPassed(false, sequential.map(wave => ({ ...wave, management: [] }))), false, 'plain waves must also prove concurrency four');
const shiftedChildClock = structuredClone(overlapWaves);
for (const wave of shiftedChildClock) {
  for (const key of ['childReceivedAtMs', 'childAcknowledgedAtMs']) wave.starts[1][key] += 1_000_000;
  wave.outcomes[1].signInIntervals = wave.outcomes[1].signInIntervals.map(item => ({ startedAtMs: item.startedAtMs + 1_000_000, endedAtMs: item.endedAtMs + 1_000_000 }));
}
assert.equal(benchmarkOverlapPassed(true, shiftedChildClock), true, 'a different child clock epoch must not change proven overlap');
const separatedProjects = structuredClone(plain);
for (const wave of separatedProjects) {
  for (const key of ['parentSentAtMs', 'parentReceivedAtMs', 'childReceivedAtMs', 'childAcknowledgedAtMs']) wave.starts[1][key] += 1000;
  wave.outcomes[1].signInIntervals = wave.outcomes[1].signInIntervals.map(item => ({ startedAtMs: item.startedAtMs + 1000, endedAtMs: item.endedAtMs + 1000 }));
}
assert.equal(benchmarkOverlapPassed(false, separatedProjects), false, 'two internally concurrent but non-overlapping projects must fail');
const separatedMixed = structuredClone(overlapWaves);
for (const wave of separatedMixed) {
  for (const key of ['parentSentAtMs', 'parentReceivedAtMs', 'childReceivedAtMs', 'childAcknowledgedAtMs']) wave.starts[1][key] += 1000;
  wave.outcomes[1].signInIntervals = wave.outcomes[1].signInIntervals.map(item => ({ startedAtMs: item.startedAtMs + 1000, endedAtMs: item.endedAtMs + 1000 }));
  wave.management[1].operationIntervals = wave.management[1].operationIntervals.map(item => ({ ...item, startedAtMs: item.startedAtMs + 1000, endedAtMs: item.endedAtMs + 1000 }));
}
assert.equal(benchmarkOverlapPassed(true, separatedMixed), false, 'mixed waves must reject projects that do not overlap each other');
const uncertainProjects = structuredClone(plain);
uncertainProjects[0].starts[1].childAcknowledgedAtMs = 1302;
uncertainProjects[0].starts[1].parentReceivedAtMs = 1205;
uncertainProjects[0].outcomes[1].signInIntervals = Array.from({ length: 4 }, (_, index) => ({ startedAtMs: 1299 + index, endedAtMs: 1400 + index }));
assert.equal(benchmarkOverlapPassed(false, uncertainProjects), false, 'possible cross-project overlap within offset uncertainty must fail');
assert.equal(benchmarkPhaseMetrics(results, plain, 10000, false).managementOperationsPerSecond, 0);
console.log('Per-project throughput counts actual attempts and mixed-wave client overlap is bounded by IPC clock uncertainty.');
