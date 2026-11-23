import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { setTimeout } from 'node:timers/promises';
async function freePort() { const s = createServer().listen(0, '127.0.0.1'); await once(s, 'listening'); const n = s.address().port; await new Promise((done) => s.close(done)); return n; }
const dir = await mkdtemp(resolve(tmpdir(), 'mapi-shared-management-'));
let owner, management, diagnostics = '';
try {
 const ownerPort = await freePort(), managementPort = await freePort(), inspector1 = await freePort(), inspector2 = await freePort();
 const a = `http://localhost:${ownerPort}`, b = `http://localhost:${ownerPort + 1}`;
 const master = (await readFile('.dev.vars.app', 'utf8')).match(/^MAPI_MASTER_KEY=(.+)$/m)?.[1];
 if (!master) throw Error('Generate local app secrets first');
 const operator = randomBytes(32).toString('hex');
 const ownerVars = resolve(dir, 'owner.vars'), managementVars = resolve(dir, 'management.vars');
 await writeFile(ownerVars, `MAPI_MASTER_KEY=${master}\nMAPI_OPERATOR_TOKEN=${operator}\nMAPI_APP_ORIGIN=${a}\nMAPI_LOCAL_TEST=1\nMAPI_OFFICIAL_LOGIN=1\n`, { mode: 0o600 });
 await writeFile(managementVars, 'MAPI_MANAGEMENT_ENABLED=1\n', { mode: 0o600 });
 function start(config, port, inspector, vars) {
  const child = spawn(process.execPath, [resolve('node_modules/wrangler/bin/wrangler.js'), 'dev', '--local', '--config', config, '--env-file', vars, '--ip', '127.0.0.1', '--port', String(port), '--inspector-port', String(inspector), '--persist-to', resolve(dir, 'state')], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, WRANGLER_LOG_PATH: resolve(dir, `${port}.log`), WRANGLER_SEND_METRICS: 'false' } });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { diagnostics = (diagnostics + chunk.toString()).slice(-18000); });
  return child;
 }
 const request = (port, origin, path, { method = 'GET', body, token, cookie, headers = {} } = {}) => new Promise((done, reject) => {
  const target = new URL(origin), merged = { host: target.host, ...headers }; if (token) merged.authorization = `Bearer ${token}`; if (cookie) merged.cookie = cookie;
  const req = http.request({ hostname: '127.0.0.1', port, path, method, headers: merged }, res => { const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => { const text = Buffer.concat(chunks).toString(); let data; try { data = JSON.parse(text); } catch { data = null; } done({ status: res.statusCode, headers: res.headers, text, data }); }); });
  req.on('error', reject); req.setTimeout(30000, () => req.destroy(Error('request timeout'))); if (body !== undefined) req.write(body); req.end();
 });
 async function wait(port, process) { for (let attempt = 0; ; attempt++) { if (process.exitCode !== null || attempt === 100) throw Error('Local worker failed to start'); try { await request(port, a, '/_mapi/admin/status'); return; } catch { await setTimeout(200); } } }
 const admin = (origin, path, data) => request(ownerPort, origin, path, { method: data ? 'POST' : 'GET', token: operator, headers: { 'content-type': 'application/json' }, ...(data ? { body: JSON.stringify(data) } : {}) });
 owner = start('scripts/shared-owner-test.wrangler.jsonc', ownerPort, inspector1, ownerVars); await wait(ownerPort, owner);
 const init = await admin(a, '/_mapi/admin/init', { name: 'Shared A' }); assert.equal(init.status, 200); const projectA = init.data.projectId;
 const createdB = await admin(a, '/_mapi/admin/projects', { name: 'Shared B', origin: b }); assert.equal(createdB.status, 200); const projectB = createdB.data.projectId;
 const password = `Example-${randomUUID()}!`, email = `shared-${randomUUID()}@example.test`;
 const userA = await admin(a, '/_mapi/admin/users', { email, password }); const userB = await admin(b, '/_mapi/admin/users', { email, password }); assert.equal(userA.status, 200); assert.equal(userB.status, 200);
 const tokenA = (await admin(a, '/_mapi/test/management-token')).data.token, tokenB = (await admin(b, '/_mapi/test/management-token')).data.token;
 management = start('wrangler.shared-management.jsonc', managementPort, inspector2, managementVars); await wait(managementPort, management);
 const query = (origin, token, project, extra = {}) => request(managementPort, origin, `/api/v1/users/query?project_id=${project}`, { method: 'POST', body: '{}', token, cookie: extra.cookie, headers: { 'content-type': 'application/json', ...extra.headers } });
 // Let the external-DO local service registration settle, not merely its HTTP listener.
 let listA;
 for (let i = 0; i < 40; i++) { listA = await query(a, tokenA, projectA); if (listA.status === 200) break; await setTimeout(250); }
 assert.equal(listA.status, 200, `cross-script query status ${listA.status}`); assert.ok(listA.text.includes(userA.data.userId));
 const listB = await query(b, tokenB, projectB); assert.equal(listB.status, 200); assert.ok(listB.text.includes(userB.data.userId)); assert.ok(!listA.text.includes(userB.data.userId));
 // Create after both Workers start: the management ingress must see the owner mutation.
 const later = await admin(a, '/_mapi/admin/users', { email: `later-${randomUUID()}@example.test`, password }); assert.equal(later.status, 200);
 const observed = await query(a, tokenA, projectA); assert.equal(observed.status, 200); assert.ok(observed.text.includes(later.data.userId));
 assert.equal((await query(a, null, projectA)).status, 401); assert.equal((await query(a, tokenA, projectB)).status, 403); assert.ok((await query(a, tokenB, projectA)).status >= 400);
 const login = await request(ownerPort, a, '/login', { method: 'POST', headers: { origin: a, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ email, password }).toString() }); assert.equal(login.status, 303); const cookie = login.headers['set-cookie']?.[0]?.split(';', 1)[0]; assert.ok(cookie);
 const session = await query(a, null, projectA, { cookie, headers: { origin: a, 'sec-fetch-site': 'same-origin' } }); assert.ok([403, 404].includes(session.status));
 assert.equal((await query(a, null, projectA, { cookie, headers: { origin: 'http://evil.test', 'sec-fetch-site': 'cross-site' } })).status, 403);
 assert.equal((await query(a, tokenA, projectA, { cookie, headers: { origin: a, 'sec-fetch-site': 'same-origin' } })).status, 200);
 const page = await request(ownerPort, a, '/app', { cookie }); const csrf = page.text.match(/name="csrf" value="([A-Za-z0-9_-]+)"/)?.[1]; assert.ok(csrf);
 const logout = await request(ownerPort, a, '/logout', { method: 'POST', cookie, headers: { origin: a }, body: new URLSearchParams({ csrf }).toString() }); assert.equal(logout.status, 303);
 assert.equal((await query(a, null, projectA, { cookie, headers: { origin: a, 'sec-fetch-site': 'same-origin' } })).status, 401);
 const flow = await request(ownerPort, a, '/__nextgen/flows', { method: 'POST', headers: { origin: a, 'content-type': 'application/json' }, body: JSON.stringify({ project_id: projectA, purpose: 'login' }) });
 assert.equal(flow.status, 201, 'combined flow start');
 const flowCookie = flow.headers['set-cookie']?.find(value => value.startsWith('_zflow='))?.split(';', 1)[0]; assert.ok(flowCookie);
 const flowRead = await request(ownerPort, a, `/__nextgen/flows/${encodeURIComponent(flow.data.id)}`, { cookie: flowCookie }); assert.equal(flowRead.status, 200, 'combined flow read');
 console.log(`Combined owner flow start/read: HTTP ${flow.status}/${flowRead.status}.`);
 const state = await admin(a, '/_mapi/admin/status'); console.log(`Combined project Wasm linear memory: ${state.data.wasmMemoryBytes} bytes.`);
 const ownerStopped = once(owner, 'exit'); owner.kill('SIGTERM'); await ownerStopped;
 await writeFile(ownerVars, `MAPI_MASTER_KEY=${master}\nMAPI_OPERATOR_TOKEN=${operator}\nMAPI_APP_ORIGIN=${a}\nMAPI_LOCAL_TEST=1\nMAPI_OFFICIAL_LOGIN=1\nMAPI_MAINTENANCE=1\n`, { mode: 0o600 });
 owner = start('scripts/shared-owner-test.wrangler.jsonc', ownerPort, inspector1, ownerVars); await wait(ownerPort, owner);
 let inMaintenance;
 for (let i = 0; i < 40; i++) { inMaintenance = await query(a, tokenA, projectA); if (inMaintenance.status === 503) break; await setTimeout(250); }
 assert.equal(inMaintenance.status, 503, 'owner maintenance must fence the consumer');
 assert.equal((await admin(a, '/_mapi/admin/status')).data.maintenance, true, 'owner reports maintenance');
 const ownerRestart = once(owner, 'exit'); owner.kill('SIGTERM'); await ownerRestart;
 await writeFile(ownerVars, `MAPI_MASTER_KEY=${master}\nMAPI_OPERATOR_TOKEN=${operator}\nMAPI_APP_ORIGIN=${a}\nMAPI_LOCAL_TEST=1\nMAPI_OFFICIAL_LOGIN=1\n`, { mode: 0o600 });
 owner = start('scripts/shared-owner-test.wrangler.jsonc', ownerPort, inspector1, ownerVars); await wait(ownerPort, owner);
 let afterMaintenance;
 for (let i = 0; i < 40; i++) { afterMaintenance = await query(a, tokenA, projectA); if (afterMaintenance.status === 200) break; await setTimeout(250); }
 assert.equal(afterMaintenance.status, 200, 'consumer reopens after owner maintenance');
 const stopped = once(management, 'exit'); management.kill('SIGTERM'); await stopped;
 await writeFile(managementVars, 'MAPI_MANAGEMENT_ENABLED=0\n', { mode: 0o600 });
 management = start('wrangler.shared-management.jsonc', managementPort, inspector2, managementVars); await wait(managementPort, management);
 assert.equal((await query(a, tokenA, projectA)).status, 404, 'disabled management ingress');
 assert.equal((await admin(a, '/_mapi/admin/status')).status, 200, 'owner remains online');
 for (const operatorSetting of ['', 'MAPI_OPERATOR_TOKEN=\n']) {
  const stoppedOwner = once(owner, 'exit'); owner.kill('SIGTERM'); await stoppedOwner;
  await writeFile(ownerVars, `MAPI_MASTER_KEY=${master}\n${operatorSetting}MAPI_APP_ORIGIN=${a}\nMAPI_LOCAL_TEST=1\nMAPI_OFFICIAL_LOGIN=1\n`, { mode: 0o600 });
  owner = start('scripts/shared-owner-test.wrangler.jsonc', ownerPort, inspector1, ownerVars); await wait(ownerPort, owner);
  for (const token of ['undefined', '']) assert.equal((await request(ownerPort, a, '/_mapi/test/management-token', { headers: { authorization: `Bearer ${token}` } })).status, 404);
 }
 console.log('Separate management Worker observed authoritative owner mutations and session revocation through cross-script Durable Object bindings.');
} catch (error) { if (diagnostics) console.error(diagnostics); throw error; }
finally { for (const child of [management, owner]) if (child && child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited; } await rm(dir, { recursive: true, force: true }); }
