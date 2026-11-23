import { writeFile } from 'node:fs/promises';
import { benchmarkJourneyP95, benchmarkLatencyPassed, benchmarkOverlapPassed, benchmarkPhaseMetrics, benchmarkSamplesMatchWaves, benchmarkSignInP95 } from './phase1-benchmark-metrics.mjs';
import { benchmarkWorkloadPassed } from './phase1-benchmark-management.mjs';

// Browser response observations are aggregated without retaining paths,
// credentials or response bodies. RP replay requests are made by Node, not
// by the observed browser page, and are checked separately by the RP.
export function recordUnexpectedHttp(counts, pathname, status, source = 'issuer') {
  if (!Number.isInteger(status) || status < 400 || status > 599) return;
  const group = source === 'rp' ? 'rp' : source === 'other-origin' ? 'other-origin' : pathname.startsWith('/__nextgen/') ? 'flow' : pathname.startsWith('/oauth/') ? 'oauth' : 'other';
  const key = `${group}:${status}`;
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

export function unexpectedHttpSummary(counts) {
  return [...counts].map(([key, count]) => {
    const [group, status] = key.split(':');
    return { group, status: Number(status), count };
  });
}

export function assertNoUnexpectedHttp(counts) {
  if (counts.size) throw new Error('Unexpected browser HTTP response during journey');
}

export function assertRuntimeStatus(status) {
  if (!status || status.ready !== true || status.fenceReady !== true || status.recoveryReady !== true || typeof status.bootId !== 'string' || !status.bootId || !Number.isSafeInteger(status.reactorInitializations) || status.reactorInitializations < 1 || !Number.isSafeInteger(status.wasmMemoryBytes) || status.wasmMemoryBytes <= 0 || !Number.isSafeInteger(status.wasmHighWaterBytes) || status.wasmHighWaterBytes < status.wasmMemoryBytes || !Number.isSafeInteger(status.wasmHighWaterPages) || status.wasmHighWaterPages * 65536 !== status.wasmHighWaterBytes) throw new Error('Owner status evidence is incomplete');
}

// A traffic run alone cannot certify Phase 1. This runner does not yet verify
// cold-instance confirmation, size/startup, platform limits or memory coverage.
export function benchmarkCompletion(report) {
  const trafficPass = ['plain', 'mixed'].every((name, phaseIndex) => {
    const phase = report?.[name], mixed = phaseIndex === 1;
    if (phase?.complete !== true || phase.mixed !== mixed || phase.failures !== 0 ||
        phase.latencyPass !== true || phase.workloadPass !== true || phase.overlapPass !== true ||
        !Array.isArray(phase.projects) || phase.projects.length !== 2 ||
        !Array.isArray(phase.ready) || phase.ready.length !== 2) return false;
    const positive = value => typeof value === 'number' && Number.isFinite(value) && value > 0;
    if (Array.from(phase.ready).some(item => !item || ['first', 'warmup'].some(name => !item[name] || Object.hasOwn(item[name], 'failure') || !positive(item[name].result?.signInMs) || !positive(item[name].result?.journeyMs) || item[name].result.journeyMs < item[name].result.signInMs))) return false;
    try {
      if (!Array.isArray(phase.waves) || phase.waves.length !== 5 || Array.from(phase.waves).some(wave => {
        if (wave?.complete !== true || wave.intendedJourneys !== 8 || !Array.isArray(wave.outcomes) || wave.outcomes.length !== 2 ||
            Array.from(wave.outcomes).some(outcome => !outcome || outcome.failures !== 0 || !Array.isArray(outcome.failureCategories) || outcome.failureCategories.length !== 0)) return true;
        if (!Array.isArray(wave.management) || wave.management.length !== (mixed ? 2 : 0)) return true;
        return Array.from(wave.management).some(item => !item || Object.hasOwn(item, 'error') ||
          (Object.hasOwn(item, 'failureCategories') && (!Array.isArray(item.failureCategories) || item.failureCategories.length !== 0)));
      })) return false;
      const projects = Array.from(phase.projects);
      if (projects.some(result => !result || result.replayAttempts !== 22 || result.replayRejections !== 22 || benchmarkJourneyP95(result) === null)) return false;
      benchmarkPhaseMetrics(projects.map(result => ({ result })), phase.waves, phase.elapsedMs, mixed);
      const p95 = projects.map((result, index) => benchmarkSamplesMatchWaves(result, phase.waves, index) ? benchmarkSignInP95(result) : null);
      if (!Array.isArray(phase.signInP95ByProject) || phase.signInP95ByProject.length !== 2 ||
          p95.some((value, index) => value === null || value !== phase.signInP95ByProject[index])) return false;
      return benchmarkLatencyPassed(p95, phase.failures) && benchmarkWorkloadPassed(mixed, phase.waves) && benchmarkOverlapPassed(mixed, phase.waves);
    } catch { return false; }
  });
  return { trafficPass, phase1Pass: false, exitCode: 1 };
}

export function benchmarkChildFailure(message) {
  if (message?.type !== 'child-failure') return null;
  const input = message.failure;
  const operations = ['oidc-init', 'oidc-client', 'pre-idle-status', 'owner-status', 'child'];
  const kinds = ['http', 'timeout', 'response', 'transport', 'internal'];
  const validStatus = input?.status === null || (Number.isInteger(input?.status) && input.status >= 100 && input.status <= 599);
  const detail = operations.includes(input?.operation) && kinds.includes(input?.kind) && validStatus ? { operation: input.operation, kind: input.kind, status: input.status } : { operation: 'child', kind: 'internal', status: null };
  const error = new Error('Benchmark child failed'); error.phase1Failure = detail; return error;
}

export function classifyJourneyFailure(error) {
  const message = String(error?.message ?? '');
  let category = 'journey_failed';
  if (/Independent RP callback failed/.test(message)) category = 'rp_callback_failed';
  else if (error?.phase1BrowserFailure?.kind === 'timeout') category = 'browser_requests_incomplete';
  else if (/Timeout/i.test(message)) category = 'browser_timeout';
  else if (/assert/i.test(message) || error?.name === 'AssertionError') category = 'assertion_failed';
  return { category, stage: error?.phase1Stage ?? null, lastHttpFailure: error?.phase1HttpFailure ?? null, unexpectedHttp: error?.phase1UnexpectedHttp ?? [], rpFailure: error?.phase1RpFailure ?? null, browserFailure: error?.phase1BrowserFailure ?? null };
}

export async function persistBenchmarkReport(path, report) {
  if (path) await writeFile(path, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
}
