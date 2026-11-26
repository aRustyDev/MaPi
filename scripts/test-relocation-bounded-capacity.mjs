import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

const wasm = await readFile('worker/generated/phase1-owner.wasm');
const bundle = await build({
  entryPoints: ['scripts/relocation-bounded-capacity-worker.mjs'], bundle: true,
  format: 'esm', platform: 'neutral', write: false, external: ['cloudflare:workers', 'node:crypto'],
  plugins: [{ name: 'wasm-binding', setup(build) {
    build.onResolve({ filter: /phase1-owner\.wasm$/ }, () => ({ path: './phase1-owner.wasm', external: true }));
  } }],
});
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
const master = Buffer.from(JSON.stringify({ id: 'synthetic-master', pem: privateKey })).toString('base64');
const secret = randomBytes(32).toString('base64url');
const token = randomBytes(32).toString('base64url');
function syntheticDigest(bytes) {
  const pieces = [];
  for (let offset = 0; offset < bytes.length; offset += 65536) pieces.push(createHash('sha256').update(bytes.subarray(offset, offset + 65536)).digest());
  return createHash('sha256').update(Buffer.concat(pieces)).digest('hex');
}
const expectedBlob = Buffer.alloc(8_380_000);
expectedBlob.set([0, 128, 255]);
const expectedBlobDigest = syntheticDigest(expectedBlob);
const expectedText = Buffer.from('z' + '😀'.repeat(2094998) + 'xyzab');
const expectedTextDigest = syntheticDigest(Buffer.concat([Buffer.from('"'), expectedText, Buffer.from('"')]));
const expectedHandlerDigest = createHash('sha256').update(expectedText).digest('hex');
const mf = new Miniflare(convertV4MiniflareOptions({
  workers: [{ name: 'synthetic-text-capacity', compatibilityDate: '2026-11-19',
    modules: [{ type: 'ESModule', path: 'worker.js', contents: bundle.outputFiles[0].text }, { type: 'CompiledWasm', path: 'phase1-owner.wasm', contents: wasm }],
    durableObjects: { NEXTGEN_APPLICATION: { className: 'CapacityOwner', useSQLite: true }, PROJECT_REGISTRY: { className: 'CapacityRegistry', useSQLite: true } },
    bindings: { MAPI_MASTER_KEY: master, MAPI_STAGING_PROOF_TOKEN: token, MAPI_RELOCATION_CONTROL_TOKEN: secret, MAPI_RELOCATION_ENABLED: '1', MAPI_FENCE_WRITERS_DRAINED: '1' },
  }], host: '127.0.0.1', port: 0, telemetry: { enabled: false },
}));
try {
  for (let i = 1; i <= 20000; i++) {
    const response = await mf.dispatchFetch('http://127.0.0.1/verify', { method: 'POST', headers: { authorization: `Bearer ${token}` } });
    const value = await response.json();
    assert.equal(response.status, 200, `Capacity proof failed during ${value.stage}`);
    if (value.done) {
      assert.equal(value.seeded, 2000);
      assert.equal(value.sourceRuntimeReleased, true, 'Frozen source must release its Go reactor');
      assert.equal(value.blobDigest, expectedBlobDigest, 'Large BLOB source and destination must match the native digest');
      assert.equal(value.nearTextDigest, expectedTextDigest, 'Large TEXT source and destination must match the native digest');
      assert.equal(value.importedHandler?.status, 200, 'Imported synthetic user must be readable through the Go handler');
      assert.equal(value.importedHandler.bytes, expectedText.length);
      assert.equal(value.importedHandler.digest, expectedHandlerDigest);
      assert.equal(value.syntheticEvictions, 3, 'Source and destination must resume three times during the large stream');
      assert.ok(value.largePages >= 2);
      assert.equal(value.oversizedRejected, true, 'Oversized row must be rejected before freeze');
      assert.equal(value.legacyRejected, true, 'Older checkpoints must be rejected');
      assert.equal(value.frozenLegacyRejected, true, 'Frozen source must reject older checkpoints');
      assert.equal(value.legacyActiveRecovered, true, 'Active older checkpoints must restart safely');
      assert.equal(value.longKeyRejected, true, 'Oversized primary key must be rejected before freeze');
      assert.equal(value.nonfiniteRejected, true, 'Non-finite REAL must be rejected before freeze');
      console.log(`Synthetic bounded-JS capacity transfer, pre-freeze rejection and legacy checks passed: ${value.seeded} rows, 8,300,000-byte TEXT, ${value.pages} preflight calls.`);
      break;
    }
    assert.ok(i < 20000, 'Capacity proof exceeded its request budget');
  }
} finally { await mf.dispose(); }
