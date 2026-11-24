import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { setTimeout } from 'node:timers/promises';

async function freePort() {
  const server = createServer().listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  await new Promise(done => server.close(done));
  return port;
}

const dir = await mkdtemp(resolve(tmpdir(), 'mapi-key-provider-local-'));
let server;
try {
  const [port, inspector] = await Promise.all([freePort(), freePort()]);
  const config = resolve(dir, 'wrangler.jsonc');
  await writeFile(config, JSON.stringify({ name: 'mapi-local-synthetic-key-provider',
    main: resolve('scripts/synthetic-archive-key-workerd-worker.mjs'), compatibility_date: '2026-11-19', workers_dev: false,
    r2_buckets: [{ binding: 'ARCHIVE_TEST', bucket_name: 'mapi-local-synthetic-key-provider' }] }));
  server = spawn(process.execPath, [resolve('node_modules/wrangler/bin/wrangler.js'), 'dev', '--local', '--config', config,
    '--ip', '127.0.0.1', '--port', String(port), '--inspector-port', String(inspector), '--persist-to', dir], {
    detached: true, stdio: ['ignore', 'ignore', 'inherit'], env: { ...process.env, WRANGLER_LOG_PATH: resolve(dir, 'wrangler.log'), WRANGLER_SEND_METRICS: 'false' },
  });
  let ready = false;
  for (let i = 0; i < 100; i++) {
    if (server.exitCode !== null || server.signalCode !== null) throw new Error('local workerd exited');
    try { ready = (await fetch(`http://127.0.0.1:${port}/ready`, { signal: AbortSignal.timeout(1000) })).status === 204; if (ready) break; }
    catch { await setTimeout(200); }
  }
  if (!ready) throw new Error('local workerd did not respond');
  const response = await fetch(`http://127.0.0.1:${port}/test`, { signal: AbortSignal.timeout(30000) });
  assert.equal(response.status, 200, 'synthetic key provider local workerd test');
  console.log('Synthetic archive key provider local workerd/R2 tests passed');
} finally {
  if (server && server.exitCode === null && server.signalCode === null) {
    const exited = once(server, 'exit');
    try { process.kill(-server.pid, 'SIGTERM'); } catch {}
    await exited;
  }
  await rm(dir, { recursive: true, force: true });
}
