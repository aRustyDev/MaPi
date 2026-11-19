import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { startLocalZitadel } from '@zitadel/testing';
async function port() { const socket = createServer().listen(0, '127.0.0.1'); await once(socket, 'listening'); const n = socket.address().port; await new Promise((done) => socket.close(done)); return n; }
const directory = await mkdtemp(resolve(tmpdir(), 'mapi-system-'));
let native; let server; let stderr = '';
try {
  native = await startLocalZitadel({ dir: resolve(directory, 'native'), projectName: 'System parity' });
  const p = await port(), inspector = await port();
  server = spawn(process.execPath, [resolve('node_modules/wrangler/bin/wrangler.js'), 'dev', '--local', '--config', 'scripts/system-test.wrangler.jsonc', '--env-file', resolve('.dev.vars.poc'), '--ip', '127.0.0.1', '--port', String(p), '--inspector-port', String(inspector), '--persist-to', resolve(directory, 'state')], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, WRANGLER_LOG_PATH: resolve(directory, 'wrangler.log'), WRANGLER_SEND_METRICS: 'false' } });
  server.stdout.on('data', (chunk) => { stderr = (stderr + chunk.toString()).slice(-12000); });
  server.stderr.on('data', (chunk) => { stderr = (stderr + chunk.toString()).slice(-12000); });
  const worker = `http://127.0.0.1:${p}`;
  for (let attempt = 0; ; attempt++) { if (server.exitCode !== null || attempt === 100) throw Error('Workerd not ready'); try { await fetch(worker + '/livez', { signal: AbortSignal.timeout(15000) }); break; } catch { await setTimeout(200); } }
  async function compare(path, options = {}, headers = []) {
    const workerOptions = { ...options, headers: { ...options.headers, ...(options.headers?.['accept-encoding'] ? { 'x-mapi-test-accept-encoding': options.headers['accept-encoding'] } : {}) } };
    const [a, b] = await Promise.all([fetch(native.handle.baseUrl + path, { ...options, signal: AbortSignal.timeout(15000) }), fetch(worker + path, { ...workerOptions, signal: AbortSignal.timeout(15000) })]);
    const [ab, bb] = await Promise.all([a.arrayBuffer(), b.arrayBuffer()]);
    assert.equal(b.status, a.status, `${options.method ?? 'GET'} ${path} status`);
    assert.equal(createHash('sha256').update(Buffer.from(bb)).digest('hex'), createHash('sha256').update(Buffer.from(ab)).digest('hex'), `${options.method ?? 'GET'} ${path} body`);
    for (const name of headers) assert.equal(b.headers.get(name), a.headers.get(name), `${path} ${name}`);
    return a;
  }
  for (const path of ['/livez', '/readyz', '/api/v1/livez', '/api/v1/readyz']) await compare(path, {}, ['content-type']);
  const path = '/api/v1/openapi.json';
  const names = ['content-type', 'cache-control', 'vary', 'etag', 'access-control-allow-origin'];
  const response = await compare(path, { headers: { 'accept-encoding': 'identity' } }, names);
  await compare(path, { method: 'HEAD', headers: { 'accept-encoding': 'identity' } }, names);
  await compare(path, { headers: { 'accept-encoding': 'gzip' } }, [...names, 'content-encoding']);
  await compare(path, { headers: { 'accept-encoding': 'identity', 'if-none-match': response.headers.get('etag') } }, names);
  await compare(path, { method: 'OPTIONS' }, ['access-control-allow-origin', 'access-control-allow-methods', 'access-control-allow-headers', 'access-control-max-age']);
  await compare(path, { method: 'POST' }, ['allow', 'content-type', 'access-control-allow-origin']);
  console.log('Native and workerd system routes match for probes, OpenAPI GET/HEAD, gzip, conditional GET, OPTIONS, and POST.');
} catch (error) { if (stderr) console.error(stderr); throw error; }
finally {
  if (server && server.exitCode === null && server.signalCode === null) { const exited = once(server, 'exit'); server.kill('SIGTERM'); await exited; }
  if (native) await native.stop();
  await rm(directory, { recursive: true, force: true });
}
