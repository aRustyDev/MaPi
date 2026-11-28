import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

const bundle = await build({
  entryPoints: ['scripts/relocation-cursor-sizing-test-worker.mjs'],
  bundle: true, format: 'esm', platform: 'neutral', write: false,
  external: ['cloudflare:workers'],
});
const mf = new Miniflare(convertV4MiniflareOptions({
  workers: [{ name: 'synthetic-cursor-sizing', compatibilityDate: '2026-11-19',
    modules: [{ type: 'ESModule', path: 'worker.js', contents: bundle.outputFiles[0].text }],
    durableObjects: { PROBE: { className: 'CursorSizingProbe', useSQLite: true } },
  }], host: '127.0.0.1', port: 0, telemetry: { enabled: false },
}));
try {
  const response = await mf.dispatchFetch('http://127.0.0.1/');
  assert.equal(response.status, 200, await response.clone().text());
  assert.deepEqual(await response.json(), { ok: true, cases: 46, boundaryCases: 10, realCases: 4, splitResume: true });
  console.log('Exact cursor sizing and split UTF-8 checkpoint checks passed.');
} finally { await mf.dispose(); }
