import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { withPinnedRecoverySource } from './pinned-recovery-proof-source.mjs';

await withPinnedRecoverySource(async (source, root) => {
  execFileSync('go', ['test', '-count=1', '-run', '^TestRecoveryRevokesOnlineButNotOfflineJWT$', './internal/mapioauth'], {
    cwd: resolve(source, 'apps/api'), stdio: 'inherit', env: { ...process.env, GOCACHE: process.env.GOCACHE || resolve(root, 'gocache'), GOWORK: 'off', GOTOOLCHAIN: 'go1.26.9' },
  });
});
