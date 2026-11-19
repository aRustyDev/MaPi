// Local diagnostic only: not an end-to-end sign-in benchmark or hosted test.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout } from 'node:timers/promises';

async function port() { const socket = createServer().listen(0, '127.0.0.1'); await once(socket, 'listening'); const p = socket.address().port; await new Promise(done => socket.close(done)); return p; }
if (process.env.MAPI_TEST_PREBUILT !== '1') execFileSync(process.execPath, ['scripts/build-upstream-split-test.mjs'], { stdio: 'inherit' });
const rounds = Number(process.env.MAPI_LATENCY_ROUNDS ?? 2);
assert.ok(Number.isInteger(rounds) && rounds >= 1 && rounds <= 10);
const dir = await mkdtemp(resolve(tmpdir(), 'mapi-split-latency-'));
let verifier, caller;
try {
  const [vp, cp, vi, ci] = await Promise.all([port(), port(), port(), port()]);
  const vars = resolve(dir, 'vars');
  await writeFile(vars, `ARGON_SPIKE_SECRET=${randomBytes(32).toString('base64url')}\nMAPI_LOCAL_TEST=1\n`, { mode: 0o600 });
  function start(config, p, inspect) {
    return spawn(process.execPath, [resolve('node_modules/wrangler/bin/wrangler.js'), 'dev', '--local', '--config', config, '--env-file', vars, '--ip', '127.0.0.1', '--port', String(p), '--inspector-port', String(inspect), '--persist-to', resolve(dir, 'state')], { stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, WRANGLER_LOG_PATH: resolve(dir, `${p}.log`), WRANGLER_SEND_METRICS: 'false' } });
  }
  async function ready(p, child) {
    for (let i = 0; i < 100; i++) { if (child.exitCode !== null) throw new Error('local worker exited'); try { await fetch(`http://127.0.0.1:${p}/`); return; } catch { await setTimeout(200); } }
    throw new Error('local worker not ready');
  }
  verifier = start('scripts/argon-spike-verifier.wrangler.jsonc', vp, vi); await ready(vp, verifier);
  caller = start('scripts/split-latency-test.wrangler.jsonc', cp, ci); await ready(cp, caller);
  const key = JSON.parse(await readFile('.mapi/runtime-key.json', 'utf8'));
  const { user } = JSON.parse(await readFile('.mapi/fixture.json', 'utf8'));
  async function post(path, body) {
    const response = await fetch(`http://127.0.0.1:${cp}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(120000) });
    assert.equal(response.status, 200, `${path} failed`); return response.json();
  }
  const results = {};
  for (const mode of ['inline', 'split']) {
    const durations = [], totals = [], retryCounts = [], memory = [];
    for (let round = 0; round < rounds; round++) {
      assert.equal((await post('/setup', { mode, round, key, user })).ready, true);
      const started = performance.now();
      const clients = await Promise.all(Array.from({ length: 4 }, async (_, index) => {
        const begin = performance.now(); let stale = 0;
        for (let n = 0; n < 8; n++) {
          const { outcome } = await post('/verify', { mode, round, index });
          if (outcome === 'success') return { duration: performance.now() - begin, stale };
          if (outcome !== 'stale') throw new Error(`unexpected ${mode} result ${outcome}`);
          stale++;
        }
        throw new Error('stale retry limit reached');
      }));
      totals.push(performance.now() - started);
      durations.push(...clients.map(x => x.duration)); retryCounts.push(...clients.map(x => x.stale));
      const final = await post('/finalize', { mode, round });
      assert.deepEqual([final.established, final.rejectedReplay, final.successAudits], [4, 4, 4]);
      memory.push(final.wasmBytes);
    }
    const sorted = durations.toSorted((a, b) => a - b);
    results[mode] = { clients: sorted.length, rounds, concurrency: 4, minMs: sorted[0], medianMs: sorted[Math.floor(sorted.length / 2)], maxMs: sorted.at(-1), batchWallMs: totals, staleRetries: retryCounts.reduce((a, b) => a + b, 0), maxWasmBytes: Math.max(...memory) };
  }
  console.log(JSON.stringify(results, null, 2));
} finally {
  for (const child of [caller, verifier]) if (child && child.exitCode === null && child.signalCode === null) { const done = once(child, 'exit'); child.kill('SIGTERM'); await done; }
  await rm(dir, { recursive: true, force: true });
}
