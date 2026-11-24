import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { verifyUserAudit } from './phase1-benchmark-control.mjs';

async function port() {
  const server = createServer().listen(0, '127.0.0.1');
  await once(server, 'listening');
  const value = server.address().port;
  await new Promise(done => server.close(done));
  return value;
}
const directory = await mkdtemp(resolve(tmpdir(), 'mapi-phase1-bindings-'));
const processes = [];
let diagnostics = '';
try {
  const ownerPort = await port(), controlPort = await port(), callerPort = await port();
  const inspectors = [await port(), await port(), await port()];
  const origin = `http://localhost:${ownerPort}`;
  const key = (await readFile('.dev.vars.app', 'utf8')).match(/^MAPI_MASTER_KEY=(.+)$/m)?.[1];
  assert.ok(key, 'Generate local app secrets first');
  const operator = randomBytes(32).toString('base64url');
  const controlSecret = randomBytes(32).toString('base64url');
  const ownerVars = resolve(directory, 'owner.vars'), controlVars = resolve(directory, 'control.vars'), callerVars = resolve(directory, 'caller.vars');
  await writeFile(ownerVars, `MAPI_MASTER_KEY=${key}\nMAPI_OPERATOR_TOKEN=${operator}\nMAPI_APP_ORIGIN=${origin}\nMAPI_LOCAL_TEST=1\nMAPI_MANAGEMENT_ENABLED=1\nMAPI_RUNTIME_DIAGNOSTICS=1\nMAPI_PHASE1_ALLOW_BOOTSTRAP=1\nMAPI_PHASE1_CONTROL_TOKEN=${controlSecret}\n`, { mode: 0o600 });
  await writeFile(controlVars, `MAPI_OPERATOR_TOKEN=${operator}\nMAPI_PHASE1_CONTROL_TOKEN=${controlSecret}\n`, { mode: 0o600 });
  await writeFile(callerVars, 'MAPI_PHASE1_LOCAL_CALLER=1\n', { mode: 0o600 });
  function start(config, listen, inspector, vars) {
    const child = spawn(process.execPath, [resolve('node_modules/wrangler/bin/wrangler.js'), 'dev', '--local', '--config', config, '--env-file', vars, '--ip', '127.0.0.1', '--port', String(listen), '--inspector-port', String(inspector), '--persist-to', resolve(directory, 'state')], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, WRANGLER_LOG_PATH: resolve(directory, `${listen}.log`), WRANGLER_SEND_METRICS: 'false' } });
    for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { diagnostics = (diagnostics + chunk.toString()).slice(-12000); });
    processes.push(child);
    return child;
  }
  async function wait(child, listen) {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (child.exitCode !== null) throw Error('Local Worker exited');
      try { await fetch(`http://127.0.0.1:${listen}/`); return; } catch { await delay(200); }
    }
    throw Error('Local Worker did not start');
  }
  const owner = start('scripts/phase1-binding-owner.wrangler.jsonc', ownerPort, inspectors[0], ownerVars);
  await wait(owner, ownerPort);
  const admin = (path, data) => fetch(`${origin}${path}`, { method: data ? 'POST' : 'GET', headers: { authorization: `Bearer ${operator}`, 'content-type': 'application/json' }, ...(data ? { body: JSON.stringify(data) } : {}) });
  const init = await admin('/_mapi/admin/init', { name: 'Private binding test' });
  assert.equal(init.status, 200);
  const projectId = (await init.json()).projectId;
  const privateControl = start('wrangler.phase1-control-local.jsonc', controlPort, inspectors[1], controlVars);
  await wait(privateControl, controlPort);
  const caller = start('wrangler.phase1-caller-local.jsonc', callerPort, inspectors[2], callerVars);
  await wait(caller, callerPort);
  async function call(token, action, userId) {
    return fetch(`http://127.0.0.1:${callerPort}/`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ origin, action, userId }) });
  }
  assert.equal((await call('wrong', 'initialize-fence')).status, 404);
  let bootstrap;
  for (let attempt = 0; attempt < 40; attempt++) {
    bootstrap = await call(operator, 'initialize-fence');
    if (bootstrap.ok) break;
    await delay(250);
  }
  assert.equal(bootstrap.status, 200);
  assert.equal((await bootstrap.json()).result, true);
  assert.equal((await call(operator, 'initialize-fence')).status, 200);
  const create = await admin('/_mapi/admin/users', { email: `control-${randomUUID()}@example.test`, password: `Example-${randomUUID()}!` });
  assert.equal(create.status, 200);
  const userId = (await create.json()).userId;
  const status = await (await admin('/_mapi/admin/status')).json();
  assert.ok(status.bootId);
  assert.ok(status.reactorInitializations >= 1);
  assert.ok(status.wasmHighWaterBytes >= status.wasmMemoryBytes && status.wasmHighWaterBytes > 0);
  assert.equal(status.wasmHighWaterPages * 65536, status.wasmHighWaterBytes);
  // Wrangler forwards structured Worker console output asynchronously.
  let growthMarkers = [];
  for (let attempt = 0; attempt < 40; attempt++) {
    growthMarkers = [...diagnostics.matchAll(/\{"event":"mapi\.wasm\.highwater","bootId":"([0-9a-f-]+)","objectId":"([0-9a-f]{64})","wasmHighWaterBytes":([0-9]+)\}/gi)];
    if (growthMarkers.some(marker => marker[1] === status.bootId)) break;
    await delay(50);
  }
  const matching = growthMarkers.filter(marker => marker[1] === status.bootId);
  assert.ok(matching.length, 'Missing current-owner Wasm growth marker');
  assert.ok(matching.every(marker => Number.isSafeInteger(Number(marker[3])) && Number(marker[3]) > 0 && Number(marker[3]) % 65536 === 0 && Number(marker[3]) <= status.wasmHighWaterBytes));
  assert.equal((await call('wrong', 'project-token')).status, 404);
  let tokenResponse;
  for (let attempt = 0; attempt < 40; attempt++) {
    tokenResponse = await call(operator, 'project-token');
    if (tokenResponse.ok) break;
    await delay(250);
  }
  assert.equal(tokenResponse.status, 200);
  const token = (await tokenResponse.json()).result;
  assert.ok(typeof token === 'string' && token.length > 0);
  const user = await fetch(`${origin}/api/v1/users/${userId}`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(user.status, 200);
  const audit = await call(operator, 'user-audit', userId);
  assert.equal(audit.status, 200);
  assert.equal((await audit.json()).result, 1);
  const auditControl = async (_project, action, id) => {
    const response = await call(operator, action, id);
    if (!response.ok) throw Error('Private audit control unavailable');
    return (await response.json()).result;
  };
  await verifyUserAudit(auditControl, {}, userId);
  await assert.rejects(() => verifyUserAudit(auditControl, {}, 'user_missing'), /missing or duplicated/);
  const missing = await call(operator, 'user-audit', 'user_missing');
  assert.equal((await missing.json()).result, 0);
  assert.equal((await admin('/_mapi/local/freeze', {})).status, 204);
  assert.equal((await call(operator, 'project-token')).status, 503);
  console.log(`Private caller, control, registry and Go owner passed in three Wrangler processes for ${projectId}.`);
} catch (error) {
  if (diagnostics) console.error(diagnostics);
  throw error;
} finally {
  for (const child of processes.reverse()) if (child.exitCode === null && child.signalCode === null) {
    const stopped = once(child, 'exit'); child.kill('SIGTERM'); await stopped;
  }
  await rm(directory, { recursive: true, force: true });
}
