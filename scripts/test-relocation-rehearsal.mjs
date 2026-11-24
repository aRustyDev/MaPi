import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { makeRehearsalConfigs } from './relocation-rehearsal-config.mjs';
import { createPendingHandoff, exchangeHandoffOnce } from './rehearsal-handoff.mjs';

async function port() { const s = createServer().listen(0, '127.0.0.1'); await once(s, 'listening'); const n = s.address().port; await new Promise(done => s.close(done)); return n; }
const temporary = await mkdtemp(resolve(tmpdir(), 'mapi-p1-rehearsal-'));
const children = [];
let diagnostics = '';
try {
  const ports = await Promise.all(Array.from({ length: 8 }, () => port()));
  assert.equal(new Set(ports).size, ports.length, 'Port allocation collided');
  const [ownerPort, routerPort, controlPort, callerPort, ...inspectors] = ports;
  const origin = `http://127.0.0.1:${ownerPort}`, otherOrigin = `http://127.0.0.1:${routerPort}`;
  const directory = resolve(temporary, 'config');
  const manifest = await makeRehearsalConfigs({ directory, local: true, ownerOrigin: origin, routerOrigin: otherOrigin });
  const secret = randomBytes(32).toString('base64url'), operator = randomBytes(32).toString('base64url'), rehearsalOperator = randomBytes(32).toString('base64url'), phaseControl = randomBytes(32).toString('base64url');
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  const key = Buffer.from(JSON.stringify({ id: 'synthetic-master', pem: privateKey })).toString('base64');
  const vars = async (name, text) => { const path = resolve(temporary, `${name}.vars`); await writeFile(path, text, { mode: 0o600 }); return path; };
  const ownerVars = await vars('owner', `MAPI_MASTER_KEY=${key}\nMAPI_OPERATOR_TOKEN=${operator}\nMAPI_RELOCATION_CONTROL_TOKEN=${secret}\nMAPI_PHASE1_CONTROL_TOKEN=${phaseControl}\nMAPI_PHASE1_ALLOW_BOOTSTRAP=1\n`);
  const emptyVars = await vars('empty', '');
  function start(name, listen, inspector, envFile) {
    const child = spawn(process.execPath, [resolve('node_modules/wrangler/bin/wrangler.js'), 'dev', '--local', '--config', resolve(directory, `${name}.json`), '--env-file', envFile, '--ip', '127.0.0.1', '--port', String(listen), '--inspector-port', String(inspector), '--persist-to', resolve(temporary, 'state')], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, WRANGLER_LOG_PATH: resolve(temporary, `${name}.log`), WRANGLER_SEND_METRICS: 'false' } });
    for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { diagnostics = (diagnostics + chunk.toString()).slice(-12000); });
    children.push(child); return child;
  }
  async function ready(child, listen) {
    for (let i = 0; i < 100; i++) { if (child.exitCode !== null) throw Error('Local Worker exited'); try { await fetch(`http://127.0.0.1:${listen}/`); return; } catch { await delay(200); } }
    throw Error('Local Worker did not start');
  }
  const owner = start('owner', ownerPort, inspectors[0], ownerVars); await ready(owner, ownerPort);
  const router = start('router', routerPort, inspectors[1], emptyVars); await ready(router, routerPort);
  const admin = (base, path, data) => fetch(`${base}${path}`, { method: data ? 'POST' : 'GET', headers: { authorization: `Bearer ${operator}`, 'content-type': 'application/json' }, ...(data ? { body: JSON.stringify(data) } : {}) });
  const init = await admin(origin, '/_mapi/admin/init', { name: 'Synthetic singleton' }); assert.equal(init.status, 200); const projectId = (await init.json()).projectId;
  const createOther = await admin(origin, '/_mapi/admin/projects', { name: 'Synthetic other', origin: otherOrigin }); assert.equal(createOther.status, 200); const otherId = (await createOther.json()).projectId; assert.notEqual(otherId, projectId);
  const email = `source-${randomUUID()}@example.test`, otherEmail = `other-${randomUUID()}@example.test`, password = `Synthetic-${randomUUID()}!`;
  assert.equal((await admin(origin, '/_mapi/admin/users', { email, password })).status, 200);
  const otherUser = await admin(otherOrigin, '/_mapi/admin/users', { email: otherEmail, password }); assert.equal(otherUser.status, 200); const otherUserId = (await otherUser.json()).userId;
  async function login(base, username) { return fetch(`${base}/login`, { method: 'POST', headers: { origin: base, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ email: username, password }), redirect: 'manual' }); }
  const initialLogin = await login(origin, email); assert.equal(initialLogin.status, 303); const cookie = initialLogin.headers.get('set-cookie')?.split(';', 1)[0]; assert.ok(cookie);
  const revokedLogin = await login(origin, email); assert.equal(revokedLogin.status, 303); const revokedCookie = revokedLogin.headers.get('set-cookie')?.split(';', 1)[0]; assert.ok(revokedCookie); assert.notEqual(revokedCookie, cookie);
  const revocablePage = await fetch(`${origin}/app`, { headers: { cookie: revokedCookie }, redirect: 'manual' });
  const csrf = (await revocablePage.text()).match(/name="csrf" value="([A-Za-z0-9_-]+)"/)?.[1]; assert.ok(csrf);
  assert.equal((await fetch(`${origin}/logout`, { method: 'POST', headers: { origin, cookie: revokedCookie }, body: new URLSearchParams({ csrf }), redirect: 'manual' })).status, 303);
  assert.equal((await login(otherOrigin, otherEmail)).status, 303);
  const pendingHandoff = await createPendingHandoff(origin, projectId, email, password);
  const counts = await (await admin(origin, '/_mapi/admin/test/counts')).json();
  const moveId = `synthetic-${randomUUID()}`;
  const controlVars = await vars('control', `MAPI_REHEARSAL_OPERATOR_TOKEN=${rehearsalOperator}\nMAPI_RELOCATION_CONTROL_TOKEN=${secret}\nMAPI_PHASE1_CONTROL_TOKEN=${phaseControl}\nMAPI_REHEARSAL_PROJECT_ID=${projectId}\nMAPI_REHEARSAL_MOVE_ID=${moveId}\nMAPI_REHEARSAL_OTHER_ORIGIN=${otherOrigin}\nMAPI_REHEARSAL_OTHER_PROJECT_ID=${otherId}\n`);
  const control = start('control', controlPort, inspectors[2], controlVars); await ready(control, controlPort);
  let caller = start('caller', callerPort, inspectors[3], emptyVars); await ready(caller, callerPort);
  const advance = token => fetch(`http://127.0.0.1:${callerPort}/`, { method: 'POST', headers: { authorization: `Bearer ${token}` } });
  assert.equal((await advance('wrong')).status, 404);
  const tokenResponse = await fetch(`http://127.0.0.1:${callerPort}/management-token`, { method: 'POST', headers: { authorization: `Bearer ${rehearsalOperator}` } });
  assert.equal(tokenResponse.status, 200); const managementToken = (await tokenResponse.json()).token; assert.ok(managementToken);
  let progress, calls = 0, otherLogins = 0;
  const restarted = new Set();
  for (;;) {
    const query = calls % 2 === 1;
    const [response, management] = await Promise.all([
      advance(rehearsalOperator),
      fetch(`${otherOrigin}${query ? `/api/v1/users/query?project_id=${encodeURIComponent(otherId)}` : `/api/v1/users/${encodeURIComponent(otherUserId)}`}`, { method: query ? 'POST' : 'GET', headers: { authorization: `Bearer ${managementToken}`, origin: otherOrigin, ...(query ? { 'content-type': 'application/json' } : {}) }, ...(query ? { body: '{}' } : {}) }),
    ]);
    assert.equal(response.status, 200); assert.equal(management.status, 200); progress = await response.json(); calls++;
    if (calls === 1) { assert.equal(progress.phase, 'importing'); assert.equal((await admin(origin, '/_mapi/admin/status')).status, 503); }
    if (['importing', 'reconciling', 'committed'].includes(progress.phase) && !restarted.has(progress.phase)) {
      restarted.add(progress.phase);
      const stopped = once(caller, 'exit'); caller.kill('SIGTERM'); await stopped;
      caller = start('caller', callerPort, inspectors[3], emptyVars); await ready(caller, callerPort);
    }
    if (calls % 20 === 0) { assert.equal((await login(otherOrigin, otherEmail)).status, 303); otherLogins++; }
    if (progress.done) break;
    assert.ok(calls < 1000, 'Coordinator failed to terminate');
  }
  assert.equal(progress.phase, 'retired'); assert.equal(progress.generation, 2);
  let evidenceCursor = 0; const evidenceTables = new Set();
  for (;;) {
    const response = await fetch(`http://127.0.0.1:${callerPort}/evidence?after=${evidenceCursor}`, { method: 'POST', headers: { authorization: `Bearer ${rehearsalOperator}` } });
    assert.equal(response.status, 200); const evidence = await response.json(); assert.equal(evidence.complete, true);
    for (const page of evidence.pages) { assert.match(page.digest, /^[0-9a-f]{64}$/); evidenceTables.add(page.table); }
    evidenceCursor = evidence.next; if (evidence.done) break;
  }
  assert.ok(evidenceTables.has('users') && evidenceTables.has('events'));
  const staleProbe = await fetch(`http://127.0.0.1:${callerPort}/stale-probe`, { method: 'POST', headers: { authorization: `Bearer ${rehearsalOperator}` } });
  assert.equal(staleProbe.status, 200); assert.equal((await staleProbe.json()).rejected, true);
  assert.deepEqual(await (await admin(origin, '/_mapi/admin/test/counts')).json(), counts);
  const sameProject = await admin(origin, '/_mapi/admin/init', { name: 'Synthetic singleton' });
  assert.equal(sameProject.status, 200); assert.equal((await sameProject.json()).projectId, projectId);
  assert.equal((await fetch(`${origin}/app`, { headers: { cookie }, redirect: 'manual' })).status, 200);
  assert.equal((await fetch(`${origin}/app`, { headers: { cookie: revokedCookie }, redirect: 'manual' })).status, 303);
  await exchangeHandoffOnce(origin, projectId, pendingHandoff);
  assert.equal((await login(origin, email)).status, 303);
  assert.equal((await login(otherOrigin, otherEmail)).status, 303);
  assert.equal((await login(otherOrigin, email)).status, 401);
  const postEmail = `post-${randomUUID()}@example.test`;
  const postUser = await admin(origin, '/_mapi/admin/users', { email: postEmail, password }); assert.equal(postUser.status, 200);
  assert.equal((await login(origin, postEmail)).status, 303);
  assert.equal((await login(otherOrigin, postEmail)).status, 401);
  console.log(JSON.stringify({ ok: true, names: manifest.names, projectIdPreserved: true, calls, managementReads: calls, callerRestarts: [...restarted], otherLogins, counts, generation: progress.generation }));
} catch (error) { if (diagnostics) console.error(diagnostics); throw error; }
finally { for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM'); await Promise.all(children.filter(child => child.exitCode === null && child.signalCode === null).map(child => once(child, 'exit'))); await rm(temporary, { recursive: true, force: true }); }
