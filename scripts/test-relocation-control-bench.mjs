import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';

async function port() {
  const server = createServer().listen(0, '127.0.0.1'); await once(server, 'listening');
  const value = server.address().port; await new Promise(done => server.close(done)); return value;
}
const dir = await mkdtemp(resolve(tmpdir(), 'mapi-control-bench-'));
const address = await port(), inspector = await port(), envFile = resolve(dir, 'empty.env');
await writeFile(envFile, '', {mode: 0o600});
const child = spawn(process.execPath, [resolve('node_modules/wrangler/bin/wrangler.js'), 'dev', '--local', '--config', 'scripts/relocation-control-bench.wrangler.jsonc', '--env-file', envFile, '--ip', '127.0.0.1', '--port', String(address), '--inspector-port', String(inspector), '--persist-to', dir], {stdio: ['ignore', 'pipe', 'pipe'], env: {PATH: process.env.PATH, TMPDIR: dir, XDG_CONFIG_HOME: resolve(dir, 'config'), XDG_CACHE_HOME: resolve(dir, 'cache'), WRANGLER_LOG_PATH: resolve(dir, 'wrangler.log'), WRANGLER_SEND_METRICS: 'false'}});
let output = '';
for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { output = (output + chunk.toString()).slice(-16000); });
async function call(action, count) {
  const start = performance.now();
  const response = await fetch(`http://127.0.0.1:${address}/`, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({action, count}), signal: AbortSignal.timeout(15000)});
  const data = await response.json(); assert.equal(response.status, 200); assert.equal(data.ok, true);
  return performance.now() - start;
}
try {
  const ready = `Ready on http://127.0.0.1:${address}`;
  for (let index = 0; index < 150 && !output.includes(ready); index++) {
    if (child.exitCode !== null) throw Error('Local worker exited');
    await delay(200);
  }
  if (!output.includes(ready)) throw Error('Local worker did not start');
  for (const count of [0, 2048]) await call('prepare', count);
  for (let index = 0; index < 5; index++) for (const count of [0, 2048]) await call('check', count);
  const samples = {0: [], 2048: []};
  for (let index = 0; index < 25; index++) for (const count of index % 2 ? [2048, 0] : [0, 2048]) samples[count].push(await call('check', count));
  const summarize = values => { values.sort((a, b) => a - b); return {samples: values.length, medianMs: values[12], p95Ms: values[23], maxMs: values[24]}; };
  console.log(JSON.stringify({scope: 'local control validation RPC including loopback overhead', history0: summarize(samples[0]), history2048: summarize(samples[2048]), limitations: 'synthetic control rows; no project transfer, CPU, isolate memory or hosted result'}, null, 2));
} finally {
  if (child.exitCode === null && child.signalCode === null) { const stopped = once(child, 'exit'); child.kill('SIGTERM'); await stopped; }
  await rm(dir, {recursive: true, force: true});
}
