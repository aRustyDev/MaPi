import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { setTimeout } from 'node:timers/promises';

async function port() {
  const socket = createServer().listen(0, '127.0.0.1');
  await once(socket, 'listening');
  const value = socket.address().port;
  await new Promise(done => socket.close(done));
  return value;
}
const dir = await mkdtemp(resolve(tmpdir(), 'mapi-export-replay-'));
const address = await port(), inspector = await port();
const config = resolve(dir, 'wrangler.json');
await writeFile(config, JSON.stringify({
  name: 'mapi-local-export-replay-integrity',
  main: resolve('scripts/export-replay-integrity-test-worker.mjs'),
  compatibility_date: '2026-11-19',
  durable_objects: { bindings: [{ name: 'OWNER', class_name: 'ExportReplayIntegrity' }] },
  migrations: [{ tag: 'v1', new_sqlite_classes: ['ExportReplayIntegrity'] }],
}));
const server = spawn(process.execPath, [resolve('node_modules/wrangler/bin/wrangler.js'), 'dev', '--local', '--config', config, '--ip', '127.0.0.1', '--port', String(address), '--inspector-port', String(inspector), '--persist-to', dir], {
  stdio: ['ignore', 'ignore', 'inherit'],
  env: { ...process.env, WRANGLER_LOG_PATH: resolve(dir, 'wrangler.log'), WRANGLER_SEND_METRICS: 'false' },
});
try {
  let response;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (server.exitCode !== null) throw Error('Wrangler exited before readiness');
    try { response = await fetch(`http://127.0.0.1:${address}/`); break; }
    catch { await setTimeout(200); }
  }
  if (!response) throw Error('Wrangler did not become ready');
  const result = await response.json();
  assert.equal(response.status, 200, result.error);
  assert.equal(result.ok, true);
  console.log('Finalized export replay rejects inconsistent durable records.');
} finally {
  if (server.exitCode === null && server.signalCode === null) {
    const stopped = once(server, 'exit'); server.kill('SIGTERM'); await stopped;
  }
  await rm(dir, { recursive: true, force: true });
}
