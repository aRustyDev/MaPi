// Local-only synthetic mechanism probe; this does not test production cutover.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { setTimeout } from 'node:timers/promises';
async function port() {
  const server = createServer().listen(0, '127.0.0.1');
  await once(server, 'listening');
  const value = server.address().port;
  await new Promise(done => server.close(done));
  return value;
}
const dir = await mkdtemp(join(tmpdir(), 'mapi-active-snapshot-'));
const address = await port(), inspector = await port();
const token = randomBytes(32).toString('hex'), envFile = join(dir, 'synthetic.env');
await writeFile(envFile, `TEST_TOKEN=${token}\n`, { mode: 0o600 });
const child = spawn(process.execPath, [resolve('node_modules/wrangler/bin/wrangler.js'), 'dev', '--local', '--config', 'scripts/relocation-active-snapshot-probe.wrangler.jsonc', '--env-file', envFile, '--ip', '127.0.0.1', '--port', String(address), '--inspector-port', String(inspector), '--persist-to', dir], {
  env: { ...process.env, WRANGLER_LOG_PATH: join(dir, 'wrangler.log'), WRANGLER_SEND_METRICS: 'false' }, stdio: ['ignore', 'ignore', 'pipe'],
});
let diagnostic = '';
child.stderr.on('data', chunk => { diagnostic = (diagnostic + chunk).slice(-3000); });
try {
  let denied;
  for (let i = 0; i < 120; i++) {
    if (child.exitCode !== null) throw Error('Local Workerd exited');
    try { denied = await fetch(`http://127.0.0.1:${address}/`, { signal: AbortSignal.timeout(5000) }); break; }
    catch (error) { if (error.name === 'TimeoutError') throw error; await setTimeout(100); }
  }
  if (!denied) throw Error('Local Workerd did not start');
  assert.equal(denied.status, 401, 'Unauthenticated synthetic probe must be denied');
  const response = await fetch(`http://127.0.0.1:${address}/`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(120000) });
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.deepEqual(body, { ok: true, nearLimitBytes: 8300000, pages: 127, eviction: true, pendingReservationResume: true, staleFinalization: true, atomicFreeze: true, malformedBytesPreserved: true });
  console.log('Synthetic active-source marker probe passed; production relocation and peak memory were not tested.');
} catch (error) {
  if (diagnostic) process.stderr.write(diagnostic);
  throw error;
} finally {
  if (child.exitCode === null && child.signalCode === null) { const stopped = once(child, 'exit'); child.kill('SIGTERM'); await stopped; }
  await rm(dir, { recursive: true, force: true });
}
