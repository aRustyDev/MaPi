// Both processes run on the same runner host. The IPC timestamps bound the
// child/parent clock offset; the resulting overlap is client-observed and does
// not establish simultaneous execution inside Workers.
const count = value => Number.isSafeInteger(value) && value >= 0;
const interval = value => value && Number.isFinite(value.startedAtMs) && Number.isFinite(value.endedAtMs) && value.endedAtMs >= value.startedAtMs;

// Never compare an unvalidated child-provided aggregate with the latency gate:
// JavaScript would otherwise accept values such as null or a negative number.
export function benchmarkSignInP95(result) {
  const samples = result?.signInSamplesMs;
  if (result?.measuredJourneys !== 20 || !Array.isArray(samples) || samples.length !== 20 ||
      Array.from(samples).some(value => typeof value !== 'number' || !Number.isFinite(value) || value <= 0)) return null;
  const p95 = [...samples].sort((a, b) => a - b)[18];
  if (typeof result.signInP95Ms !== 'number' || !Number.isFinite(result.signInP95Ms) || result.signInP95Ms !== p95) return null;
  return p95;
}

// Full RP completion is reported separately from sign-in. Check each journey
// against its paired sign-in sample and recompute the reported percentile.
// These remain child-supplied measurements, not an independent clock proof.
export function benchmarkJourneyP95(result) {
  const signIn = result?.signInSamplesMs, journey = result?.journeySamplesMs;
  if (benchmarkSignInP95(result) === null || !Array.isArray(journey) || journey.length !== 20 ||
      Array.from(journey).some((value, index) => typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value < signIn[index])) return null;
  const p95 = [...journey].sort((a, b) => a - b)[18];
  return typeof result.journeyP95Ms === 'number' && Number.isFinite(result.journeyP95Ms) && result.journeyP95Ms === p95 ? p95 : null;
}

// The child reports each elapsed sample and its wave interval separately.
// Cross-check their order and endpoints without changing the first-request
// interval used to prove client-side concurrency. Epoch-millisecond addition
// loses sub-microsecond precision at current dates; 0.01 ms is conservative.
export function benchmarkSamplesMatchWaves(result, waves, projectIndex) {
  const samples = result?.signInSamplesMs;
  if (!Array.isArray(samples) || samples.length !== 20 || !Array.isArray(waves) || waves.length !== 5 || ![0, 1].includes(projectIndex)) return false;
  let index = 0;
  for (let waveIndex = 0; waveIndex < 5; waveIndex++) {
    const wave = waves[waveIndex], outcome = wave?.outcomes?.[projectIndex];
    if (wave?.wave !== waveIndex || outcome?.wave !== waveIndex || outcome?.attempts !== 4 || outcome?.failures !== 0 ||
        !Array.isArray(outcome.latencyIntervals) || outcome.latencyIntervals.length !== 4 ||
        !Array.isArray(outcome.signInIntervals) || outcome.signInIntervals.length !== 4) return false;
    for (let i = 0; i < 4; i++, index++) {
      const sample = samples[index], latency = outcome.latencyIntervals[i], request = outcome.signInIntervals[i];
      if (typeof sample !== 'number' || !Number.isFinite(sample) || sample <= 0 || !interval(latency) || !interval(request) ||
          latency.endedAtMs <= latency.startedAtMs || request.endedAtMs <= request.startedAtMs ||
          request.startedAtMs < latency.startedAtMs || request.endedAtMs !== latency.endedAtMs ||
          Math.abs(sample - (latency.endedAtMs - latency.startedAtMs)) > 0.01) return false;
    }
  }
  return index === 20;
}

export function benchmarkLatencyPassed(p95ByProject, failures) {
  return failures === 0 && Array.isArray(p95ByProject) && p95ByProject.length === 2 &&
    Array.from(p95ByProject).every(value => typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 3500);
}

export function benchmarkPhaseMetrics(results, waves, elapsedMs, mixed) {
  if (!Array.isArray(results) || results.length !== 2 || !Array.isArray(waves) || waves.length !== 5 || !Number.isFinite(elapsedMs) || elapsedMs <= 0) throw new Error('Invalid benchmark phase metrics');
  const projects = results.map(({ result }, projectIndex) => {
    let attemptedJourneys = 0, failedJourneys = 0, attemptedManagement = 0, completedManagement = 0, expectedManagement = 0;
    for (const wave of waves) {
      const outcome = wave.outcomes?.[projectIndex];
      if (!count(outcome?.attempts) || !count(outcome?.failures) || outcome.failures > outcome.attempts) throw new Error('Incomplete journey accounting');
      attemptedJourneys += outcome.attempts;
      failedJourneys += outcome.failures;
      const management = wave.management?.[projectIndex];
      if (mixed) {
        if (!count(management?.attempts) || !count(management?.operations) || !count(management?.expectedAttempts) || management.operations > management.attempts || management.attempts > management.expectedAttempts) throw new Error('Incomplete management accounting');
        attemptedManagement += management.attempts;
        completedManagement += management.operations;
        expectedManagement += management.expectedAttempts;
      } else if (wave.management?.length) throw new Error('Unexpected management accounting');
    }
    const completedJourneys = result?.measuredJourneys;
    if (!count(completedJourneys) || completedJourneys + failedJourneys !== attemptedJourneys) throw new Error('Journey counts disagree');
    return { projectIndex, attemptedMeasuredJourneys: attemptedJourneys, completedMeasuredJourneys: completedJourneys, failedMeasuredJourneys: failedJourneys, attemptedManagement, completedManagement, expectedManagement, journeysPerSecond: completedJourneys * 1000 / elapsedMs, managementOperationsPerSecond: completedManagement * 1000 / elapsedMs };
  });
  return { projects, journeysPerSecond: projects.reduce((sum, item) => sum + item.completedMeasuredJourneys, 0) * 1000 / elapsedMs, managementOperationsPerSecond: projects.reduce((sum, item) => sum + item.completedManagement, 0) * 1000 / elapsedMs };
}

// Require a provable client-side overlap for every planned management read
// and create. The offset bound is derived from the wave barrier round trip.
export function benchmarkOverlapPassed(mixed, waves) {
  if (!Array.isArray(waves) || waves.length !== 5) return false;
  return waves.every((wave, waveIndex) => {
    if (!Array.isArray(wave.outcomes) || wave.outcomes.length !== 2 || !Array.isArray(wave.management) || wave.management.length !== (mixed ? 2 : 0) || !Array.isArray(wave.starts) || wave.starts.length !== 2) return false;
    const parentBounds = [];
    const eachProjectPasses = wave.outcomes.every((outcome, projectIndex) => {
      const start = wave.starts[projectIndex], journeys = outcome?.signInIntervals;
      if (!start || start.attempts !== 4 || start.started !== 4 || ![start.parentSentAtMs, start.parentReceivedAtMs, start.childReceivedAtMs, start.childAcknowledgedAtMs].every(Number.isFinite) || start.parentReceivedAtMs < start.parentSentAtMs || start.childAcknowledgedAtMs < start.childReceivedAtMs) return false;
      const minOffset = start.childAcknowledgedAtMs - start.parentReceivedAtMs;
      const maxOffset = start.childReceivedAtMs - start.parentSentAtMs;
      if (minOffset > maxOffset || !Array.isArray(journeys) || journeys.length !== 4 || journeys.some(item => !interval(item) || item.startedAtMs < start.childReceivedAtMs || item.startedAtMs > start.childAcknowledgedAtMs)) return false;
      if (Math.max(...journeys.map(item => item.startedAtMs)) >= Math.min(...journeys.map(item => item.endedAtMs))) return false;
      // Prove a common interval across both projects using the latest possible
      // parent-clock start and earliest possible end for every journey.
      for (const journey of journeys) parentBounds.push({ latestStart: journey.startedAtMs - minOffset, earliestEnd: journey.endedAtMs - maxOffset });
      if (!mixed) return true;
      const operations = wave.management[projectIndex]?.operationIntervals;
      if (!Array.isArray(operations) || operations.length !== wave.management[projectIndex].attempts || operations.some(item => !interval(item) || !['get', 'query', 'create', 'created-get'].includes(item.operation))) return false;
      const required = operations.filter(item => ['get', 'query', 'create'].includes(item.operation));
      if (required.filter(item => item.operation === 'get').length !== 2 || required.filter(item => item.operation === 'query').length !== 2 || required.filter(item => item.operation === 'create').length !== (waveIndex === 1 || waveIndex === 3 ? 1 : 0)) return false;
      // The read workload is deliberately serial per project. Also ensure the
      // post-create read is a verification, after both the create and the
      // regular read chain have completed. Intervals are captured on the
      // parent clock and recorded when each request settles.
      const reads = operations.filter(item => item.operation === 'get' || item.operation === 'query');
      if (reads.map(item => item.operation).join(',') !== 'get,query,get,query' || reads.some((item, index) => index > 0 && item.startedAtMs < reads[index - 1].endedAtMs)) return false;
      const verification = operations.filter(item => item.operation === 'created-get');
      const create = operations.find(item => item.operation === 'create');
      if (verification.length !== (create ? 1 : 0) || (create && (verification[0].startedAtMs < create.endedAtMs || verification[0].startedAtMs < reads.at(-1).endedAtMs))) return false;
      return required.every(operation => operation.endedAtMs > operation.startedAtMs && journeys.some(journey => operation.startedAtMs < journey.endedAtMs - maxOffset && operation.endedAtMs > journey.startedAtMs - minOffset));
    });
    return eachProjectPasses && parentBounds.length === 8 && Math.max(...parentBounds.map(item => item.latestStart)) < Math.min(...parentBounds.map(item => item.earliestEnd));
  });
}
