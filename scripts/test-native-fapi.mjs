import { cp, mkdtemp, mkdir, rm } from 'node:fs/promises';
import { execFileSync, spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { once } from 'node:events';

// A separate checkout keeps native-test overlays out of the pinned source.
const temp = await mkdtemp(resolve(tmpdir(), 'mapi-native-fapi-'));
try {
  const checkout = resolve(temp, 'nextgen');
  await mkdir(checkout);
  execFileSync('rsync', ['-a', '--exclude=.git', '--exclude=node_modules', `${resolve('.mapi/nextgen')}/`, `${checkout}/`], { stdio: 'inherit' });
  for (const name of ['mapioauth', 'mapidpop']) {
    await cp(resolve(`upstream/overlay/apps/api/internal/${name}`), resolve(checkout, `apps/api/internal/${name}`), { recursive: true });
  }
  await cp(resolve('upstream/overlay/apps/api/internal/storage/dialect/sqlite/mapi_native_e2e.go'), resolve(checkout, 'apps/api/internal/storage/dialect/sqlite/mapi_native_e2e.go'));
  const child = spawn('go', ['test', '-v', '-tags', 'mapi_native_e2e', '-run', '^TestPrivatePARRealClientAndDPoP$', '-count=1', './internal/mapioauth'], { cwd: resolve(checkout, 'apps/api'), stdio: 'inherit', env: { ...process.env, GOWORK: 'off' } });
  const [code, signal] = await once(child, 'exit');
  if (code !== 0) throw new Error(`Native FAPI test failed (${signal ?? code})`);
} finally {
  await rm(temp, { recursive: true, force: true });
}
