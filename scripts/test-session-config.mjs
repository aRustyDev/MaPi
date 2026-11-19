import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { startLocalZitadel } from '@zitadel/testing';
import { client } from './parity.mjs';

async function port() {
  const s = createServer().listen(0, '127.0.0.1'); await once(s, 'listening');
  const p = s.address().port; await new Promise((done, reject) => s.close(e => e ? reject(e) : done())); return p;
}
const dir = await mkdtemp(resolve(tmpdir(), 'mapi-session-config-'));
const fixture = JSON.parse(await readFile('.mapi/fixture.json', 'utf8'));
const localVars = await readFile('.dev.vars.poc', 'utf8');
const beforeDefault = process.env.NEXTGEN_SESSION_DEFAULT_TTL, beforeMax = process.env.NEXTGEN_SESSION_MAX_TTL;
let native, server, diagnostic = '';
async function stopWorker() {
  if (server && server.exitCode === null && server.signalCode === null) { const done = once(server, 'exit'); server.kill('SIGTERM'); await done; }
  server = undefined;
}
async function startWorker(name, defaultTTL, maxTTL, stateName = name, bindings = null) {
  await stopWorker();
  const envFile = resolve(dir, name + '.env');
  await writeFile(envFile, `${localVars}\n${defaultTTL === undefined ? '' : `MAPI_SESSION_DEFAULT_TTL=${defaultTTL}\n`}${maxTTL === undefined ? '' : `MAPI_SESSION_MAX_TTL=${maxTTL}\n`}`, { mode: 0o600 });
  let configPath = 'scripts/session-extra-test.wrangler.jsonc';
  if (bindings) {
    const config = JSON.parse(await readFile(configPath, 'utf8'));
    config.main = resolve('scripts/session-extra-test-worker.mjs'); config.vars = bindings;
    configPath = resolve(dir, name + '.json'); await writeFile(configPath, JSON.stringify(config));
  }
  const p = await port(), inspector = await port();
  server = spawn(process.execPath, [resolve('node_modules/wrangler/bin/wrangler.js'), 'dev', '--local', '--config', configPath, '--env-file', envFile, '--ip', '127.0.0.1', '--port', String(p), '--inspector-port', String(inspector), '--persist-to', resolve(dir, stateName)], {
    stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, WRANGLER_LOG_PATH: resolve(dir, name + '.log'), WRANGLER_SEND_METRICS: 'false' },
  });
  server.stderr.on('data', c => { diagnostic = (diagnostic + c).slice(-10000); });
  const url = `http://127.0.0.1:${p}`;
  for (let n = 0;; n++) {
    if (server.exitCode !== null || n === 100) throw Error('workerd not ready');
    try { await fetch(url + '/livez'); return url; } catch { await setTimeout(200); }
  }
}
try {
  process.env.NEXTGEN_SESSION_DEFAULT_TTL = '2h'; process.env.NEXTGEN_SESSION_MAX_TTL = '4h';
  native = await startLocalZitadel({ dir: resolve(dir, 'native'), projectName: 'Session config parity' });
  const nativeFixture = { ...native.handle, user: await native.seedUser() };
  const worker = await startWorker('valid', '2h', '4h');
  const probe = await (await fetch(worker + '/__mapi/init-probe')).json();
  assert.equal(probe.omitted, 'invalid prototype master key', 'omitted TTL did not reach master-key validation');
  for (const name of ['sessionDefaultTTL', 'sessionMaxTTL']) assert.deepEqual(probe[name], Array(5).fill('invalid session duration configuration'), `${name} direct Wasm validation`);
  let priorSession, priorExpiry;
  for (const [base, f] of [[native.handle.baseUrl, nativeFixture], [worker, fixture]]) {
    const api = client(base, f);
    const defaultSession = await api.exchange(await api.mint()); assert.equal(defaultSession.status, 200);
    const remaining = Date.parse(defaultSession.data.session.expires_at) - Date.now();
    assert.ok(remaining > 7190000 && remaining <= 7200000, 'configured default duration');
    if (base === worker) { priorSession = api.session(defaultSession); priorExpiry = defaultSession.data.session.expires_at; }
    const token = await api.mint(); const tooLong = await api.exchange(token, 'PT4H1S');
    assert.equal(tooLong.status, 400); assert.equal(tooLong.data.code, 'sess.invalid_ttl');
    assert.equal((await api.exchange(token, 'PT4H')).status, 200, 'invalid TTL consumed handoff');
  }
  const changed = await startWorker('changed', '1h', '4h', 'valid'), changedApi = client(changed, fixture);
  const persisted = await changedApi.read(priorSession); assert.equal(persisted.status, 200); assert.equal(persisted.data.expires_at, priorExpiry, 'configuration change modified an active session');
  const newSession = await changedApi.exchange(await changedApi.mint()); assert.equal(newSession.status, 200);
  const remaining = Date.parse(newSession.data.session.expires_at) - Date.now(); assert.ok(remaining > 3590000 && remaining <= 3600000, 'new session did not use updated default');
  await native.stop(); native = undefined; process.env.NEXTGEN_SESSION_MAX_TTL = '1000h';
  native = await startLocalZitadel({ dir: resolve(dir, 'native-wide'), projectName: 'Wide session config parity' });
  const wideFixture = { ...native.handle, user: await native.seedUser() };
  const wideWorker = await startWorker('wide', '2h', '1000h');
  for (const [base, f] of [[native.handle.baseUrl, wideFixture], [wideWorker, fixture]]) {
    const api = client(base, f), longSession = await api.exchange(await api.mint(), 'PT900H');
    assert.equal(longSession.status, 200, 'valid native max beyond the default cap rejected');
    assert.ok(Date.parse(longSession.data.session.expires_at) - Date.now() > 899 * 3600000, 'wide session duration');
  }
  for (const [name, value, max] of [['bad', 'not-a-duration', '4h'], ['zero', '0s', '4h'], ['negative', '-1h', '4h'], ['reversed', '5h', '4h'], ['overflow', '2h', '99999999999999h']]) {
    const base = await startWorker(name, value, max);
    assert.equal((await fetch(base + '/livez')).status, 503, `${name} failed open`);
    const api = client(base, fixture);
    assert.equal((await api.send('POST', '/auth_attempts', { body: { project_id: fixture.projectId } })).status, 503, `${name} accepted authentication`);
  }
  for (const [label, value] of [['null', null], ['number', 123], ['boolean', true], ['object', {}], ['array', []]]) {
    for (const name of ['MAPI_SESSION_DEFAULT_TTL', 'MAPI_SESSION_MAX_TTL']) {
      const base = await startWorker(`binding-${label}-${name}`, name === 'MAPI_SESSION_DEFAULT_TTL' ? undefined : '2h', name === 'MAPI_SESSION_MAX_TTL' ? undefined : '4h', `binding-${label}-${name}`, { [name]: value });
      const types = await (await fetch(base + '/__mapi/ttl-binding-type')).json(); assert.equal(types[name], label, `${name} did not arrive as ${label}`);
      for (let n = 0; n < 2; n++) assert.equal((await fetch(base + '/livez')).status, 503, `${name} ${label} binding failed open`);
    }
  }
  console.log('Native/workerd configured session default and maximum match; restart preserves existing expiry, and invalid configurations fail closed.');
} catch (error) { if (diagnostic) console.error(diagnostic); throw error; }
finally {
  await stopWorker();
  if (native) await native.stop();
  if (beforeDefault === undefined) delete process.env.NEXTGEN_SESSION_DEFAULT_TTL; else process.env.NEXTGEN_SESSION_DEFAULT_TTL = beforeDefault;
  if (beforeMax === undefined) delete process.env.NEXTGEN_SESSION_MAX_TTL; else process.env.NEXTGEN_SESSION_MAX_TTL = beforeMax;
  await rm(dir, { recursive: true, force: true });
}
