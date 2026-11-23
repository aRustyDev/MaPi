import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { upstreamTestResult } from './upstream-sqlite-test-result.mjs';

const pin = 'b0b74cd4a198428ea9b82910c217259ffc62b65c';
const upstream = resolve('.mapi/nextgen');
const directory = await mkdtemp(resolve(tmpdir(), 'mapi-upstream-sqlite-wasi-'));
const source = resolve(directory, 'source');
const archive = resolve(directory, 'source.tar');
const api = resolve(source, 'apps/api');
const wasm = resolve('worker/generated/upstream-sqlite-stmttest.wasm');
const output = resolve('worker/generated/upstream-sqlite-stmttest-results.json');
let server;
let diagnostic = '';

function replaceOnce(content, oldText, newText, name) {
  if (!content.includes(oldText) || content.indexOf(oldText) !== content.lastIndexOf(oldText)) {
    throw new Error(`Expected one ${name} anchor in pinned source`);
  }
  return content.replace(oldText, newText);
}
async function freePort() {
  const socket = createServer().listen(0, '127.0.0.1');
  await once(socket, 'listening');
  const { port } = socket.address();
  await new Promise((done, reject) => socket.close((error) => error ? reject(error) : done()));
  return port;
}

try {
  await mkdir(source);
  await mkdir('worker/generated', { recursive: true });
  execFileSync('git', ['-C', upstream, 'archive', '--format=tar', `--output=${archive}`, pin], { stdio: 'inherit' });
  execFileSync('tar', ['-xf', archive, '-C', source], { stdio: 'inherit' });
  await cp('upstream/overlay', source, { recursive: true });
  execFileSync('git', ['apply', '--unidiff-zero', resolve('upstream/audit-tracing.patch')], { cwd: source, stdio: 'inherit' });
  const sqlite = resolve(api, 'internal/storage/dialect/sqlite');
  for (const name of ['dialect', 'error', 'pool', 'with_transaction']) {
    const path = resolve(sqlite, `${name}.go`);
    await writeFile(path, `//go:build !wasip1\n\n${await readFile(path, 'utf8')}`);
  }
  for (const name of ['seed_projects_integration.go', 'nullability_integration.go']) {
    const path = resolve(sqlite, name);
    let content = await readFile(path, 'utf8');
    if (!content.includes('pool.(*Pool)') || !content.includes('p.sqlDB')) throw new Error(`Unexpected test helper ${name}`);
    content = content.replaceAll('pool.(*Pool)', 'pool.(*CloudflarePool)').replaceAll('p.sqlDB', 'p.client.sqlDB');
    await writeFile(path, content);
  }
  await writeFile(resolve(sqlite, 'cloudflare_test_support_wasip1.go'), `//go:build wasip1 && sqlite_integration
package sqlite
import "context"
func (p *CloudflarePool) Close(context.Context) error { return nil }
func (p *CloudflarePool) Ping(context.Context) error { return nil }
func (p *CloudflarePool) Migrate(context.Context) error { return nil }
`);
  if (process.env.MAPI_MATCH_CONTRACT === '1') {
    await cp('scripts/upstream-sqlite-match-helper.go', resolve(sqlite, 'mapi_match_helper_wasip1.go'));
    await cp('scripts/upstream-sqlite-match-test.go', resolve(api, 'internal/storage/stmttest/mapi_match_test.go'));
  }
  if (process.env.MAPI_OWNER_CONCURRENCY === '1') {
    await cp('scripts/upstream-sqlite-owner-calls-test.go', resolve(api, 'internal/storage/stmttest/mapi_owner_calls_test.go'));
  }
  if (process.env.MAPI_REVISION_CONTRACT === '1') {
    await cp('scripts/upstream-sqlite-revision-test.go', resolve(api, 'internal/storage/stmttest/mapi_revision_test.go'));
  }
  if (process.env.MAPI_ESCAPED_ROWS_CONTRACT === '1') {
    await cp('scripts/upstream-sqlite-escaped-rows-test.go', resolve(api, 'internal/storage/stmttest/mapi_escaped_rows_test.go'));
  }
  if (process.env.MAPI_EXPIRY_CONTRACT === '1') {
    if (process.env.MAPI_FREEZE_TEST_CLOCK !== '1') throw new Error('Expiry boundary test requires a frozen test clock');
    await cp('scripts/upstream-sqlite-expiry-test.go', resolve(api, 'internal/storage/stmttest/mapi_expiry_test.go'));
  }
  if (process.env.MAPI_BULK_DEACTIVATION === '1') {
    const bulkCount = Number(process.env.MAPI_BULK_USER_COUNT ?? '1000');
    if (!Number.isInteger(bulkCount) || bulkCount < 1 || bulkCount > 10000) throw new Error('Bulk user count must be between 1 and 10000');
    const bulkTest = await readFile('scripts/upstream-sqlite-bulk-test.go', 'utf8');
    await writeFile(resolve(api, 'internal/storage/stmttest/mapi_bulk_test.go'), replaceOnce(bulkTest, 'const bulkUsers = 1000', `const bulkUsers = ${bulkCount}`, 'bulk user count'));
  }
  await writeFile(resolve(api, 'internal/storage/dbtest/sqlite.go'), `//go:build sqlite_integration && wasip1
package dbtest
import (
  "context"
  v2sqlite "github.com/zitadel/nextgen/internal/storage/dialect/sqlite"
)
func SQLite(context.Context) (Pool, func(), error) {
  return v2sqlite.NewCloudflarePool(), func() {}, nil
}
`);
  if (process.env.MAPI_TEST_LOGICAL_CLOCK === '1') {
    const path = resolve(sqlite, 'time.go');
    const content = await readFile(path, 'utf8');
    await writeFile(path, replaceOnce(content, 'return time.Now().UTC().UnixNano()', 'return testLogicalTimestamp(time.Now().UTC().UnixNano())', 'SQLite clock'));
    await writeFile(resolve(sqlite, 'mapi_test_logical_clock_wasip1.go'), `//go:build wasip1 && sqlite_integration
package sqlite
import (
  "fmt"
  "github.com/zitadel/nextgen/internal/cloudflarewasm"
)
func testLogicalTimestamp(now int64) int64 {
  db := cloudflarewasm.Open()
  defer db.Close()
  if _, err := db.Exec("CREATE TABLE IF NOT EXISTS mapi_test_logical_clock (id INTEGER PRIMARY KEY, stamp INTEGER NOT NULL)"); err != nil { panic(fmt.Errorf("clock initialization: %w", err)) }
  var stamp int64
  if err := db.QueryRow("INSERT INTO mapi_test_logical_clock (id, stamp) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET stamp = max(stamp + 1, excluded.stamp) RETURNING stamp", now).Scan(&stamp); err != nil { panic(fmt.Errorf("clock allocation: %w", err)) }
  return stamp
}
`);
  }
  const testsDir = resolve(api, 'internal/storage/stmttest');
  const mainPath = resolve(testsDir, 'main_test.go');
  const main = await readFile(mainPath, 'utf8');
  await writeFile(mainPath, replaceOnce(main, 'func run(m *testing.M) int {', 'func run(m *testing.M) int {\n\toneAtATime = true', 'test runner'));
  const names = new Set();
  for (const name of (await readdir(testsDir)).filter((item) => item.endsWith('_test.go'))) {
    const content = await readFile(resolve(testsDir, name), 'utf8');
    for (const match of content.matchAll(/^func (Test[A-Za-z0-9_]+)\(t \*testing\.T\)/gm)) names.add(match[1]);
  }
  const filter = new RegExp(process.env.MAPI_STMTTEST_FILTER ?? '.');
  const selected = [...names].sort().filter((name) => filter.test(name));
  if (!selected.length) throw new Error('No upstream tests selected');
  execFileSync('go', ['test', '-c', '-tags', 'sqlite_integration', '-o', wasm, './internal/storage/stmttest'], {
    cwd: api, stdio: 'inherit',
    env: { ...process.env, GOWORK: 'off', GOOS: 'wasip1', GOARCH: 'wasm', CGO_ENABLED: '0', GOTOOLCHAIN: 'go1.26.9' },
  });
  const environment = resolve(directory, 'empty.env');
  await writeFile(environment, '');
  const port = await freePort();
  const inspector = await freePort();
  server = spawn(process.execPath, [resolve('node_modules/wrangler/bin/wrangler.js'), 'dev', '--local', '--config', 'scripts/upstream-sqlite-wasi-test.wrangler.jsonc', '--env-file', environment, '--var', 'MAPI_LOCAL_TEST:1', '--ip', '127.0.0.1', '--port', String(port), '--inspector-port', String(inspector), '--persist-to', resolve(directory, 'state')], {
    stdio: ['ignore', 'ignore', 'pipe'],
    env: { ...process.env, WRANGLER_LOG_PATH: resolve(directory, 'wrangler.log'), WRANGLER_SEND_METRICS: 'false' },
  });
  server.stderr.on('data', (chunk) => { diagnostic = (diagnostic + chunk.toString()).slice(-16_000); });
  const base = `http://127.0.0.1:${port}`;
  const clock = process.env.MAPI_FREEZE_TEST_CLOCK === '1' ? '&clock=frozen' : '';
  for (let attempt = 0; ; attempt++) {
    if (server.exitCode !== null || attempt === 100) throw new Error('workerd did not become ready');
    try { await fetch(`${base}/?test=${selected[0]}${clock}`, { signal: AbortSignal.timeout(20_000) }); break; }
    catch { await setTimeout(200); }
  }
  const results = [];
  if (process.env.MAPI_BULK_DEACTIVATION === '1') {
    const shared = `bulk-${crypto.randomUUID()}`;
    const run = async (name) => {
      const response = await fetch(`${base}/?test=${name}&shared=${shared}`, { signal: AbortSignal.timeout(120_000) });
      const result = await response.json();
      assert.equal(response.status, 200, name);
      if (!upstreamTestResult(name, result).passed) throw new Error(`${name} did not run and pass:\n${result.logs}`);
    };
    await run('TestMaPiBulkSeed');
    const start = performance.now();
    await run('TestMaPiBulkDeactivate');
    console.log(`${process.env.MAPI_BULK_USER_COUNT ?? '1000'}-user team deactivation: ${(performance.now() - start).toFixed(0)} ms local wall time (includes owner RPC and Go test startup)`);
  }
  if (process.env.MAPI_OWNER_CONCURRENCY === '1') {
    const shared = `owner-${crypto.randomUUID()}`;
    const run = async (name) => {
      const response = await fetch(`${base}/?test=${name}&shared=${shared}${clock}`, { signal: AbortSignal.timeout(20_000) });
      const result = await response.json();
      assert.equal(response.status, 200, name);
      if (!upstreamTestResult(name, result).passed) throw new Error(`${name} did not run and pass:\n${result.logs}`);
      return result;
    };
    await run('TestMaPiOwnerSeed');
    await Promise.all([run('TestMaPiOwnerA'), run('TestMaPiOwnerB')]);
    await run('TestMaPiOwnerVerify');
    await Promise.all([run('TestMaPiUserOwnerA'), run('TestMaPiUserOwnerB')]);
    await run('TestMaPiUserOwnerVerify');
    console.log('Concurrent separate owner calls preserved IDP revision order and password history');
    console.log('Concurrent stale user updates accepted exactly one expected version');
    // The suite below is intentionally independent and uses disposable objects.
  }
  for (const name of selected) {
    try {
      const response = await fetch(`${base}/?test=${name}${clock}`, { signal: AbortSignal.timeout(20_000) });
      const result = await response.json();
      assert.equal(response.status, 200, name);
      const { ran, passed } = upstreamTestResult(name, result);
      const expiryWindowValid = name !== 'TestMaPiFrozenClockAfterSynchronousWork' || (result.frozenClock === true && result.timerPolls === 0 && result.wallClockReads >= 2 && Number.isFinite(result.firstWallClock) && result.firstWallClock === result.lastWallClock && Number.isFinite(result.expiryWindowMs) && result.expiryWindowMs >= 20);
      const status = !ran ? 'not-run' : passed && expiryWindowValid ? 'pass' : 'fail';
      const failures = result.logs?.split('\n').filter((line) => line.includes('Error:') || line.includes('--- FAIL:') || line.includes('fatal error:')).slice(0, 12) ?? [];
      if (!expiryWindowValid) failures.push('Frozen-clock probe lacked a measured 20-millisecond synchronous interval');
      results.push({ name, status, exitCode: result.exitCode ?? null, timerPolls: result.timerPolls ?? null, wallClockReads: result.wallClockReads ?? null, firstWallClock: result.firstWallClock ?? null, lastWallClock: result.lastWallClock ?? null, expiryWindowMs: result.expiryWindowMs ?? null, failures, ...(status === 'fail' ? { log: result.logs } : {}) });
      if (status !== 'pass') console.log(`${status}: ${name}`);
    } catch (error) {
      results.push({ name, status: 'runner-error', error: String(error) });
      console.log(`runner-error: ${name}: ${error}`);
    }
  }
  await writeFile(output, JSON.stringify({ pin, testCount: selected.length, experimentalLogicalClock: process.env.MAPI_TEST_LOGICAL_CLOCK === '1', frozenTestClock: !!clock, results }, null, 2));
  const passed = results.filter((result) => result.status === 'pass');
  const timerTests = passed.filter((result) => result.timerPolls > 0);
  console.log(`Pinned upstream stmttest: ${passed.length}/${selected.length} passed; ${timerTests.length} passing tests used simulated timer polls. Results: ${output}`);
  if (passed.length !== selected.length) process.exitCode = 1;
} finally {
  if (server && server.exitCode === null && server.signalCode === null) {
    const stopped = once(server, 'exit');
    server.kill('SIGTERM');
    await stopped;
  }
  if (diagnostic && process.exitCode) console.error(diagnostic);
  await rm(directory, { recursive: true, force: true });
}
