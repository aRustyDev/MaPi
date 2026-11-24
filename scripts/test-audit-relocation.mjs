import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { setTimeout } from 'node:timers/promises';

async function port() { const s = createServer().listen(0, '127.0.0.1'); await once(s, 'listening'); const p = s.address().port; await new Promise(done => s.close(done)); return p; }
const dir = await mkdtemp(resolve(tmpdir(), 'mapi-audit-relocation-')), address = await port(), inspector = await port();
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
const master = Buffer.from(JSON.stringify({ id: 'master-test', pem: privateKey })).toString('base64');
const envFile = resolve(dir, 'worker.env'); await writeFile(envFile, `MAPI_MASTER_KEY=${master}\n`, { mode: 0o600 });
const server = spawn(process.execPath, [resolve('node_modules/wrangler/bin/wrangler.js'), 'dev', '--local', '--config', 'worker/generated/audit-relocation-test.wrangler.jsonc', '--env-file', envFile, '--ip', '127.0.0.1', '--port', String(address), '--inspector-port', String(inspector), '--persist-to', dir], { stdio: ['ignore', 'ignore', 'inherit'], env: { ...process.env, WRANGLER_LOG_PATH: resolve(dir, 'wrangler.log'), WRANGLER_SEND_METRICS: 'false' } });
try {
  let response;
  for (let i = 0; i < 100; i++) { if (server.exitCode !== null) throw Error('local workerd exited'); try { response = await fetch(`http://127.0.0.1:${address}/`, { signal: AbortSignal.timeout(120000) }); break; } catch (error) { if (error.name === 'TimeoutError') throw error; await setTimeout(200); } }
  if (!response) throw Error('local workerd did not start');
  const result = await response.json();
  if (response.status !== 200) throw Error(`local audit rehearsal HTTP ${response.status}: ${result.error}`);
  assert.equal(result.ok, true); assert.equal(result.tables, 59); assert.equal(result.users, 1); assert.ok(result.events > 0); assert.equal(result.goAuditRead, true); assert.equal(result.auditIsolation, true);
  console.log(`Go audit list and event reads preserved after local relocation; ${result.events} historical events; second project isolated; JSON object order differed: ${result.auditJsonKeyOrderDiffers}.`);
} finally {
  if (server.exitCode === null && server.signalCode === null) { const stopped = once(server, 'exit'); server.kill('SIGTERM'); await stopped; }
  await rm(dir, { recursive: true, force: true });
}
