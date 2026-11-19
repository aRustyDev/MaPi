import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { lookup } from 'node:dns/promises';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { connect as nodeTLSConnect } from 'node:tls';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { setTimeout } from 'node:timers/promises';

async function freePort() { const server = createServer().listen(0, '127.0.0.1'); await once(server, 'listening'); const port = server.address().port; await new Promise(done => server.close(done)); return port; }
if (process.env.MAPI_TLS_PUBLIC_PROBE !== '1') {
  console.log('Public TLS probe skipped; set MAPI_TLS_PUBLIC_PROBE=1 to make the documented external handshakes.');
  process.exit(0);
}
const dir = await mkdtemp(resolve(tmpdir(), 'mapi-tls-pin-')); let worker, diagnostic = '';
async function launch(ip, port, mode = 'ip') {
  const workerPort = await freePort(), inspectorPort = await freePort(), vars = resolve(dir, 'vars');
  await writeFile(vars, `MAPI_LOCAL_TEST=1\nMAPI_TLS_TEST_PORT=${port}\nMAPI_TLS_TEST_IP=${ip}\nMAPI_TLS_TEST_MODE=${mode}\n`, { mode: 0o600 });
  worker = spawn(process.execPath, [resolve('node_modules/wrangler/bin/wrangler.js'), 'dev', '--local', '--config', 'scripts/tls-pin-probe.wrangler.jsonc', '--env-file', vars, '--ip', '127.0.0.1', '--port', String(workerPort), '--inspector-port', String(inspectorPort), '--persist-to', resolve(dir, 'state')], { stdio: ['ignore','pipe','pipe'], env: { ...process.env, WRANGLER_LOG_PATH: resolve(dir,'wrangler.log'), WRANGLER_SEND_METRICS: 'false' } });
  for (const stream of [worker.stdout, worker.stderr]) stream.on('data', chunk => { diagnostic = (diagnostic + chunk.toString()).slice(-8000); });
  const call = async name => { const response = await fetch(`http://127.0.0.1:${workerPort}/?name=${name}`, { method: 'POST', signal: AbortSignal.timeout(6000) }); return { status: response.status, body: await response.json() }; };
  for (let attempt = 0; attempt < 100; attempt++) { if (worker.exitCode !== null) throw Error('workerd exited'); try { return { call, first: await call('www.google.com') }; } catch { await setTimeout(100); } }
  throw Error('workerd did not start');
}
async function stop() { if (worker && worker.exitCode === null && worker.signalCode === null) { const stopped = once(worker, 'exit'); worker.kill('SIGTERM'); await stopped; } worker = undefined; }
async function nativeWrongServername() {
  return await new Promise(resolve => {
    const socket = nodeTLSConnect({ host: 'www.google.com', port: 443, servername: 'wrong.invalid', rejectUnauthorized: true }, () => { socket.destroy(); resolve({ ok: true }); });
    socket.on('error', error => resolve({ ok: false, code: error.code ?? null }));
    socket.setTimeout(4000, () => { socket.destroy(); resolve({ ok: false, code: 'TIMEOUT' }); });
  });
}
try {
  // Explicit opt-in: TLS handshakes to this fixed public host, no HTTP request.
  const ip = (await lookup('www.google.com', { family: 4 })).address;
  const hostnameControl = await launch(ip, 443, 'hostname');
  const hostnameResult = hostnameControl.first.body;
  assert.equal(hostnameResult.ok, true, JSON.stringify(hostnameResult));
  const wrongHostname = await hostnameControl.call('wrong.invalid');
  assert.equal(wrongHostname.status, 200);
  const nativeWrong = await nativeWrongServername();
  assert.equal(nativeWrong.ok, false); assert.equal(nativeWrong.code, 'ERR_TLS_CERT_ALTNAME_INVALID');
  await stop();
  const publicTest = await launch(ip, 443, 'ip');
  assert.equal(publicTest.first.status, 200);
  let pinnedWrongNameRejected = null;
  if (publicTest.first.body.ok) {
    const wrong = await publicTest.call('wrong.invalid'); assert.equal(wrong.status, 200); pinnedWrongNameRejected = wrong.body.ok === false;
  }
  const safePinnedDial = !wrongHostname.body.ok && publicTest.first.body.ok && pinnedWrongNameRejected === true;
  console.log(JSON.stringify({ hostnameControl: hostnameResult, wrongHostnameControl: wrongHostname.body, nativeWrongHostnameControl: nativeWrong, pinnedControl: publicTest.first.body, pinnedWrongNameRejected, safePinnedDial }));
  if (!safePinnedDial) process.exitCode = 1;
} catch (error) { if (diagnostic) console.error(diagnostic); throw error; } finally { await stop(); await rm(dir, { recursive: true, force: true }); }
