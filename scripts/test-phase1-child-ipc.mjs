import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { benchmarkChildFailure, persistBenchmarkReport } from './phase1-benchmark-report.mjs';

const dir = await mkdtemp(resolve(tmpdir(), 'mapi-phase1-child-ipc-'));
try {
  const script = resolve(dir, 'child.mjs'), path = resolve(dir, 'report.json');
  await writeFile(script, "const failure = { operation: 'oidc-init', kind: process.argv[2], status: process.argv[2] === 'http' ? 503 : null }; process.send({ type: 'child-failure', failure }, () => process.exit(1));\n");
  const failures = [];
  for (const kind of ['http', 'timeout']) {
    const child = fork(script, [kind], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    const exited = once(child, 'exit');
    const [message] = await once(child, 'message');
    const parsed = benchmarkChildFailure(message);
    failures.push({ error: 'child_setup_failed', failure: parsed.phase1Failure });
    await exited;
  }
  await persistBenchmarkReport(path, { plain: { ready: failures, complete: false }, failure: 'benchmark_incomplete' });
  const report = JSON.parse(await readFile(path, 'utf8'));
  assert.deepEqual(report.plain.ready.map(item => item.failure), [{ operation: 'oidc-init', kind: 'http', status: 503 }, { operation: 'oidc-init', kind: 'timeout', status: null }]);
  assert.deepEqual(benchmarkChildFailure({ type: 'child-failure', failure: { operation: 'private', kind: 'http', status: 503, body: 'secret' } }).phase1Failure, { operation: 'child', kind: 'internal', status: null });
  assert.ok(!JSON.stringify(report).includes('secret'));
  console.log('Setup HTTP and timeout categories survive child IPC into a partial report.');
} finally { await rm(dir, { recursive: true, force: true }); }
