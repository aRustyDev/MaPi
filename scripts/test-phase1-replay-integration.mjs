import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { setTimeout } from 'node:timers/promises';

async function port() { const server = createServer().listen(0, '127.0.0.1'); await once(server, 'listening'); const n = server.address().port; await new Promise(done => server.close(done)); return n; }
const directory = await mkdtemp(resolve(tmpdir(), 'mapi-phase1-replay-'));
let server;
try {
  await mkdir(resolve(directory, 'scripts'));
  await symlink(resolve('worker'), resolve(directory, 'worker'), 'dir');
  let source = await readFile('scripts/oauth-composition-test-worker.mjs', 'utf8');
  const anchor = "if(oauth('POST',`/oauth/${project}/token`,tokenHeaders,tokenForm.toString()).status===200)throw new Error('authorization code replay accepted');";
  if (!source.includes(anchor)) throw Error('Replay test anchor differs');
  source = source.replace('../worker/generated/oauth-composition-test.wasm', '../worker/generated/phase1-owner.wasm').replace(anchor, "const replay=oauth('POST',`/oauth/${project}/token`,tokenHeaders,tokenForm.toString()); let replayError; try { replayError=JSON.parse(decoder.decode(Uint8Array.fromBase64(replay.body))).error; } catch { throw new Error('Replay response was not JSON'); } if(replay.status!==400||replayError!=='invalid_grant')throw new Error(`Unexpected replay status or error: ${replay.status}`);");
  await writeFile(resolve(directory, 'scripts', 'worker.mjs'), source);
  const config = { name: 'mapi-phase1-replay-local', main: 'worker.mjs', compatibility_date: '2026-11-18', workers_dev: false, durable_objects: { bindings: [{ name: 'OAUTH_TEST', class_name: 'OAuthCompositionTest' }] }, migrations: [{ tag: 'v1', new_sqlite_classes: ['OAuthCompositionTest'] }] };
  await writeFile(resolve(directory, 'scripts', 'wrangler.json'), JSON.stringify(config));
  const p = await port(), inspector = await port();
  server = spawn(process.execPath, [resolve('node_modules/wrangler/bin/wrangler.js'), 'dev', '--local', '--config', resolve(directory, 'scripts', 'wrangler.json'), '--ip', '127.0.0.1', '--port', String(p), '--inspector-port', String(inspector), '--persist-to', resolve(directory, 'state')], { stdio: ['ignore', 'ignore', 'inherit'], env: { ...process.env, WRANGLER_LOG_PATH: resolve(directory, 'wrangler.log'), WRANGLER_SEND_METRICS: 'false' } });
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  let response;
  for (let n = 0; n < 100; n++) {
    if (server.exitCode !== null) throw Error('Local replay Worker exited');
    try { response = await fetch(`http://127.0.0.1:${p}/`, { method: 'POST', body: JSON.stringify({ pem: privateKey }), signal: AbortSignal.timeout(120000) }); break; }
    catch (error) { if (error.name === 'TimeoutError') throw error; await setTimeout(200); }
  }
  if (!response) throw Error('Local replay Worker did not start');
  const result = await response.json();
  assert.equal(result.ok, true, result.error); assert.equal(result.journey, true);
  console.log('Local real Go OAuth replay returned HTTP 400 invalid_grant.');
} finally {
  if (server && server.exitCode === null && server.signalCode === null) { const stopped = once(server, 'exit'); server.kill('SIGTERM'); await stopped; }
  await rm(directory, { recursive: true, force: true });
}
