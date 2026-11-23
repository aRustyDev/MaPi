// Run two real hosted browser/RP journeys in synchronized waves. The input
// file is private and contains synthetic test credentials for each project.
import { fork } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { benchmarkWorkloadPassed, runBenchmarkManagement } from './phase1-benchmark-management.mjs';
import { benchmarkOverlapPassed, benchmarkPhaseMetrics, benchmarkSignInP95, benchmarkSamplesMatchWaves, benchmarkLatencyPassed } from './phase1-benchmark-metrics.mjs';
import { benchmarkCompletion, persistBenchmarkReport } from './phase1-benchmark-report.mjs';
import { watchBenchmarkChild } from './phase1-benchmark-child.mjs';
import { requireBenchmarkProvenance } from './phase1-benchmark-provenance.mjs';
import { requestFailure, requestJson } from './phase1-request.mjs';
import { hostedOrigin, loopbackOrigin } from './phase1-urls.mjs';

const outputPath = process.env.MAPI_PHASE1_OUTPUT;
const path = process.env.MAPI_PHASE1_FILE;
if (!path) throw new Error('MAPI_PHASE1_FILE is required');
let config;
try { config = JSON.parse(await readFile(path, 'utf8')); }
catch { throw new Error('Invalid private benchmark fixture'); }
const controlUrl = process.env.MAPI_PHASE1_CONTROL_URL ? loopbackOrigin(process.env.MAPI_PHASE1_CONTROL_URL) : undefined;
if (!Array.isArray(config.projects) || config.projects.length !== 2) throw new Error('Two projects are required');
for (const project of config.projects) {
  if (!project.origin || !project.operator || !project.userFile || (!project.managementToken && !controlUrl) || !project.userId || !project.projectId) {
    throw new Error('Each project requires origin, operator, userFile, userId, projectId, and a management token or private control proxy');
  }
  project.origin = hostedOrigin(project.origin);
}
if (new Set(config.projects.map(project => project.origin)).size !== 2 || new Set(config.projects.map(project => project.projectId)).size !== 2 || new Set(config.projects.map(project => project.userId)).size !== 2) throw new Error('Benchmark project origins, project IDs and user IDs must be distinct');
// This check must precede all token setup, admin writes and child launches.
await requireBenchmarkProvenance();

async function control(project, action, userId) {
  const data = await requestJson(controlUrl, { method: 'POST', headers: { authorization: `Bearer ${project.operator}`, 'content-type': 'application/json' }, body: JSON.stringify({ origin: project.origin, action, userId }) }, { operation: action, expectedStatus: 200 });
  if (!data || !Object.hasOwn(data, 'result')) throw requestFailure(action, 'response', 200);
  return data.result;
}

function child(project, onProgress) {
  const processChild = fork('scripts/test-hosted-oidc.mjs', [], {
    env: { ...process.env, MAPI_URL: project.origin, MAPI_OPERATOR_TOKEN: project.operator, MAPI_TEST_USER_FILE: project.userFile, MAPI_PHASE1_CHILD: '1', MAPI_PHASE1_EXPECTED_PROJECT: project.projectId, MAPI_PHASE1_EXPECTED_USER: project.userId },
    stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
  });
  return watchBenchmarkChild(processChild, onProgress);
}

async function run(mixed) {
  const phase = { mixed, ready: [], setupProgress: [{}, {}], waves: [], complete: false };
  report[mixed ? 'mixed' : 'plain'] = phase;
  await persist();
  const workers = config.projects.map((project, index) => child(project, message => { if (['first', 'warmup'].includes(message.stage)) phase.setupProgress[index][message.stage] = message.outcome; }));
  try {
    const readyOutcomes = await Promise.allSettled(workers.map(worker => worker.next('ready')));
    phase.ready = readyOutcomes.map(item => item.status === 'fulfilled' ? item.value : { error: 'child_setup_failed', failure: item.reason?.phase1Failure ?? null });
    await persist();
    if (readyOutcomes.some(item => item.status === 'rejected')) throw new Error('Benchmark child setup failed');
    const ready = phase.ready;
    const start = performance.now();
    const waves = phase.waves;
    for (let wave = 0; wave < 5; wave++) {
      const checkpoint = { wave, intendedJourneys: 8, complete: false };
      waves.push(checkpoint);
      await persist();
      const sent = workers.map(worker => { const parentSentAtMs = performance.timeOrigin + performance.now(); worker.process.send({ type: 'start', wave }); return parentSentAtMs; });
      const startResults = await Promise.allSettled(workers.map(worker => worker.next('wave-start')));
      checkpoint.starts = startResults.map((item, index) => item.status === 'fulfilled' ? { ...item.value, parentSentAtMs: sent[index] } : { error: 'child_start_failed', failure: item.reason?.phase1Failure ?? null });
      if (startResults.some(item => item.status === 'rejected') || checkpoint.starts.some(item => item.wave !== wave || item.attempts !== 4 || item.started !== 4)) {
        // The incomplete child has already settled its attempts. Let both
        // children report their outcomes before persisting the failed wave.
        const partial = await Promise.allSettled(workers.map(worker => worker.next('wave')));
        checkpoint.outcomes = partial.map(item => item.status === 'fulfilled' ? item.value : { error: 'child_wave_failed', failure: item.reason?.phase1Failure ?? null });
        checkpoint.management = [];
        await persist();
        throw new Error('Benchmark browser wave did not start');
      }
      const [outcomeResults, managementResults] = await Promise.all([
        Promise.allSettled(workers.map(worker => worker.next('wave'))),
        mixed ? Promise.allSettled(config.projects.map((project, index) => runBenchmarkManagement(project, config.projects[1 - index].userId, wave, { control: controlUrl ? control : undefined }))) : Promise.resolve([]),
      ]);
      checkpoint.outcomes = outcomeResults.map(item => item.status === 'fulfilled' ? item.value : { error: 'child_wave_failed', failure: item.reason?.phase1Failure ?? null });
      checkpoint.management = managementResults.map(item => item.status === 'fulfilled' ? item.value : { error: 'management_internal_failure' });
      checkpoint.complete = outcomeResults.every(item => item.status === 'fulfilled' && item.value.wave === wave && item.value.attempts === 4) && managementResults.every(item => item.status === 'fulfilled');
      await persist();
      if (!checkpoint.complete) throw new Error('Benchmark wave incomplete');
    }
    const elapsedMs = performance.now() - start;
    const results = await Promise.all(workers.map(worker => worker.next('result')));
    const setupFailures = ready.reduce((total, item) => total + Number(Boolean(item.first.failure)) + Number(Boolean(item.warmup.failure)), 0);
    const failures = setupFailures + waves.reduce((total, wave) => total + wave.outcomes.reduce((sum, item) => sum + item.failures, 0) + wave.management.reduce((sum, item) => sum + (item.failureCategories?.length ?? 0), 0), 0);
    const metrics = benchmarkPhaseMetrics(results, waves, elapsedMs, mixed);
    const signInP95ByProject = results.map((item, index) => benchmarkSamplesMatchWaves(item.result, waves, index) ? benchmarkSignInP95(item.result) : null);
    return { mixed, ready, waves, complete: true, elapsedMs, throughputInterval: 'phase-wall-including-checkpoints', journeysPerSecond: metrics.journeysPerSecond, managementOperationsPerSecond: metrics.managementOperationsPerSecond, failures, projects: results.map((item, index) => ({ ...item.result, throughput: metrics.projects[index] })), signInP95ByProject, workloadPass: benchmarkWorkloadPassed(mixed, waves), overlapPass: benchmarkOverlapPassed(mixed, waves), latencyPass: benchmarkLatencyPassed(signInP95ByProject, failures) };
  } finally {
    for (const worker of workers) if (worker.process.exitCode === null) worker.process.kill('SIGTERM');
  }
}

const report = { startedAt: new Date().toISOString(), trafficPass: false, phase1Pass: false, pendingEvidence: ['cold instance confirmation', ...(!controlUrl ? ['mutation audit verification'] : []), 'platform CPU, memory and overload metrics', 'upload and startup validation'] };
async function persist() {
  await persistBenchmarkReport(outputPath, report);
}
try {
  if (controlUrl) {
    report.tokenSetup = [];
    for (const project of config.projects) {
      const attempt = { attempted: true, complete: false }; report.tokenSetup.push(attempt); await persist();
      try { project.managementToken = await control(project, 'project-token'); }
      catch (error) { attempt.failure = error?.phase1Failure ?? null; await persist(); throw error; }
      if (typeof project.managementToken !== 'string' || !project.managementToken) { attempt.failure = { operation: 'project-token', kind: 'response', status: 200 }; await persist(); throw requestFailure('project-token', 'response', 200); }
      attempt.complete = true; await persist();
    }
  }
  report.plain = await run(false);
  await persist();
  await delay(70000);
  report.mixed = await run(true);
  report.finishedAt = new Date().toISOString();
  const completion = benchmarkCompletion(report);
  report.trafficPass = completion.trafficPass;
  report.phase1Pass = completion.phase1Pass;
  await persist();
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = completion.exitCode;
} catch (error) {
  report.finishedAt = new Date().toISOString();
  report.failure = 'benchmark_incomplete';
  report.failureDetail = error?.phase1Failure ?? null;
  await persist();
  throw error;
}
