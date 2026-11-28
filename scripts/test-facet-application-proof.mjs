// Local-only synthetic proof. The existing prebuilt Go/Wasm is required;
// this test does not establish that the artifact matches the current source.
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
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

try { await access('worker/generated/nextgen.wasm'); }
catch { throw Error('Build the existing Go/Wasm owner artifact before running this proof'); }
const dir = await mkdtemp(resolve(tmpdir(), 'mapi-facet-application-proof-'));
let server;
try {
  const dynamic = await build({ stdin: {
    contents: `import {NextgenApplication} from './worker/app.js';
export class Facet extends NextgenApplication {
 constructor(ctx, env) {
  const appEnv = { ...env,
   PROJECT_REGISTRY: { getByName(name) { if (name !== 'projects') throw Error('Forbidden registry'); return env.REGISTRY; } },
   NEXTGEN_APPLICATION: {
    idFromName(name) { return { toString() { return name === env.OWNER_NAME ? env.OWNER_ID : 'invalid-owner'; } }; },
    getByName() { throw Error('Cross-owner capability is not implemented in this proof'); },
   },
  };
  super(ctx, appEnv);
 }
 crossOwnerProbe() { return this.env.NEXTGEN_APPLICATION.getByName('synthetic-foreign'); }
}`,
    resolveDir: process.cwd(), sourcefile: 'synthetic-application-facet.mjs', loader: 'js',
  }, bundle: true, write: false, format: 'esm', platform: 'neutral', target: 'es2022', external: ['cloudflare:workers', './generated/nextgen.wasm'] });
  const supervisor = await build({ entryPoints: ['scripts/facet-application-proof-worker.mjs'], bundle: true, write: false, format: 'esm', platform: 'neutral', target: 'es2022', external: ['cloudflare:workers', './dynamic.txt', './engine.bin'] });
  assert.equal(dynamic.outputFiles.length, 1); assert.equal(supervisor.outputFiles.length, 1);
  await Promise.all([
    writeFile(resolve(dir, 'dynamic.txt'), dynamic.outputFiles[0].contents, { mode: 0o600 }),
    writeFile(resolve(dir, 'worker.mjs'), supervisor.outputFiles[0].contents, { mode: 0o600 }),
    copyFile(resolve('worker/generated/nextgen.wasm'), resolve(dir, 'engine.bin')),
  ]);
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  const master = Buffer.from(JSON.stringify({ id: 'synthetic', pem: privateKey })).toString('base64');
  const gate = randomBytes(32).toString('hex');
  await writeFile(resolve(dir, 'test.env'), `MAPI_MASTER_KEY=${master}\nMAPI_GATE_KEY=${gate}\n`, { mode: 0o600 });
  const config = { name: 'mapi-facet-application-proof', main: 'worker.mjs', compatibility_date: '2026-11-18',
    worker_loaders: [{ binding: 'LOADER' }], rules: [{ type: 'Text', globs: ['**/*.txt'], fallthrough: true }, { type: 'Data', globs: ['**/*.bin'], fallthrough: true }],
    vars: { MAPI_LOCAL_TEST: '1', MAPI_RELOCATION_ENABLED: '1', MAPI_RELOCATION_CONTROL_TOKEN: 'synthetic-token', MAPI_FENCE_WRITERS_DRAINED: '1' },
    durable_objects: { bindings: [{ name: 'NEXTGEN_APPLICATION', class_name: 'FacetApplicationSupervisor' }, { name: 'PROJECT_REGISTRY', class_name: 'ProjectRegistry' }] },
    migrations: [{ tag: 'v1', new_sqlite_classes: ['FacetApplicationSupervisor', 'ProjectRegistry'] }],
  };
  await writeFile(resolve(dir, 'wrangler.json'), JSON.stringify(config), { mode: 0o600 });
  const address = await port(), inspector = await port();
  server = spawn(process.execPath, [resolve('node_modules/wrangler/bin/wrangler.js'), 'dev', '--local', '--config', resolve(dir, 'wrangler.json'), '--env-file', resolve(dir, 'test.env'), '--ip', '127.0.0.1', '--port', String(address), '--inspector-port', String(inspector), '--persist-to', resolve(dir, 'state')], {
    stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, WRANGLER_LOG_PATH: resolve(dir, 'wrangler.log'), WRANGLER_SEND_METRICS: 'false' },
  });
  let diagnostics = ''; server.stderr.on('data', chunk => { diagnostics = (diagnostics + chunk).slice(-8000); });
  const url = `http://127.0.0.1:${address}/`;
  let ready = false;
  for (let attempt = 0; attempt < 150; attempt++) {
    if (server.exitCode !== null) throw Error('Local Workerd exited before readiness');
    try { const response = await fetch(url, { signal: AbortSignal.timeout(3000) }); if (response.status === 404) { ready = true; break; } } catch { await setTimeout(200); }
  }
  if (!ready) throw Error(`Local Workerd did not become ready: ${diagnostics}`);
  const response = await fetch(url, { headers: { 'x-synthetic-key': gate }, signal: AbortSignal.timeout(120000) });
  const result = await response.json();
  assert.equal(response.status, 200, JSON.stringify(result)); assert.equal(result.ok, true);
  console.log('Synthetic application facet proof passed with prebuilt Go/Wasm: provisioning, login, stale-route rejection and eviction. Artifact freshness was not verified.');
} finally {
  if (server && server.exitCode === null && server.signalCode === null) { const stopped = once(server, 'exit'); server.kill('SIGTERM'); await stopped; }
  await rm(dir, { recursive: true, force: true });
}
