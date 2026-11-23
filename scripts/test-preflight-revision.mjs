import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

async function port() {
  const server = createServer().listen(0, '127.0.0.1'); await once(server, 'listening');
  const value = server.address().port; await new Promise(done => server.close(done)); return value;
}
const directory = await mkdtemp(resolve(tmpdir(), 'mapi-preflight-revision-'));
const address = await port(), inspector = await port(), envFile = resolve(directory, 'empty.env');
await writeFile(envFile, '', { mode: 0o600 });
const child = spawn(process.execPath, [resolve('node_modules/wrangler/bin/wrangler.js'), 'dev', '--local', '--config', 'scripts/preflight-revision-test.wrangler.jsonc', '--env-file', envFile, '--ip', '127.0.0.1', '--port', String(address), '--inspector-port', String(inspector), '--persist-to', resolve(directory, 'state')], { stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: process.env.PATH, TMPDIR: directory, XDG_CONFIG_HOME: resolve(directory, 'config'), XDG_CACHE_HOME: resolve(directory, 'cache'), WRANGLER_LOG_PATH: resolve(directory, 'wrangler.log'), WRANGLER_SEND_METRICS: 'false' } });
let output = '';
for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { output = (output + chunk.toString()).slice(-16000); });
try {
  const ready = `Ready on http://127.0.0.1:${address}`;
  for (let n = 0; n < 100; n++) {
    if (child.exitCode !== null) throw Error('Local workerd exited');
    if (output.includes(ready)) break;
    await delay(200);
  }
  if (!output.includes(ready) || child.exitCode !== null) throw Error('Local workerd did not start');
  const split = await fetch(`http://127.0.0.1:${address}/?profile=split`, {signal: AbortSignal.timeout(15000)});
  const raw = await split.text(); if (!split.headers.get('content-type')?.includes('json')) throw Error(`Local Worker returned HTTP ${split.status}: ${raw.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').slice(-2500)}`); const first = JSON.parse(raw); assert.equal(split.status, 200, first.error); assert.equal(first.throttleChanged, false);
  const response = await fetch(`http://127.0.0.1:${address}/?profile=preflight`, {signal: AbortSignal.timeout(15000)});
  const second = await response.json(); assert.equal(response.status, 200, second.error);
  assert.deepEqual(second, {profile: 'preflight', throttleChanged: true, prefixCovered: true, invalidCounterRejected: true, rollback: true, nestedAudit: true, cascade: true, staleThrottleRejected: true, schemaDetection: true, checkpointSelfInvalidates: false, checkpointMutationUntracked: true, directCounterRewind: true, missingCounterRecreated: false, refusedMissingCounter: true});
  console.log(JSON.stringify({split: first, preflight: second}));
} finally {
  if (child.exitCode === null && child.signalCode === null) { const done = once(child, 'exit'); child.kill('SIGTERM'); await done; }
  await rm(directory, {recursive: true, force: true});
}
