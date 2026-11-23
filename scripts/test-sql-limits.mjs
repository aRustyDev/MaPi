import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { setTimeout } from 'node:timers/promises';

async function freePort() { const server = createServer().listen(0, '127.0.0.1'); await once(server, 'listening'); const port = server.address().port; await new Promise(done => server.close(done)); return port; }
const directory = await mkdtemp(resolve(tmpdir(), 'mapi-sql-limits-'));
const envFile = resolve(directory, 'empty.env'); await writeFile(envFile, '');
const port = await freePort(), inspector = await freePort();
const server = spawn(process.execPath, [resolve('node_modules/wrangler/bin/wrangler.js'), 'dev', '--local', '--config', 'scripts/phase1-sql-limit-probe.wrangler.jsonc', '--env-file', envFile, '--ip', '127.0.0.1', '--port', String(port), '--inspector-port', String(inspector), '--persist-to', directory], { stdio: ['ignore', 'ignore', 'inherit'], env: { ...process.env, WRANGLER_LOG_PATH: resolve(directory, 'wrangler.log'), WRANGLER_SEND_METRICS: 'false' } });
try {
  let response;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (server.exitCode !== null) throw new Error('workerd exited before SQL limit test');
    try { response = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(60000) }); break; }
    catch (error) { if (error.name === 'TimeoutError') throw error; await setTimeout(200); }
  }
  if (!response) throw new Error('workerd did not start');
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.ok, true);
  assert.equal(result.wideColumns, 100);
  assert.equal(result.rewrittenSelectBytes, 100000);
  assert.equal(result.rewrittenReturningBytes, 100000);
  assert.equal(result.rejectedBytes, 100001);
  console.log('Local workerd SQL limits:', JSON.stringify(result));
} finally {
  if (server.exitCode === null && server.signalCode === null) { const stopped = once(server, 'exit'); server.kill('SIGTERM'); await stopped; }
  await rm(directory, { recursive: true, force: true });
}
