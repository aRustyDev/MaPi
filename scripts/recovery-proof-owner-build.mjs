import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';

// Build the pinned owner for standalone proofs. Explicit prebuilt mode is for
// coordinated test runs that already built it; it verifies artifact integrity,
// not that uncommitted Go sources match the prebuilt artifact.
export async function prepareRecoveryProofOwner() {
  const prebuilt = process.env.MAPI_RECOVERY_PROOF_PREBUILT;
  if (prebuilt !== undefined && prebuilt !== '1') throw Error('MAPI_RECOVERY_PROOF_PREBUILT must be 1 when set');
  if (prebuilt !== '1') execFileSync(process.execPath, ['scripts/build-phase1-owner.mjs'], { stdio: 'inherit' });
  const manifest = JSON.parse(await readFile('worker/generated/phase1-owner-manifest.json', 'utf8'));
  const wasm = await readFile('worker/generated/phase1-owner.wasm');
  const digest = createHash('sha256').update(wasm).digest('hex');
  if (manifest.wasmBytes !== wasm.length || manifest.wasmSha256 !== digest ||
      manifest.nextgenCommit !== 'b0b74cd4a198428ea9b82910c217259ffc62b65c' ||
      JSON.stringify(manifest.tags) !== JSON.stringify(['mapi_flow', 'mapi_oauth', 'mapi_management'])) throw Error('Recovery proof owner artifact does not match its manifest');
}
