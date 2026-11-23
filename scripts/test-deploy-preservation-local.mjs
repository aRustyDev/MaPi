import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

// This harness is local-only. It creates its own configuration, credentials,
// registry, objects, and persistence directory. It never accepts a target URL.
const directory = await mkdtemp(resolve(tmpdir(), 'mapi-preservation-'));
const minimalEnv = { PATH: process.env.PATH, XDG_CONFIG_HOME: resolve(directory, 'config'), XDG_CACHE_HOME: resolve(directory, 'cache'), TMPDIR: directory, WRANGLER_SEND_METRICS: 'false', WRANGLER_LOG_PATH: resolve(directory, 'wrangler.log') };
let worker, testChild;
let interrupted = false;
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { interrupted = true; testChild?.kill('SIGTERM'); worker?.kill('SIGTERM'); });

async function stopWorker() {
  const child = worker; worker = undefined;
  if (!child) return;
  if (child.exitCode === null && child.signalCode === null) {
    const done = once(child, 'exit');
    child.kill('SIGTERM');
    const timer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 10000);
    try { await done; } finally { clearTimeout(timer); }
  }
  try { process.kill(-child.pid, 'SIGTERM'); } catch {}
}
async function availablePort() {
  const socket = createServer();
  socket.listen(0, '127.0.0.1');
  await once(socket, 'listening');
  const port = socket.address().port;
  await new Promise((done, reject) => socket.close(error => error ? reject(error) : done()));
  return port;
}
async function startWorker(port, config, vars) {
  const child = spawn(process.execPath, [resolve('node_modules/wrangler/bin/wrangler.js'), 'dev', '--local', '--config', config, '--env-file', vars, '--ip', '127.0.0.1', '--port', String(port), '--inspector-port', '0', '--persist-to', resolve(directory, 'state')], { env: minimalEnv, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  worker = child;
  let output = '';
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { output = (output + chunk.toString()).slice(-16000); });
  const expected = `Ready on http://127.0.0.1:${port}`;
  for (let n = 0; n < 400; n++) {
    if (interrupted || child.exitCode !== null || child.signalCode !== null) throw Error('Local Worker exited before startup');
    if (output.includes(expected)) return;
    await delay(200);
  }
  throw Error('Local Worker startup timed out');
}
async function preservation(mode, origin, userFile, stateFile) {
  const child = spawn(process.execPath, [resolve('scripts/test-deploy-preservation.mjs'), mode], { env: { ...minimalEnv, MAPI_URL: origin, MAPI_TEST_USER_FILE: userFile, MAPI_TEST_STATE_FILE: stateFile }, stdio: 'ignore' });
  testChild = child;
  const timer = setTimeout(() => child.kill('SIGKILL'), 120000);
  let code, signal;
  try { [code, signal] = await once(child, 'exit'); } finally { clearTimeout(timer); testChild = undefined; }
  if (interrupted || code !== 0) throw Error(`Preservation ${mode} failed (exit ${code ?? signal})`);
}
try {
  const port = await availablePort();
  const origin = `http://127.0.0.1:${port}`;
  const operator = randomBytes(32).toString('base64url');
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  const master = Buffer.from(JSON.stringify({ id: 'synthetic-master', pem: privateKey })).toString('base64');
  const config = resolve(directory, 'worker.json'), vars = resolve(directory, 'worker.vars');
  const userFile = resolve(directory, 'user.json'), stateFile = resolve(directory, 'sessions.json');
  await writeFile(config, JSON.stringify({ name: `local-preservation-${randomUUID()}`, main: resolve('worker/phase1-owner.js'), compatibility_date: '2026-11-19', workers_dev: false, assets: { directory: resolve('worker/assets'), binding: 'ASSETS', run_worker_first: true }, durable_objects: { bindings: [{ name: 'NEXTGEN_APPLICATION', class_name: 'NextgenApplication' }, { name: 'PROJECT_REGISTRY', class_name: 'ProjectRegistry' }] }, migrations: [{ tag: 'v1', new_sqlite_classes: ['NextgenApplication', 'ProjectRegistry'] }], vars: { MAPI_OFFICIAL_LOGIN: '1', MAPI_OIDC_EXPERIMENTAL: '1', MAPI_MANAGEMENT_ENABLED: '1', MAPI_PHASE1_ALLOW_BOOTSTRAP: '1', MAPI_APP_ORIGIN: origin } }), { mode: 0o600, flag: 'wx' });
  await writeFile(vars, `MAPI_MASTER_KEY=${master}\nMAPI_OPERATOR_TOKEN=${operator}\n`, { mode: 0o600, flag: 'wx' });
  await startWorker(port, config, vars);
  const admin = (path, body) => fetch(origin + path, { method: 'POST', headers: { authorization: `Bearer ${operator}`, 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(30000) });
  const initialized = await admin('/_mapi/admin/init', { name: 'Synthetic preservation project' });
  assert.equal(initialized.status, 200, 'Synthetic project initialization');
  const { projectId } = await initialized.json();
  assert.ok(projectId);
  const email = `preservation-${randomUUID()}@example.test`, password = `Synthetic-${randomUUID()}!`;
  const created = await admin('/_mapi/admin/users', { email, password });
  assert.equal(created.status, 200, 'Synthetic user initialization');
  await writeFile(userFile, JSON.stringify({ projectId, email, password }), { mode: 0o600, flag: 'wx' });
  await preservation('prepare', origin, userFile, stateFile);
  await stopWorker();
  await startWorker(port, config, vars);
  await preservation('verify', origin, userFile, stateFile);
  console.log('Local restart preserved an active session and retained revoked-session rejection.');
} finally {
  await stopWorker();
  await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
