import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { access, copyFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout } from 'node:timers/promises';
import { build } from 'esbuild';

async function port() {
  const server = createServer().listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address().port;
  await new Promise((ok, fail) => server.close(error => error ? fail(error) : ok()));
  return address;
}

// Use a generated synthetic fixture and the prebuilt project Go/Wasm reactor.
// This verifies artifact behavior, not whether it reflects current source.
// All generated code, secrets and SQLite state live in a private temp dir.
for (const [path, prerequisite] of [
  ['worker/generated/nextgen.wasm', 'build the Go/Wasm reactor with npm run build'],
  ['worker/generated/fixture.json', 'generate the synthetic fixture with npm run fixture'],
]) {
  try { await access(resolve(path)); } catch { throw Error(`Missing ${path}; ${prerequisite} before running this proof`); }
}
const dir = await mkdtemp(resolve(tmpdir(), 'mapi-facet-proof-'));
let server;
try {
  const output = await build({
    stdin: {
      contents: `import { NextgenProject } from './worker/index.js';
export class Facet extends NextgenProject {
  inspect() {
    const sql = this.ctx.storage.sql;
    if (!sql.exec("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='mapi_probe'").toArray().length) return null;
    return sql.exec("SELECT COUNT(*) AS n, printf('%lld', MAX(value)) AS maximum FROM mapi_probe").one();
  }
}`,
      resolveDir: process.cwd(),
      sourcefile: 'synthetic-facet-entry.mjs',
      loader: 'js',
    },
    bundle: true, write: false, format: 'esm', platform: 'neutral', target: 'es2022',
    external: ['cloudflare:workers', './generated/nextgen.wasm'],
  });
  assert.equal(output.outputFiles.length, 1);
  await Promise.all([
    writeFile(resolve(dir, 'dynamic.txt'), output.outputFiles[0].contents, { mode: 0o600 }),
    copyFile(resolve('worker/generated/nextgen.wasm'), resolve(dir, 'engine.bin')),
    copyFile(resolve('scripts/dynamic-facet-proof-worker.mjs'), resolve(dir, 'worker.mjs')),
  ]);
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  const master = Buffer.from(JSON.stringify({ id: randomUUID(), pem: privateKey })).toString('base64');
  const gate = randomBytes(32).toString('hex');
  await writeFile(resolve(dir, 'test.env'), `MAPI_MASTER_KEY=${master}\nMAPI_GATE_KEY=${gate}\nMAPI_LOCAL_TEST=1\n`, { mode: 0o600 });
  const config = {
    name: 'mapi-dynamic-facet-proof', main: 'worker.mjs', compatibility_date: '2026-11-18',
    worker_loaders: [{ binding: 'LOADER' }],
    rules: [{ type: 'Text', globs: ['**/*.txt'], fallthrough: true }, { type: 'Data', globs: ['**/*.bin'], fallthrough: true }],
    durable_objects: { bindings: [{ name: 'SUPERVISOR', class_name: 'FacetProofSupervisor' }] },
    migrations: [{ tag: 'v1', new_sqlite_classes: ['FacetProofSupervisor'] }],
  };
  await writeFile(resolve(dir, 'wrangler.json'), JSON.stringify(config), { mode: 0o600 });
  const address = await port(), inspector = await port();
  server = spawn(process.execPath, [resolve('node_modules/wrangler/bin/wrangler.js'), 'dev', '--local', '--config', resolve(dir, 'wrangler.json'), '--env-file', resolve(dir, 'test.env'), '--ip', '127.0.0.1', '--port', String(address), '--inspector-port', String(inspector), '--persist-to', resolve(dir, 'state')], {
    stdio: ['ignore', 'ignore', 'pipe'],
    env: { ...process.env, WRANGLER_LOG_PATH: resolve(dir, 'wrangler.log'), WRANGLER_SEND_METRICS: 'false' },
  });
  let diagnostics = '';
  server.stderr.on('data', chunk => { diagnostics = (diagnostics + chunk).slice(-8000); });
  const url = `http://127.0.0.1:${address}/`;
  async function call(action, owner = 'synthetic-a', authorized = true) {
    const response = await fetch(url, {
      method: 'POST', headers: { 'content-type': 'application/json', ...(authorized ? { 'x-synthetic-key': gate } : {}) },
      body: JSON.stringify({ action, owner }), signal: AbortSignal.timeout(120000),
    });
    let value = null;
    try { value = await response.json(); } catch { /* unauthorized response has no body */ }
    return { status: response.status, value };
  }
  let ready = false;
  for (let attempt = 0; attempt < 150; attempt++) {
    if (server.exitCode !== null) throw Error('Local Workerd exited before readiness');
    try { const response = await call('inspect', 'synthetic-a', false); if (response.status === 404) { ready = true; break; } } catch { await setTimeout(200); }
  }
  if (!ready) throw Error(`Local Workerd did not become ready: ${diagnostics}`);
  assert.equal((await call('inspect', 'synthetic-a', false)).status, 404, 'Unauthorized call was accepted');
  const probe = await call('probe');
  assert.equal(probe.status, 200, JSON.stringify(probe.value));
  assert.equal(probe.value.transaction, true, 'Go/Wasm commit or rollback failed');
  assert.equal(probe.value.clock, true, 'Go/Wasm int64 clock failed');
  assert.equal(probe.value.password, true, 'Go/Wasm reactor failed');
  const before = await call('inspect');
  assert.equal(before.status, 200);
  assert.equal(before.value.n, 1, 'Rolled-back row was persisted or committed row was lost');
  assert.match(before.value.maximum, /^[0-9]+$/, 'Committed int64 was not retained');
  assert.equal((await call('abort-facet')).status, 200);
  assert.deepEqual(await call('inspect'), before, 'Facet eviction changed committed SQLite state');
  assert.equal((await call('abort-supervisor')).status, 500);
  assert.deepEqual(await call('inspect'), before, 'Supervisor eviction changed committed SQLite state');
  assert.deepEqual(await call('inspect', 'synthetic-b'), { status: 200, value: null }, 'Separate synthetic owner accessed the first owner’s SQLite');
  console.log('Dynamic facet proof passed using the prebuilt Go/Wasm artifact: transaction rollback, commit, int64, separate storage and facet/supervisor eviction. Artifact freshness was not verified.');
} finally {
  if (server && server.exitCode === null && server.signalCode === null) {
    const stopped = once(server, 'exit');
    server.kill('SIGTERM');
    await stopped;
  }
  await rm(dir, { recursive: true, force: true });
}
