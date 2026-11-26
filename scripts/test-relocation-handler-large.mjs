import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

const wasm = await readFile('worker/generated/phase1-owner.wasm');
const bundle = await build({ entryPoints: ['scripts/relocation-handler-large-worker.mjs'], bundle: true, format: 'esm', platform: 'neutral', write: false, external: ['cloudflare:workers', 'node:crypto'], plugins: [{ name: 'wasm-binding', setup(build) { build.onResolve({ filter: /phase1-owner\.wasm$/ }, () => ({ path: './phase1-owner.wasm', external: true })); } }] });
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
const master = Buffer.from(JSON.stringify({ id: 'synthetic-master', pem: privateKey })).toString('base64');
const token = randomBytes(32).toString('base64url');
const mf = new Miniflare(convertV4MiniflareOptions({ workers: [{ name: 'synthetic-handler', compatibilityDate: '2026-11-19', modules: [{ type: 'ESModule', path: 'worker.js', contents: bundle.outputFiles[0].text }, { type: 'CompiledWasm', path: 'phase1-owner.wasm', contents: wasm }], durableObjects: { NEXTGEN_APPLICATION: { className: 'HandlerOwner', useSQLite: true }, PROJECT_REGISTRY: { className: 'ProjectRegistry', useSQLite: true } }, bindings: { MAPI_MASTER_KEY: master, MAPI_PHASE1_CONTROL_TOKEN: token } }], host: '127.0.0.1', port: 0, telemetry: { enabled: false } }));
try {
  const response = await mf.dispatchFetch('http://127.0.0.1/');
  if (!response.ok) throw Error(`Synthetic handler probe HTTP ${response.status}: ${await response.text()}`);
  const result = await response.json();
  if (result.status === 200) {
    const expected = Buffer.from('z' + '😀'.repeat(2096998) + 'xyzab');
    assert.equal(result.bytes, expected.length);
    assert.equal(result.digest, createHash('sha256').update(expected).digest('hex'));
  }
  console.log(JSON.stringify({ handlerStatus: result.status, ...(result.status === 200 ? { bytes: result.bytes, digest: result.digest } : {}) }));
} finally { await mf.dispose(); }
