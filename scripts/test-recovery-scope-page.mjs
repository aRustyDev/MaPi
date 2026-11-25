// Local-only synthetic workerd runner; never touches hosted namespaces.
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

const compiled = await build({ entryPoints: ['scripts/recovery-scope-page-test-worker.mjs'], bundle: true, format: 'esm', platform: 'browser', external: ['cloudflare:workers', 'node:crypto'], write: false });
const mf = new Miniflare(convertV4MiniflareOptions({ workers: [{
  name: 'local-synthetic-recovery-scope-page', compatibilityDate: '2026-11-19',
  modules: [{ type: 'ESModule', path: 'scope-page.js', contents: compiled.outputFiles[0].text }],
  durableObjects: { RUNNER: { className: 'ScopePageRunner', useSQLite: true }, OWNER: { className: 'ScopePageOwner', useSQLite: true } },
}], host: '127.0.0.1', port: 0, telemetry: { enabled: false } }));
try {
  const response = await mf.dispatchFetch('http://127.0.0.1/');
  assert.equal(response.status, 200, `Local scope page test failed: ${await response.clone().text()}`);
  const result = await response.json();
  assert.equal(result.ok, true);
  assert.ok(result.withinBytes <= 124 * 1024 && result.overBytes > 124 * 1024);
  console.log(JSON.stringify(result));
} finally { await mf.dispose(); }
