import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { makeRehearsalConfigs } from './relocation-rehearsal-config.mjs';
import { createPendingHandoff, exchangeHandoffOnce } from './rehearsal-handoff.mjs';
import { createRehearsalTraffic, classifyClosure } from './rehearsal-traffic.mjs';
import { validateRehearsalManagementResult } from './rehearsal-management.mjs';
import { readRehearsalCounts, assertRehearsalEvidenceCounts, rehearsalEvidenceDone } from './rehearsal-evidence.mjs';
import { runBenchmarkManagement } from './phase1-benchmark-management.mjs';

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
  const moveId = `synthetic-${randomUUID()}`;
  for (const [role, main] of [['owner', 'phase1-restart-owner.js'], ['control', 'phase1-restart-control.js']]) {
    const path = resolve(directory, `${role}.json`), config = JSON.parse(await readFile(path, 'utf8'));
    config.main = resolve(`worker/${main}`);
    config.vars.MAPI_RESTART_REHEARSAL = '1';
    if (role === 'owner') { config.vars.MAPI_RESTART_ORIGIN = origin; config.vars.MAPI_RESTART_MOVE_ID = moveId; }
    await writeFile(path, JSON.stringify(config));
  }
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
  const sourceUser = await admin(origin, '/_mapi/admin/users', { email, password }); assert.equal(sourceUser.status, 200); const userId = (await sourceUser.json()).userId;
  const otherUser = await admin(otherOrigin, '/_mapi/admin/users', { email: otherEmail, password }); assert.equal(otherUser.status, 200); const otherUserId = (await otherUser.json()).userId;
  async function login(base, username) { return fetch(`${base}/login`, { method: 'POST', headers: { origin: base, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ email: username, password }), redirect: 'manual' }); }
  const initialLogin = await login(origin, email); assert.equal(initialLogin.status, 303); const cookie = initialLogin.headers.get('set-cookie')?.split(';', 1)[0]; assert.ok(cookie);
  const revokedLogin = await login(origin, email); assert.equal(revokedLogin.status, 303); const revokedCookie = revokedLogin.headers.get('set-cookie')?.split(';', 1)[0]; assert.ok(revokedCookie); assert.notEqual(revokedCookie, cookie);
  const revocablePage = await fetch(`${origin}/app`, { headers: { cookie: revokedCookie }, redirect: 'manual' });
  const csrf = (await revocablePage.text()).match(/name="csrf" value="([A-Za-z0-9_-]+)"/)?.[1]; assert.ok(csrf);
  assert.equal((await fetch(`${origin}/logout`, { method: 'POST', headers: { origin, cookie: revokedCookie }, body: new URLSearchParams({ csrf }), redirect: 'manual' })).status, 303);
  assert.equal((await login(otherOrigin, otherEmail)).status, 303);
  const pendingHandoff = await createPendingHandoff(origin, projectId, email, password);
  const counts = await readRehearsalCounts(await admin(origin, '/_mapi/admin/test/counts'));
  const controlVars = await vars('control', `MAPI_REHEARSAL_OPERATOR_TOKEN=${rehearsalOperator}\nMAPI_RELOCATION_CONTROL_TOKEN=${secret}\nMAPI_PHASE1_CONTROL_TOKEN=${phaseControl}\nMAPI_REHEARSAL_PROJECT_ID=${projectId}\nMAPI_REHEARSAL_MOVE_ID=${moveId}\nMAPI_REHEARSAL_OTHER_ORIGIN=${otherOrigin}\nMAPI_REHEARSAL_OTHER_PROJECT_ID=${otherId}\n`);
  let control = start('control', controlPort, inspectors[2], controlVars); await ready(control, controlPort);
  let caller = start('caller', callerPort, inspectors[3], emptyVars); await ready(caller, callerPort);
  const advance = token => fetch(`http://127.0.0.1:${callerPort}/`, { method: 'POST', headers: { authorization: `Bearer ${token}` } });
  assert.equal((await advance('wrong')).status, 404);
  const tokenResponse = await fetch(`http://127.0.0.1:${callerPort}/management-token`, { method: 'POST', headers: { authorization: `Bearer ${rehearsalOperator}` } });
  assert.equal(tokenResponse.status, 200); const managementToken = (await tokenResponse.json()).token; assert.ok(managementToken);
  const traffic = createRehearsalTraffic({ state: 'prepared', rehearsalId: manifest.id, origin, otherOrigin, email, otherEmail, password, cookie }, { allowLoopback: true });
  await traffic.prepare();
  let progress, calls = 0, trafficSamples = 0, closedSamples = 0, previousPhase = 'frozen';
  const restarted = [];
  async function probe() {
    const response = await fetch(`http://127.0.0.1:${callerPort}/restart-probe`, { method: 'POST', headers: { authorization: `Bearer ${rehearsalOperator}` } });
    assert.equal(response.status, 200); return response.json();
  }
  async function restart(stage) {
    const before = await probe();
    const response = await fetch(`http://127.0.0.1:${callerPort}/restart?stage=${stage}`, { method: 'POST', headers: { authorization: `Bearer ${rehearsalOperator}` } });
    assert.equal(response.status, 503, `Expected deliberate abort at ${stage}`);
    for (const child of [caller, control]) { const stopped = once(child, 'exit'); child.kill('SIGTERM'); await stopped; }
    control = start('control', controlPort, inspectors[2], controlVars); await ready(control, controlPort);
    caller = start('caller', callerPort, inspectors[3], emptyVars); await ready(caller, callerPort);
    let after; for (let i = 0; i < 20; i++) { try { after = await probe(); break; } catch { await delay(100); } }
    assert.ok(after, `Coordinator did not become available after ${stage}`);
    assert.notEqual(after.bootId, before.bootId, `Coordinator did not restart at ${stage}`);
    assert.equal(after.markers.length, restarted.length + 1);
    assert.equal(after.markers.at(-1).stage, stage);
    assert.equal(after.markers.at(-1).boot_id, before.bootId);
    restarted.push(stage);
  }
  await restart('frozen');
  assert.equal((await admin(origin, '/_mapi/admin/status')).status, 503);
  for (;;) {
    const query = calls % 2 === 1;
    const controlStarted = performance.now();
    const [control, management, sample] = await Promise.all([
      advance(rehearsalOperator).then(response => ({ response, ended: performance.now() })),
      fetch(`${otherOrigin}${query ? `/api/v1/users/query?project_id=${encodeURIComponent(otherId)}` : `/api/v1/users/${encodeURIComponent(otherUserId)}`}`, { method: query ? 'POST' : 'GET', headers: { authorization: `Bearer ${managementToken}`, origin: otherOrigin, ...(query ? { 'content-type': 'application/json' } : {}) }, ...(query ? { body: '{}' } : {}) }),
      calls % 20 === 0 && trafficSamples < 8 && previousPhase !== 'committed' ? traffic.sample() : Promise.resolve(null),
    ]);
    if (sample) {
      for (const value of Object.values(sample)) assert.ok(value.started < control.ended && controlStarted < value.ended, 'Client request intervals must overlap the control request');
      trafficSamples++;
    }
    assert.equal(control.response.status, 200); assert.equal(management.status, 200); progress = await control.response.json(); calls++;
    if (sample && classifyClosure(previousPhase, progress.phase) === 'fenced') closedSamples++;
    previousPhase = progress.phase;
    validateRehearsalManagementResult(await management.json(), { userId, otherUserId }, query);
    if (progress.phase === 'importing' && progress.nextChunk >= 2 && !restarted.includes('importing')) await restart('importing');
    if (progress.phase === 'committed' && !restarted.includes('committed')) { await restart('committed'); await restart('activated'); }
    if (progress.done) break;
    assert.ok(calls < 1000, 'Coordinator failed to terminate');
  }
  assert.deepEqual(restarted, ['frozen', 'importing', 'committed', 'activated']);
  assert.ok(trafficSamples > 0 && closedSamples > 0, 'Missing closed-route traffic overlap');
  assert.equal(progress.phase, 'retired'); assert.equal(progress.generation, 2);
  let evidenceCursor = 0; const evidenceCounts = new Map();
  for (;;) {
    const response = await fetch(`http://127.0.0.1:${callerPort}/evidence?after=${evidenceCursor}`, { method: 'POST', headers: { authorization: `Bearer ${rehearsalOperator}` } });
    assert.equal(response.status, 200); const evidence = await response.json();
    const done = rehearsalEvidenceDone(evidence);
    for (const page of evidence.pages) {
      assert.match(page.digest, /^[0-9a-f]{64}$/);
      assert.ok(Number.isSafeInteger(page.sequence) && page.sequence > evidenceCursor, 'Evidence page sequence did not advance');
      assert.ok(Number.isSafeInteger(page.count) && page.count >= 0, 'Invalid evidence row count');
      assert.equal(typeof page.table, 'string');
      evidenceCursor = page.sequence;
      const total = (evidenceCounts.get(page.table) ?? 0) + page.count;
      assert.ok(Number.isSafeInteger(total), 'Evidence row count overflow');
      evidenceCounts.set(page.table, total);
    }
    assert.equal(evidence.next, evidenceCursor, 'Evidence cursor disagrees with the returned pages');
    if (done) break;
    assert.ok(evidence.pages.length, 'Incomplete evidence page did not advance');
  }
  assertRehearsalEvidenceCounts(evidenceCounts, counts);
  const staleProbe = await fetch(`http://127.0.0.1:${callerPort}/stale-probe`, { method: 'POST', headers: { authorization: `Bearer ${rehearsalOperator}` } });
  assert.equal(staleProbe.status, 200); assert.equal((await staleProbe.json()).rejected, true);
  assert.deepEqual(await readRehearsalCounts(await admin(origin, '/_mapi/admin/test/counts')), counts);
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
  const benchmark = await runBenchmarkManagement({ origin: otherOrigin, projectId: otherId, userId: otherUserId, managementToken, operator }, userId, 1, { control: async (_project, action) => { assert.equal(action, 'user-audit'); return 1; } });
  assert.equal(benchmark.attempts, 6); assert.equal(benchmark.operations, 6); assert.equal(benchmark.auditVerified, true); assert.equal(benchmark.error, undefined);
  console.log(JSON.stringify({ ok: true, names: manifest.names, projectIdPreserved: true, calls, managementHttpSuccesses: calls, managementIdentityVerified: calls, coordinatorRestarts: [...restarted], trafficSamples, closedSamples, counts, generation: progress.generation, benchmarkManagementVerified: benchmark.operations }));
} catch (error) { if (diagnostics) console.error(diagnostics); throw error; }
finally { for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM'); await Promise.all(children.filter(child => child.exitCode === null && child.signalCode === null).map(child => once(child, 'exit'))); await rm(temporary, { recursive: true, force: true }); }
