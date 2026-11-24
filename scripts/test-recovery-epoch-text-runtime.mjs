import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

const result = await build({
  entryPoints: ['scripts/recovery-epoch-text-test-worker.mjs'],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  external: ['cloudflare:workers'],
  write: false,
});
const mf = new Miniflare(convertV4MiniflareOptions({
  modules: true,
  script: result.outputFiles[0].text,
  compatibilityDate: '2025-05-01',
  durableObjects: { PROBE: { className: 'EpochTextProbe', useSQLite: true } },
}));
try {
  const response = await mf.dispatchFetch('http://localhost/');
  assert.equal(response.status, 200);
  const proof = await response.json();
  assert.equal(proof.rejected, true);
  assert.equal(proof.valuesPreserved, true);
  assert.equal(proof.validDistinct, true);
  console.log(`Workerd recovery epoch text checks passed; malformed SQL binding: ${JSON.stringify(proof.malformedBinding)}`);
} finally {
  await mf.dispose();
}
