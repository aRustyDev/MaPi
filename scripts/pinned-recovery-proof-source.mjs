import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

// Reconstruct the pinned source without changing the cached upstream checkout.
export async function withPinnedRecoverySource(callback) {
  const root = await mkdtemp(resolve(tmpdir(), 'mapi-recovery-source-'));
  try {
    const source = resolve(root, 'nextgen'), archive = resolve(root, 'source.tar');
    await mkdir(source);
    execFileSync('git', ['-C', resolve('.mapi/nextgen'), 'archive', '--format=tar', `--output=${archive}`, 'b0b74cd4a198428ea9b82910c217259ffc62b65c'], { stdio: 'inherit' });
    execFileSync('tar', ['-xf', archive, '-C', source], { stdio: 'inherit' });
    await cp('upstream/overlay', source, { recursive: true });
    execFileSync('git', ['apply', '--unidiff-zero', resolve('upstream/audit-tracing.patch')], { cwd: source, stdio: 'inherit' });
    for (const file of ['dialect', 'error', 'pool', 'with_transaction']) {
      const path = resolve(source, `apps/api/internal/storage/dialect/sqlite/${file}.go`);
      await writeFile(path, `//go:build !wasip1\n\n${await readFile(path, 'utf8')}`);
    }
    await callback(source, root);
  } finally { await rm(root, { recursive: true, force: true }); }
}
