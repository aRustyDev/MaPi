import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { startLocalZitadel, bootstrapProject } from '@zitadel/testing';
async function port() { const socket = createServer().listen(0, '127.0.0.1'); await once(socket, 'listening'); const n = socket.address().port; await new Promise((done) => socket.close(done)); return n; }
const directory = await mkdtemp(resolve(tmpdir(), 'mapi-management-'));
let native, server, diagnostic = '';
try {
 const nf = await startLocalZitadel({ dir: resolve(directory, 'native'), projectName: 'Management parity' }); native = nf; const user = await nf.seedUser(); const other = await bootstrapProject({ baseUrl: nf.handle.baseUrl, projectName: 'other project' });
 const wf = JSON.parse(await readFile('.mapi/fixture.json', 'utf8'));
 const fixture = { native: { ...nf.handle, user, otherProjectId: other.projectId, otherProjectSecret: other.projectSecret }, worker: wf };
 const p = await port(), inspector = await port();
 server = spawn(process.execPath, [resolve('node_modules/wrangler/bin/wrangler.js'), 'dev', '--local', '--config', 'scripts/management-test.wrangler.jsonc', '--env-file', resolve('.dev.vars.poc'), '--ip', '127.0.0.1', '--port', String(p), '--inspector-port', String(inspector), '--persist-to', resolve(directory, 'state')], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, WRANGLER_LOG_PATH: resolve(directory, 'wrangler.log'), WRANGLER_SEND_METRICS: 'false' } });
 for (const stream of [server.stdout, server.stderr]) stream.on('data', (c) => { diagnostic = (diagnostic + c.toString()).slice(-15000); });
 const worker = `http://127.0.0.1:${p}`;
 for (let attempt = 0; ; attempt++) { if (server.exitCode !== null || attempt === 100) throw Error('Workerd not ready'); try { await fetch(worker + '/livez', { signal: AbortSignal.timeout(15000) }); break; } catch { await setTimeout(200); } }
 const cases = [
  { name: 'query own', method: 'POST', path: f => `/api/v1/users/query?project_id=${f.projectId}`, body: {} },
  { name: 'query alias', method: 'POST', path: f => `/users/query?project_id=${f.projectId}`, body: {} },
  { name: 'read own', path: f => `/api/v1/users/${f.user.id}` },
  { name: 'read alias', path: f => `/users/${f.user.id}` },
  { name: 'query without credential', method: 'POST', path: f => `/api/v1/users/query?project_id=${f.projectId}`, body: {}, token: () => null },
  { name: 'read without credential', path: f => `/api/v1/users/${f.user.id}`, token: () => null },
  { name: 'query preview credential', method: 'POST', path: f => `/api/v1/users/query?project_id=${f.projectId}`, body: {}, token: f => f.previewSecret },
  { name: 'read preview credential', path: f => `/api/v1/users/${f.user.id}`, token: f => f.previewSecret },
  { name: 'query foreign project', method: 'POST', path: f => `/api/v1/users/query?project_id=${f.projectId}`, body: {}, token: f => f.otherProjectSecret },
  { name: 'read foreign project', path: f => `/api/v1/users/${f.user.id}`, token: f => f.otherProjectSecret },
  { name: 'unknown user', path: () => '/api/v1/users/user_00000000000000000000000000' },
  { name: 'bounded page', method: 'POST', path: f => `/api/v1/users/query?project_id=${f.projectId}`, body: { limit: 1 } },
  { name: 'invalid cursor', method: 'POST', path: f => `/api/v1/users/query?project_id=${f.projectId}`, body: { page_token: 'invalid-cursor' } },
  { name: 'invalid pagination', method: 'POST', path: f => `/api/v1/users/query?project_id=${f.projectId}`, body: { limit: 0 } },
 ];
 const normalize = (data, f) => JSON.parse(JSON.stringify(data, (key, value) => {
  if (typeof value !== 'string') return value;
  if (/^(created_at|updated_at|last_used_at)$/.test(key)) return '<time>';
  if (value === f.user.id) return '<user>'; if (value === f.projectId) return '<project>'; if (value === f.user.email) return '<email>'; if (value === f.schemaId) return '<schema>';
  return value;
 }));
 for (const test of cases) {
  const run = async (base, f) => { const headers = { accept: 'application/json' }, token = test.token ? test.token(f) : f.projectSecret; if (token) headers.authorization = `Bearer ${token}`; if (test.body) headers['content-type'] = 'application/json'; const res = await fetch(base + test.path(f), { method: test.method ?? 'GET', headers, ...(test.body ? { body: JSON.stringify(test.body) } : {}), signal: AbortSignal.timeout(15000) }); const raw = await res.text(); let body; try { body = raw ? JSON.parse(raw) : null; } catch { body = raw; } return { status: res.status, body: normalize(body, f) }; };
  const [a,b] = await Promise.all([run(nf.handle.baseUrl, fixture.native), run(worker, fixture.worker)]);
  assert.deepEqual(b, a, test.name);
  console.log(`${test.name}: HTTP ${b.status}`);
 }
 console.log('User read/query native and workerd parity checks passed.');
} catch (error) { if (diagnostic) console.error(diagnostic); throw error; }
finally { if (server && server.exitCode === null && server.signalCode === null) { const stopped = once(server, 'exit'); server.kill('SIGTERM'); await stopped; } if (native) await native.stop(); await rm(directory, { recursive: true, force: true }); }
