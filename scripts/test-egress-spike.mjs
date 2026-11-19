import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import https from 'node:https';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { setTimeout } from 'node:timers/promises';
async function port() { const s = createServer().listen(0, '127.0.0.1'); await once(s, 'listening'); const n = s.address().port; await new Promise(done => s.close(done)); return n; }
const dir = await mkdtemp(resolve(tmpdir(), 'mapi-egress-spike-')); let worker, idp, diagnostics = '';
try {
 const cert = resolve(dir, 'cert.pem'), key = resolve(dir, 'key.pem');
 const ca = resolve(dir, 'ca.pem'), caKey = resolve(dir, 'ca-key.pem'), csr = resolve(dir, 'server.csr'), ext = resolve(dir, 'server.ext');
 execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=MaPi Test CA', '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign', '-keyout', caKey, '-out', ca], { stdio: 'ignore' });
 execFileSync('openssl', ['req', '-new', '-newkey', 'rsa:2048', '-nodes', '-subj', '/CN=localhost', '-keyout', key, '-out', csr], { stdio: 'ignore' });
 await writeFile(ext, 'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:localhost,IP:127.0.0.1\n');
 execFileSync('openssl', ['x509', '-req', '-in', csr, '-CA', ca, '-CAkey', caKey, '-CAcreateserial', '-days', '1', '-extfile', ext, '-out', cert], { stdio: 'ignore' });
 const ip = await port(), wp = await port(), inspector = await port(), issuer = `https://127.0.0.1:${ip}`, testKey = randomBytes(32).toString('hex'); let mode = 'valid', calls = 0;
 idp = https.createServer({ key: await readFile(key), cert: await readFile(cert) }, async (request, response) => {
  calls++; assert.equal(request.url, '/.well-known/openid-configuration');
  if (mode === 'slow' || mode === 'concurrent') await setTimeout(mode === 'slow' ? 1400 : 250);
  if (mode === 'redirect' || mode === 'redirect-same') { response.writeHead(302, { location: mode === 'redirect' ? 'http://169.254.169.254/latest/meta-data' : issuer + '/alternate' }); response.end(); return; }
  if (mode === 'oversized' || mode === 'oversized-length') { response.writeHead(200, { 'content-type': 'application/json', ...(mode === 'oversized-length' ? { 'content-length': '18000' } : {}) }); response.write('x'.repeat(9000)); response.end('x'.repeat(9000)); return; }
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ issuer: mode === 'bad-issuer' ? 'https://wrong.example' : issuer, authorization_endpoint: mode === 'bad-endpoint' ? 'http://169.254.169.254/' : issuer + '/authorize', token_endpoint: issuer + '/token', userinfo_endpoint: issuer + '/userinfo', jwks_uri: issuer + '/keys' }));
 });
 await new Promise((done, reject) => idp.listen(ip, '127.0.0.1', error => error ? reject(error) : done()));
 const env = resolve(dir, 'vars'); await writeFile(env, `MAPI_LOCAL_TEST=1\nMAPI_EGRESS_ORIGIN=${issuer}\nMAPI_TEST_KEY=${testKey}\n`, { mode: 0o600 });
 worker = spawn(process.execPath, [resolve('node_modules/wrangler/bin/wrangler.js'), 'dev', '--local', '--config', 'scripts/egress-spike.wrangler.jsonc', '--env-file', env, '--ip', '127.0.0.1', '--port', String(wp), '--inspector-port', String(inspector), '--persist-to', resolve(dir, 'state')], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NODE_EXTRA_CA_CERTS: ca, WRANGLER_LOG_PATH: resolve(dir, 'wrangler.log'), WRANGLER_SEND_METRICS: 'false' } });
 for (const stream of [worker.stdout, worker.stderr]) stream.on('data', chunk => { diagnostics = (diagnostics + chunk.toString()).slice(-10000); });
 async function req(path, data) { const response = await fetch(`http://127.0.0.1:${wp}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-local-test-key': testKey }, body: JSON.stringify(data), signal: AbortSignal.timeout(10000) }); return { status: response.status, data: await response.json().catch(() => null) }; }
 for (let i = 0; ; i++) { if (worker.exitCode !== null || i === 100) throw Error('workerd did not start'); try { await req('/check', { host: '127.0.0.1' }); break; } catch { await setTimeout(200); } }
 for (const host of ['localhost', '127.0.0.1', '10.1.2.3', '169.254.169.254', '::1', '::ffff:127.0.0.1', '64:ff9b::7f00:1']) assert.equal((await req('/check', { host })).data.allowed, false, host);
 assert.equal((await req('/check', { host: '8.8.8.8' })).data.allowed, true);
 for (const forbidden of ['https://example.com', 'http://127.0.0.1:80', issuer + '/other', `https://user@127.0.0.1:${ip}`]) assert.equal((await req('/run', { id: 'denied', issuer: forbidden })).data.error, 'denied'); assert.equal(calls, 0);
 const before = calls, reserved = await req('/run', { id: 'resume-before-fetch', issuer, failStage: 'after-reserve' }); assert.equal(reserved.status, 500, JSON.stringify(reserved.data)); assert.equal(calls, before); assert.equal((await req('/status', { id: 'resume-before-fetch' })).data.state, 'pending'); await req('/expire', { id: 'resume-before-fetch' });
 const valid = await req('/run', { id: 'resume-before-fetch', issuer }); assert.equal(valid.data.userinfo, issuer + '/userinfo', JSON.stringify({ result: valid.data, idpCalls: calls })); assert.equal((await req('/status', { id: 'resume-before-fetch' })).data.state, 'done'); const completedCalls = calls; assert.equal((await req('/run', { id: 'resume-before-fetch', issuer })).data.userinfo, issuer + '/userinfo'); assert.equal(calls, completedCalls);
 const postNetwork = await req('/run', { id: 'resume-after-fetch', issuer, failStage: 'after-network' }); assert.equal(postNetwork.status, 500); assert.equal((await req('/status', { id: 'resume-after-fetch' })).data.state, 'pending'); await req('/expire', { id: 'resume-after-fetch' }); assert.equal((await req('/run', { id: 'resume-after-fetch', issuer })).data.userinfo, issuer + '/userinfo');
 mode = 'redirect'; const redirectCount = calls; assert.equal((await req('/run', { id: 'redirect', issuer })).data.error, 'redirect'); assert.equal(calls, redirectCount + 1);
 mode = 'redirect-same'; assert.equal((await req('/run', { id: 'redirect-same', issuer })).data.error, 'redirect');
 mode = 'oversized'; assert.equal((await req('/run', { id: 'oversized', issuer })).data.error, 'oversized');
 mode = 'oversized-length'; assert.equal((await req('/run', { id: 'oversized-length', issuer })).data.error, 'oversized');
 mode = 'bad-issuer'; assert.equal((await req('/run', { id: 'bad-issuer', issuer })).data.error, 'discovery_failed');
 mode = 'bad-endpoint'; assert.equal((await req('/run', { id: 'bad-endpoint', issuer })).data.error, 'discovery_failed');
 mode = 'concurrent'; const results = await Promise.all([req('/run', { id: 'concurrent', issuer }), req('/run', { id: 'concurrent', issuer })]); assert.equal(results.filter(r => r.data?.userinfo).length, 1); assert.equal(results.filter(r => r.data?.error === 'busy').length, 1);
 const countBeforeRace = calls; const firstLease = req('/run', { id: 'stale-lease', issuer });
 for (let i = 0; calls === countBeforeRace && i < 100; i++) await setTimeout(10); assert.ok(calls > countBeforeRace);
 await req('/expire', { id: 'stale-lease' }); const secondLease = req('/run', { id: 'stale-lease', issuer }); const leaseResults = await Promise.all([firstLease, secondLease]); assert.equal(leaseResults.filter(r => r.data?.error === 'stale').length, 1); assert.equal(leaseResults.filter(r => r.data?.userinfo).length, 1);
 assert.equal((await req('/evict', {})).status, 500); assert.equal((await req('/status', { id: 'stale-lease' })).data.state, 'done');
 mode = 'slow'; const timeout = await req('/run', { id: 'timeout', issuer }); assert.equal(timeout.data.error, 'timeout');
 console.log('Pinned Go discovery resumed after bounded local HTTPS, with policy, lease, retry, redirect, size, concurrency and deadline checks.');
} catch (error) { if (diagnostics) console.error(diagnostics); throw error; } finally { if (worker && worker.exitCode === null && worker.signalCode === null) { const exited = once(worker, 'exit'); worker.kill('SIGTERM'); await exited; } if (idp) await new Promise(done => idp.close(done)); await rm(dir, { recursive: true, force: true }); }
