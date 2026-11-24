import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { withPinnedRecoverySource } from './pinned-recovery-proof-source.mjs';

await withPinnedRecoverySource(async (source, root) => {
  execFileSync('go', ['build', '-tags', 'mapi_recovery_token_proof', '-trimpath', '-ldflags=-s -w', '-buildmode=c-shared', '-o', resolve('worker/generated/recovery-token-proof.wasm'), './cmd/mapi-wasm'], {
    cwd: resolve(source, 'apps/api'), stdio: 'inherit', env: { ...process.env, GOCACHE: process.env.GOCACHE || resolve(root, 'gocache'), GOWORK: 'off', GOOS: 'wasip1', GOARCH: 'wasm', CGO_ENABLED: '0', GOTOOLCHAIN: 'go1.26.9' },
  });
});
const proof = await WebAssembly.compile(await readFile('worker/generated/recovery-token-proof.wasm'));
const normal = await WebAssembly.compile(await readFile('worker/generated/nextgen.wasm'));
if (!WebAssembly.Module.exports(proof).some(entry => entry.name === 'mapi_recovery_token_proof') || WebAssembly.Module.exports(normal).some(entry => entry.name === 'mapi_recovery_token_proof')) throw Error('Credential proof export isolation failed');
await import('./build-recovery-credential-proof-object.mjs');
