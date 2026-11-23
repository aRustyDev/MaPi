import assert from 'node:assert/strict';
import { benchmarkJourneyP95, benchmarkSignInP95, benchmarkSamplesMatchWaves, benchmarkLatencyPassed } from './phase1-benchmark-metrics.mjs';

const samples = Array.from({ length: 20 }, (_, index) => (20 - index) * 100);
const result = { measuredJourneys: 20, signInSamplesMs: samples, signInP95Ms: 1900 };
assert.equal(benchmarkSignInP95(result), 1900);
assert.deepEqual(samples, Array.from({ length: 20 }, (_, index) => (20 - index) * 100));
for (const bad of [null, -1, 0, NaN, Infinity, '100', undefined]) {
  const altered = [...samples]; altered[0] = bad;
  assert.equal(benchmarkSignInP95({ ...result, signInSamplesMs: altered }), null);
}
const sparse = [...samples]; delete sparse[0];
assert.equal(benchmarkSignInP95({ ...result, signInSamplesMs: sparse }), null);
for (const altered of [samples.slice(1), [...samples, 1], null, undefined]) {
  assert.equal(benchmarkSignInP95({ ...result, signInSamplesMs: altered }), null);
}
for (const reported of [null, -1, NaN, Infinity, '1900', 1800, 2000]) {
  assert.equal(benchmarkSignInP95({ ...result, signInP95Ms: reported }), null);
}
assert.equal(benchmarkSignInP95({ ...result, measuredJourneys: 19 }), null);
assert.equal(benchmarkSignInP95({ measuredJourneys: 20, signInP95Ms: 0 }), null);
const journeySamples = samples.map(value => value + 30);
const fullJourney = { ...result, journeySamplesMs: journeySamples, journeyP95Ms: 1930 };
assert.equal(benchmarkJourneyP95(fullJourney), 1930);
for (const bad of [null, -1, 0, NaN, Infinity, '100', undefined]) {
  const altered = [...journeySamples]; altered[0] = bad;
  assert.equal(benchmarkJourneyP95({ ...fullJourney, journeySamplesMs: altered }), null);
}
const sparseJourney = [...journeySamples]; delete sparseJourney[0];
assert.equal(benchmarkJourneyP95({ ...fullJourney, journeySamplesMs: sparseJourney }), null);
assert.equal(benchmarkJourneyP95({ ...fullJourney, journeySamplesMs: journeySamples.slice(1) }), null);
assert.equal(benchmarkJourneyP95({ ...fullJourney, journeyP95Ms: 2030 }), null);
const shorterJourney = [...journeySamples]; shorterJourney[0] = samples[0] - 1;
assert.equal(benchmarkJourneyP95({ ...fullJourney, journeySamplesMs: shorterJourney }), null);
assert.equal(benchmarkJourneyP95({ ...fullJourney, signInP95Ms: null }), null);
assert.equal(benchmarkLatencyPassed([3500, 3500], 0), true);
assert.equal(benchmarkLatencyPassed([3500, 3500.001], 0), false);
assert.equal(benchmarkLatencyPassed([3500.001, 3500], 0), false);
for (const invalid of [null, -1, 0, NaN, Infinity, '1']) {
  assert.equal(benchmarkLatencyPassed([100, invalid], 0), false);
}
assert.equal(benchmarkLatencyPassed([100, 100], 1), false);
assert.equal(benchmarkLatencyPassed([100], 0), false);
assert.equal(benchmarkLatencyPassed([100, 100, 100], 0), false);
assert.equal(benchmarkLatencyPassed(Array(2), 0), false);
const waves = Array.from({ length: 5 }, (_, wave) => ({
  wave,
  outcomes: Array.from({ length: 2 }, (_, project) => ({
    wave, attempts: 4, failures: 0,
    latencyIntervals: Array.from({ length: 4 }, (_, i) => {
      const startedAtMs = 1700000000000 + wave * 10000 + project * 100 + i * 2000;
      return { startedAtMs, endedAtMs: startedAtMs + samples[wave * 4 + i] };
    }),
    signInIntervals: Array.from({ length: 4 }, (_, i) => {
      const startedAtMs = 1700000000000 + wave * 10000 + project * 100 + i * 2000;
      return { startedAtMs: startedAtMs + 20, endedAtMs: startedAtMs + samples[wave * 4 + i] };
    }),
  })),
}));
for (const project of [0, 1]) assert.equal(benchmarkSamplesMatchWaves(result, waves, project), true);
const reordered = structuredClone(waves);
reordered[0].outcomes[0].latencyIntervals.reverse();
assert.equal(benchmarkSamplesMatchWaves(result, reordered, 0), false);
const reversedSamples = { ...result, signInSamplesMs: [...samples].reverse() };
assert.equal(benchmarkSamplesMatchWaves(reversedSamples, waves, 0), false);
const missingWave = structuredClone(waves); missingWave[1].outcomes[0].latencyIntervals.pop();
assert.equal(benchmarkSamplesMatchWaves(result, missingWave, 0), false);
const sparseIntervals = structuredClone(waves); delete sparseIntervals[0].outcomes[0].latencyIntervals[0];
assert.equal(benchmarkSamplesMatchWaves(result, sparseIntervals, 0), false);
const wrongCallback = structuredClone(waves); wrongCallback[0].outcomes[0].latencyIntervals[0].endedAtMs += 1;
assert.equal(benchmarkSamplesMatchWaves(result, wrongCallback, 0), false);
const prematureRequest = structuredClone(waves); prematureRequest[0].outcomes[0].signInIntervals[0].startedAtMs -= 30;
assert.equal(benchmarkSamplesMatchWaves(result, prematureRequest, 0), false);
const failedWave = structuredClone(waves); failedWave[0].outcomes[0].failures = 1;
assert.equal(benchmarkSamplesMatchWaves(result, failedWave, 0), false);
const wrongWave = structuredClone(waves); wrongWave[0].outcomes[0].wave = 4;
assert.equal(benchmarkSamplesMatchWaves(result, wrongWave, 0), false);
const withinRounding = { ...result, signInSamplesMs: [...samples] }; withinRounding.signInSamplesMs[0] += 0.009;
assert.equal(benchmarkSamplesMatchWaves(withinRounding, waves, 0), true);
const beyondRounding = { ...result, signInSamplesMs: [...samples] }; beyondRounding.signInSamplesMs[0] += 0.011;
assert.equal(benchmarkSamplesMatchWaves(beyondRounding, waves, 0), false);
assert.equal(benchmarkSamplesMatchWaves(result, waves.slice(1), 0), false);
assert.equal(benchmarkSamplesMatchWaves(result, waves, 2), false);
console.log('Latency evidence requires twenty valid samples and recomputes the nearest-rank p95.');
