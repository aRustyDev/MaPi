// Production-tagged owner containing flow, issuer, and management handlers.
process.env.MAPI_MANAGEMENT_COMBINED = '1';
process.env.MAPI_MANAGEMENT_PRODUCTION = '1';
process.env.MAPI_PHASE1_OWNER = '1';
await import('./build-management-test.mjs');

const { createHash } = await import('node:crypto');
const { execFileSync } = await import('node:child_process');
const { readFile, writeFile } = await import('node:fs/promises');
const wasm = await readFile('worker/generated/phase1-owner.wasm');
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const manifest = {
  mapiCommit: git('rev-parse', 'HEAD'),
  mapiDirty: Boolean(git('status', '--porcelain')),
  nextgenCommit: 'b0b74cd4a198428ea9b82910c217259ffc62b65c',
  node: process.version,
  go: execFileSync('go', ['version'], { encoding: 'utf8', env: { ...process.env, GOTOOLCHAIN: 'go1.26.9' } }).trim(),
  tags: ['mapi_flow', 'mapi_oauth', 'mapi_management'],
  wasmBytes: wasm.length,
  wasmSha256: createHash('sha256').update(wasm).digest('hex'),
  routes: ['flow', 'session', 'oauth', 'users/get', 'users/query'],
};
await writeFile('worker/generated/phase1-owner-manifest.json', JSON.stringify(manifest, null, 2) + '\n');
console.log(JSON.stringify(manifest, null, 2));
