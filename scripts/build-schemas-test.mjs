import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

const root = await mkdtemp(resolve(tmpdir(), 'mapi-schemas-build-'));
try {
  const source = resolve(root, 'nextgen'); await mkdir(source);
  const tar = resolve(root, 'source.tar');
  execFileSync('git', ['-C', resolve('.mapi/nextgen'), 'archive', '--format=tar', `--output=${tar}`, 'b0b74cd4a198428ea9b82910c217259ffc62b65c'], { stdio: 'inherit' });
  execFileSync('tar', ['-xf', tar, '-C', source], { stdio: 'inherit' });
  await cp('upstream/overlay', source, { recursive: true });
  execFileSync('git', ['apply', '--unidiff-zero', resolve('upstream/audit-tracing.patch')], { cwd: source, stdio: 'inherit' });
  for (const file of ['dialect', 'error', 'pool', 'with_transaction']) {
    const path = resolve(source, `apps/api/internal/storage/dialect/sqlite/${file}.go`);
    await writeFile(path, `//go:build !wasip1\n\n${await readFile(path, 'utf8')}`);
  }
  const adapter = resolve(source, 'apps/api/internal/api/cloudflare_wasip1.go');
  let code = await readFile(adapter, 'utf8');
  const anchor = '\tmux := http.NewServeMux()';
  if (!code.includes(anchor)) throw Error('handler mount changed');
  code = code.replace(anchor, anchor + '\n configureMaPiSchemas(h, server, mux)');
  await writeFile(adapter, code);
  const wasm = resolve('worker/generated/schemas-test.wasm');
  execFileSync('go', ['build', '-tags=mapi_schemas', '-trimpath', '-ldflags=-s -w', '-buildmode=c-shared', '-o', wasm, './cmd/mapi-wasm'], {
    cwd: resolve(source, 'apps/api'), stdio: 'inherit', env: { ...process.env, GOWORK: 'off', GOOS: 'wasip1', GOARCH: 'wasm', CGO_ENABLED: '0', GOTOOLCHAIN: 'go1.26.9' },
  });
  let object = await readFile('worker/index.js', 'utf8');
  object = object.replace('"./generated/nextgen.wasm"', '"./schemas-test.wasm"').replace('"./generated/fixture.json"', '"./fixture.json"').replace('"./wasi.js"', '"../wasi.js"').replace('"./sql.js"', '"../sql.js"');
  await writeFile('worker/generated/schemas-test-object.js', object);
  console.log(`Built isolated schemas adapter: ${(await stat(wasm)).size} Wasm bytes.`);
} finally { await rm(root, { recursive: true, force: true }); }
