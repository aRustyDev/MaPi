import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { lookup } from 'node:dns/promises';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, isIP } from 'node:net';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

if (process.env.MAPI_SOCKET_PUBLIC_PROBE !== '1') {
  console.log('Socket probe skipped; set MAPI_SOCKET_PUBLIC_PROBE=1 to make fixed-origin public TLS connections.');
  process.exit(0);
}
async function freePort() { const s = createServer().listen(0, '127.0.0.1'); await once(s, 'listening'); const p = s.address().port; await new Promise(done => s.close(done)); return p; }
const directory = await mkdtemp(resolve(tmpdir(), 'mapi-socket-peer-')); let server, diagnostic = '';
try {
  // Explicit opt-in, one fixed public hostname; sends no HTTP or user data.
  const ip = (await lookup('www.google.com', { family: 4 })).address;
  assert.equal(isIP(ip), 4);
  const port = await freePort(), inspector = await freePort(), vars = resolve(directory, 'vars');
  await writeFile(vars, `MAPI_LOCAL_TEST=1\nMAPI_SOCKET_TEST_IP=${ip}\n`, { mode: 0o600 });
  server = spawn(process.execPath, [resolve('node_modules/wrangler/bin/wrangler.js'), 'dev', '--local', '--config', 'scripts/socket-peer-probe.wrangler.jsonc', '--env-file', vars, '--ip', '127.0.0.1', '--port', String(port), '--inspector-port', String(inspector), '--persist-to', resolve(directory, 'state')], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, WRANGLER_LOG_PATH: resolve(directory, 'wrangler.log'), WRANGLER_SEND_METRICS: 'false' } });
  for (const stream of [server.stdout, server.stderr]) stream.on('data', chunk => { diagnostic = (diagnostic + chunk.toString()).slice(-8000); });
  const call = async mode => { const r = await fetch(`http://127.0.0.1:${port}/?mode=${mode}`, { method: 'POST', signal: AbortSignal.timeout(8000) }); assert.equal(r.status, 200); return r.json(); };
  let host;
  for (let i = 0; i < 100; i++) { if (server.exitCode !== null) throw Error('workerd exited'); try { host = await call('hostname'); break; } catch { await sleep(100); } }
  if (!host) throw Error('workerd did not start');
  assert.equal(host.opened, true, 'hostname TLS control must open before evaluating peer visibility');
  const literal = await call('ip');
  // A numeric address alone would not prove that policy blocked private peers
  // before connection or that hostname TLS validation survives IP pinning.
  console.log(JSON.stringify({ hostname: host, literal, observedNumericPeer: host.opened && host.numericPeer, safePinnedDial: false }));
  // The probe does not establish pre-connect address enforcement or separate
  // TLS hostname verification for a numeric dial, so the safety gate stays shut.
  process.exitCode = 1;
} catch (error) { if (diagnostic) console.error(diagnostic); throw error; }
finally { if (server && server.exitCode === null && server.signalCode === null) { const done = once(server, 'exit'); server.kill('SIGTERM'); await done; } await rm(directory, { recursive: true, force: true }); }
