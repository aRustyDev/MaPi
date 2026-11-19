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

async function freePort() { const socket = createServer().listen(0, '127.0.0.1'); await once(socket, 'listening'); const n = socket.address().port; await new Promise((done) => socket.close(done)); return n; }
const dir = await mkdtemp(resolve(tmpdir(), 'mapi-management-e2e-'));
let server;
try {
 const p = await freePort(), inspector = await freePort();
 const originA = `http://localhost:${p}`, originB = `http://localhost:${p + 1}`, originC = `http://localhost:${p + 2}`, originD = `http://localhost:${p + 3}`;
 const vars = await readFile('.dev.vars.app', 'utf8');
 const master = vars.match(/^MAPI_MASTER_KEY=(.+)$/m)?.[1];
 if (!master) throw Error('Generate .dev.vars.app with node scripts/app-secrets.mjs --local');
 const operator = randomBytes(32).toString('hex');
 const envPath = resolve(dir, 'vars');
 await writeFile(envPath, `MAPI_MASTER_KEY=${master}\nMAPI_OPERATOR_TOKEN=${operator}\nMAPI_APP_ORIGIN=${originA}\nMAPI_LOCAL_TEST=1\nMAPI_MANAGEMENT_ENABLED=1\n`, { mode: 0o600 });
 server = spawn(process.execPath, [resolve('node_modules/wrangler/bin/wrangler.js'), 'dev', '--local', '--config', 'scripts/management-e2e.wrangler.jsonc', '--env-file', envPath, '--ip', '127.0.0.1', '--port', String(p), '--inspector-port', String(inspector), '--persist-to', resolve(dir, 'state')], { stdio: ['ignore', 'ignore', 'ignore'], env: { ...process.env, WRANGLER_LOG_PATH: resolve(dir, 'wrangler.log'), WRANGLER_SEND_METRICS: 'false' } });
 const request = (origin, path, { method = 'GET', body, token, cookie, headers = {} } = {}) => new Promise((done, reject) => {
  const target = new URL(origin); const merged = { host: target.host, ...headers };
  if (token) merged.authorization = `Bearer ${token}`; if (cookie) merged.cookie = cookie;
  const req = http.request({ hostname: '127.0.0.1', port: p, path, method, headers: merged }, (res) => { const chunks = []; res.on('data', (c) => chunks.push(c)); res.on('end', () => { const text = Buffer.concat(chunks).toString(); let data; try { data = JSON.parse(text); } catch { data = null; } done({ status: res.statusCode, headers: res.headers, text, data }); }); });
  req.on('error', reject); req.setTimeout(30000, () => req.destroy(Error('request timeout'))); if (body !== undefined) req.write(body); req.end();
 });
 for (let attempt = 0; ; attempt++) { if (server.exitCode !== null || attempt === 100) throw Error('Workerd did not start'); try { await request(originA, '/_mapi/admin/status'); break; } catch { await setTimeout(200); } }
 const admin = (origin, path, data) => request(origin, path, { method: data ? 'POST' : 'GET', token: operator, headers: { 'content-type': 'application/json' }, ...(data ? { body: JSON.stringify(data) } : {}) });
 const a = await admin(originA, '/_mapi/admin/init', { name: 'Management A' }); assert.equal(a.status, 200); const projectA = a.data.projectId;
 const b = await admin(originA, '/_mapi/admin/projects', { name: 'Management B', origin: originB }); assert.equal(b.status, 200); const projectB = b.data.projectId; assert.notEqual(projectA, projectB);
 const email = `e2e-${randomUUID()}@example.test`, password = `Test-${randomUUID()}!`;
 const createdA = await admin(originA, '/_mapi/admin/users', { email, password }); const createdB = await admin(originB, '/_mapi/admin/users', { email, password }); assert.equal(createdA.status, 200); assert.equal(createdB.status, 200);
 const userA = createdA.data.userId, userB = createdB.data.userId; assert.notEqual(userA, userB);
 const tokenA = (await admin(originA, '/_mapi/test/management-token')).data.token, tokenB = (await admin(originB, '/_mapi/test/management-token')).data.token;
 const query = (origin, token, project, extra = {}) => request(origin, `/api/v1/users/query?project_id=${project}`, { method: 'POST', body: '{}', token, headers: { 'content-type': 'application/json', ...extra.headers }, cookie: extra.cookie });
 const ownA = await query(originA, tokenA, projectA), ownB = await query(originB, tokenB, projectB); assert.equal(ownA.status, 200); assert.equal(ownB.status, 200); assert.equal(ownA.headers['cache-control'], 'no-store'); assert.ok(ownA.text.includes(userA) && !ownA.text.includes(userB)); assert.ok(ownB.text.includes(userB) && !ownB.text.includes(userA));
 assert.equal((await request(originA, `/api/v1/users/${userA}`, { token: tokenA })).status, 200);
 assert.equal((await request(originA, `/users/${userA}`, { token: tokenA })).status, 200);
 assert.equal((await request(originA, `/users/${userB}`, { token: tokenA })).status, 404);
 assert.equal((await request(originA, `/users/${userA}`)).status, 401);
 assert.equal((await request(originA, `/users/${userA}`, { token: 'invalid' })).status, 401);
 assert.ok((await query(originA, tokenB, projectA)).status >= 400);
 assert.equal((await query(originA, tokenA, projectB)).status, 403);
 const login = await request(originA, '/login', { method: 'POST', headers: { origin: originA, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ email, password }).toString() }); assert.equal(login.status, 303); const cookie = login.headers['set-cookie']?.[0]?.split(';', 1)[0]; assert.ok(cookie);
 const page = await request(originA, '/app', { cookie }); assert.equal(page.status, 200); const csrf = page.text.match(/name="csrf" value="([A-Za-z0-9_-]+)"/)?.[1]; assert.ok(csrf);
 assert.equal((await request(originB, `/users/${userB}`, { cookie })).status, 401);
 const userRead = await request(originA, `/users/${userA}`, { cookie }); assert.ok([403, 404].includes(userRead.status), `unprivileged session status ${userRead.status}`);
 const sessionQuery = await query(originA, null, projectA, { cookie, headers: { origin: originA, 'sec-fetch-site': 'same-origin' } }); assert.ok([403, 404].includes(sessionQuery.status), `unprivileged query status ${sessionQuery.status}`);
 const tokenExempt = await query(originA, null, projectA, { cookie, headers: { origin: originA, 'sec-fetch-site': 'same-origin', 'x-zitadel-csrf': 'invalid' } }); assert.equal(tokenExempt.status, sessionQuery.status);
 assert.equal((await query(originA, null, projectA, { cookie, headers: { origin: 'http://evil.test', 'sec-fetch-site': 'cross-site' } })).status, 403);
 assert.equal((await query(originA, null, projectA, { cookie, headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
 assert.equal((await query(originA, null, projectA, { cookie, headers: { origin: 'http://evil.test', 'x-forwarded-host': 'evil.test', 'x-forwarded-proto': 'http' } })).status, 403);
 assert.equal((await request(originA, '/users/query', { method: 'POST', token: tokenA, headers: { 'content-type': 'application/json' }, body: 'x'.repeat(65_537) })).status, 413);
 assert.equal((await request(originA, `/users/query?project_id=${projectA}&project_id=${projectA}`, { method: 'POST', token: tokenA, body: '{}' })).status, 403);
 assert.ok(!ownA.text.includes(tokenA) && !ownA.text.includes(cookie), 'credential leaked in response');
 assert.equal((await query(originA, tokenA, projectA, { cookie, headers: { origin: originA, 'sec-fetch-site': 'same-origin' } })).status, 200);
 assert.equal((await request(originA, '/logout', { method: 'POST', cookie, headers: { origin: originA }, body: new URLSearchParams({ csrf: 'invalid' }).toString() })).status, 403);
 assert.equal((await request(originA, '/logout', { method: 'POST', cookie, headers: { origin: originA }, body: new URLSearchParams({ csrf }).toString() })).status, 303);
 assert.equal((await request(originA, `/users/${userA}`, { cookie })).status, 401);
 assert.equal((await request(originB, `/users/${userB}`, { cookie })).status, 401);
 assert.equal((await request(originA, `/users/${userA}`, { token: tokenA, headers: { 'x-forwarded-host': 'evil.test', 'x-forwarded-proto': 'http' } })).status, 200);
 assert.equal((await request(originC, `/users/${userA}`, { token: tokenA })).status, 404);
 assert.equal((await admin(originA, '/_mapi/test/management-route', { origin: originC, object: 'pending-test' })).status, 204);
 assert.equal((await request(originC, `/users/${userA}`, { token: tokenA })).status, 404);
 assert.equal((await admin(originA, '/_mapi/test/management-route', { origin: originD, object: 'mismatched-test', projectId: 'proj_mismatch' })).status, 204);
 assert.equal((await request(originD, `/users/${userA}`, { token: tokenA })).status, 503);
 const state = await admin(originA, '/_mapi/admin/status'); assert.ok(state.data.wasmMemoryBytes > 0); console.log(`Measured project Wasm linear memory: ${state.data.wasmMemoryBytes} bytes.`);
 for (const [enabled, maintenance, expected] of [['0', '0', 404], ['1', '1', 503]]) {
  const stopped = once(server, 'exit'); server.kill('SIGTERM'); await stopped;
  await writeFile(envPath, `MAPI_MASTER_KEY=${master}\nMAPI_OPERATOR_TOKEN=${operator}\nMAPI_APP_ORIGIN=${originA}\nMAPI_LOCAL_TEST=1\nMAPI_MANAGEMENT_ENABLED=${enabled}\nMAPI_MAINTENANCE=${maintenance}\n`, { mode: 0o600 });
  server = spawn(process.execPath, [resolve('node_modules/wrangler/bin/wrangler.js'), 'dev', '--local', '--config', 'scripts/management-e2e.wrangler.jsonc', '--env-file', envPath, '--ip', '127.0.0.1', '--port', String(p), '--inspector-port', String(inspector), '--persist-to', resolve(dir, 'state')], { stdio: ['ignore', 'ignore', 'ignore'], env: { ...process.env, WRANGLER_LOG_PATH: resolve(dir, 'wrangler.log'), WRANGLER_SEND_METRICS: 'false' } });
  for (let attempt = 0; ; attempt++) { if (server.exitCode !== null || attempt === 100) throw Error('Workerd restart failed'); try { await request(originA, '/_mapi/admin/status'); break; } catch { await setTimeout(200); } }
  assert.equal((await request(originA, `/users/${userA}`, { token: tokenA })).status, expected);
 }
 console.log('Real registry, two application objects and Go management adapter passed Bearer, session, origin, CSRF and isolation checks.');
} finally { if (server && server.exitCode === null && server.signalCode === null) { const exit = once(server, 'exit'); server.kill('SIGTERM'); await exit; } await rm(dir, { recursive: true, force: true }); }
