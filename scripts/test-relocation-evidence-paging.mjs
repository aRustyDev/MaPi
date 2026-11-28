import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

const wasm = await readFile('worker/generated/phase1-owner.wasm');
const bundle = await build({
  entryPoints: ['scripts/relocation-evidence-paging-test-worker.mjs'], bundle: true,
  format: 'esm', platform: 'neutral', write: false, external: ['cloudflare:workers', 'node:crypto'],
  plugins: [{ name: 'wasm-binding', setup(build) {
    build.onResolve({ filter: /phase1-owner\.wasm$/ }, () => ({ path: './phase1-owner.wasm', external: true }));
  } }],
});
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
const master = Buffer.from(JSON.stringify({ id: 'synthetic-master', pem: privateKey })).toString('base64');
const mf = new Miniflare(convertV4MiniflareOptions({
  workers: [{ name: 'synthetic-evidence-paging', compatibilityDate: '2026-11-19',
    modules: [{ type: 'ESModule', path: 'worker.js', contents: bundle.outputFiles[0].text }, { type: 'CompiledWasm', path: 'phase1-owner.wasm', contents: wasm }],
    durableObjects: { NEXTGEN_APPLICATION: { className: 'CapacityOwner', useSQLite: true }, PROJECT_REGISTRY: { className: 'PagingRegistry', useSQLite: true } },
    bindings: { MAPI_MASTER_KEY: master, MAPI_RELOCATION_CONTROL_TOKEN: 'move-secret', MAPI_RELOCATION_ENABLED: '1', MAPI_FENCE_WRITERS_DRAINED: '1', MAPI_LOCAL_TEST: '1', MAPI_STAGING_PROOF_TOKEN: randomBytes(32).toString('base64url') },
  }], host: '127.0.0.1', port: 0, telemetry: { enabled: false },
}));
try {
  const response = await mf.dispatchFetch('http://127.0.0.1/verify');
  const result = await response.json();
  assert.equal(response.status, 200, JSON.stringify(result));
  assert.equal(result.ok, true);
  assert.equal(result.pages, 107);
  console.log('Real Go/Wasm evidence backfill, eviction, concurrent writes, ordering, isolation and bounded query plans passed.');
} finally { await mf.dispose(); }
