// Exploratory Go/WASI cursor framing; not wired into the production bridge.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { copyFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { setTimeout } from 'node:timers/promises';
async function freePort() { const s = createServer().listen(0, '127.0.0.1'); await once(s, 'listening'); const port = s.address().port; await new Promise(done => s.close(done)); return port; }
const directory = await mkdtemp(resolve(tmpdir(), 'mapi-cursor-prototype-'));
let server;
try {
  for (const file of ['worker.mjs', 'main.go', 'wrangler.jsonc']) await copyFile(resolve('scripts/cursor-prototype', file), resolve(directory, file));
  await copyFile(resolve('worker/wasi.js'), resolve(directory, 'wasi.js'));
  await writeFile(resolve(directory, 'empty.env'), '');
  execFileSync('go', ['build', '-trimpath', '-buildmode=c-shared', '-o', resolve(directory, 'prototype.wasm'), resolve(directory, 'main.go')], { stdio: 'inherit', env: { ...process.env, GOWORK:'off', GOOS:'wasip1', GOARCH:'wasm', CGO_ENABLED:'0', GOTOOLCHAIN:'go1.26.9' } });
  const port = await freePort(), inspector = await freePort();
  server = spawn(process.execPath, [resolve('node_modules/wrangler/bin/wrangler.js'), 'dev', '--local', '--config', resolve(directory, 'wrangler.jsonc'), '--env-file', resolve(directory, 'empty.env'), '--ip', '127.0.0.1', '--port', String(port), '--inspector-port', String(inspector), '--persist-to', resolve(directory, 'state')], { stdio: ['ignore', 'ignore', 'inherit'], env: { ...process.env, WRANGLER_LOG_PATH: resolve(directory, 'wrangler.log'), WRANGLER_SEND_METRICS:'false' } });
  let response;
  for (let i=0; i<100; i++) { if (server.exitCode !== null) throw Error('workerd exited before readiness'); try { response = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(60000) }); break; } catch(e) { if (e.name === 'TimeoutError') throw e; await setTimeout(200); } }
  assert(response, 'workerd did not become ready'); assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.committed, 10001); assert.equal(result.rolledBack, 0); assert.equal(result.oldScopeRejected, true); assert.match(result.stale, /stale cursor/); assert.match(result.rollbackStale, /stale cursor/); assert.match(result.rollbackError, /injected Go failure/); assert(result.maxFrameBytes < 65536); assert(result.hostCalls > 10000);
  const temp = await (await fetch(`http://127.0.0.1:${port}/?mode=temp`)).json(); assert.equal(temp.temp, false); assert.match(temp.error, /SQLITE_AUTH/);
  const stage = await (await fetch(`http://127.0.0.1:${port}/?mode=stage`)).json(); assert.deepEqual(stage, {frames:245, source:1, parts:245, bytes:8000000});
  const rollback = await (await fetch(`http://127.0.0.1:${port}/?mode=stageRollback`)).json(); assert.equal(rollback.frames, 245); assert.match(rollback.error, /injected rollback/); assert.equal(rollback.source, 0); assert.equal(rollback.parts, 0); assert.equal(rollback.bytes, 0);
  const exact = await (await fetch(`http://127.0.0.1:${port}/?mode=exact`)).json(); assert.equal(exact['8388608'].textLength, 8388608); assert.deepEqual(exact.paired, { rows:2, textLength:8388608, int:'9223372036854775807', textType:'text', intType:'integer' });
  const volatile = await (await fetch(`http://127.0.0.1:${port}/?mode=volatile`)).json(); assert.equal(volatile.count, 10000); assert.equal(volatile.bad, 0); assert(volatile.plan.some(item => item === 'CO-ROUTINE src'));
  const vertical = await (await fetch(`http://127.0.0.1:${port}/?mode=vertical`)).json(); assert.equal(vertical.count, 100); assert.equal(vertical.textLength, 8388608); assert.equal(vertical.int, '9223372036854775807'); assert.equal(vertical.blob, '00ff'); assert.equal(vertical.mismatch, 0);
  const stagedb = await (await fetch(`http://127.0.0.1:${port}/?mode=stagedb`)).json(); assert.equal(stagedb.ok, true); assert(stagedb.maxFrameBytes < 65536);
  const snapshot = await (await fetch(`http://127.0.0.1:${port}/?mode=snapshot`)).json(); assert.deepEqual(snapshot, {first:1,rest:[2,3,4]});
  const stagedsnapshot = await (await fetch(`http://127.0.0.1:${port}/?mode=stagedsnapshot`)).json(); assert.deepEqual(stagedsnapshot, {ids:[1,2,3],leftovers:0,sourceCount:4});
  const returningLimit = await (await fetch(`http://127.0.0.1:${port}/?mode=returnlimit`, {signal:AbortSignal.timeout(60000)})).json(); assert.equal(returningLimit.directPass, true); assert.equal(returningLimit.taggedAtDirect, false); assert.equal(returningLimit.direct, returningLimit.tagged + 1); assert.equal(returningLimit.rows, 0);
  const narrowLimit = await (await fetch(`http://127.0.0.1:${port}/?mode=narrowlimit`, {signal:AbortSignal.timeout(60000)})).json(); assert.equal(narrowLimit.payloadBytes,8388602); assert.equal(narrowLimit.directPass,true); assert.equal(narrowLimit.typedAtDirect,false); assert.equal(narrowLimit.rows,0);
  const triggerMeta = await (await fetch(`http://127.0.0.1:${port}/?mode=triggermeta`, {signal:AbortSignal.timeout(60000)})).json(); assert.equal(triggerMeta.columns, 100); assert.equal(triggerMeta.textLength, 8388400); assert.equal(triggerMeta.metadataCount, 1);
  const nested = await (await fetch(`http://127.0.0.1:${port}/?mode=triggernested`)).json(); assert.deepEqual(nested.returned, [{a:'original'}]); assert.deepEqual(nested.meta, [{a:'nested',b:'text'},{a:'original',b:'null'}]);
  const nestedUpdate = await (await fetch(`http://127.0.0.1:${port}/?mode=triggernestedupdate`)).json(); assert.deepEqual(nestedUpdate.returned, [{a:'original',b:null}]); assert.deepEqual(nestedUpdate.meta, [{a:'original',b:'text'},{a:'original',b:'null'}]);
  const kvRollback = await (await fetch(`http://127.0.0.1:${port}/?mode=kvrollback`)).json(); assert.deepEqual(kvRollback, {transactionError:'Error: rollback',promiseError:null,value:null});
  const jspi = await (await fetch(`http://127.0.0.1:${port}/?mode=jspifeature`)).json(); console.log('Local workerd JSPI availability:', JSON.stringify(jspi));
  const prepared = await (await fetch(`http://127.0.0.1:${port}/?mode=preparecrash`)).json(); assert.equal(prepared.prepared, 5);
  const crash = await fetch(`http://127.0.0.1:${port}/?mode=crashstage`); assert.equal(crash.status, 500);
  const recovered = await (await fetch(`http://127.0.0.1:${port}/?mode=aftercrash`)).json(); assert.deepEqual(recovered, {cleaned:5,remaining:0});
  console.log('Isolated workerd Go/WASI cursor prototype:', JSON.stringify({result, temp, stage, rollback, exact, volatile, vertical, stagedb, snapshot, stagedsnapshot, returningLimit, narrowLimit, triggerMeta, nested, nestedUpdate, kvRollback, recovered}));
} finally {
  if (server && server.exitCode === null && server.signalCode === null) { const stopped = once(server, 'exit'); server.kill('SIGTERM'); await stopped; }
  await rm(directory, { recursive: true, force: true });
}
