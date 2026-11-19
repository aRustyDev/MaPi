// Private native/workerd SDK CSRF integration; Node simulates browser cookies.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout } from 'node:timers/promises';
import { startLocalZitadel } from '@zitadel/testing';
import { createZitadelClient } from '@zitadel/api/client';
import { setApiCsrfToken, setApiCsrfRejectionHandler } from '@zitadel/api/runtime/auth';
import { ApiError, apiErrorCode } from '@zitadel/api/runtime/fetch';
import { client } from './parity.mjs';

async function port() { const socket = createServer().listen(0, '127.0.0.1'); await once(socket, 'listening'); const p = socket.address().port; await new Promise(done => socket.close(done)); return p; }
async function failure(fn) { try { await fn(); throw Error('Expected refusal'); } catch (e) { if (!(e instanceof ApiError)) throw e; return { status: e.status, code: apiErrorCode(e) ?? null }; } }
const originalFetch = globalThis.fetch;
const dir = await mkdtemp(resolve(tmpdir(), 'mapi-sdk-session-'));
let native, server, nativeDB;
try {
  native = await startLocalZitadel({ dir: resolve(dir, 'native'), projectName: 'Synthetic SDK session parity' });
  const user = await native.seedUser(); const nf = { ...native.handle, user };
  nativeDB = new DatabaseSync(resolve(dir, 'native/.zitadel/local/nextgen-data/zitadel.db'));
  const wf = JSON.parse(await readFile('.mapi/fixture.json', 'utf8'));
  const p = await port(), inspector = await port();
  server = spawn(process.execPath, [resolve('node_modules/wrangler/bin/wrangler.js'), 'dev', '--local', '--config', 'scripts/account-test.wrangler.jsonc', '--env-file', resolve('.dev.vars.poc'), '--ip', '127.0.0.1', '--port', String(p), '--inspector-port', String(inspector), '--persist-to', resolve(dir, 'state')],
    { stdio: ['ignore', 'ignore', 'ignore'], env: { ...process.env, WRANGLER_LOG_PATH: resolve(dir, 'wrangler.log'), WRANGLER_SEND_METRICS: 'false' } });
  const worker = `http://127.0.0.1:${p}`;
  for (let i = 0; ; i++) { if (server.exitCode !== null || i === 100) throw Error('workerd unavailable'); try { await originalFetch(worker + '/livez'); break; } catch { await setTimeout(200); } }

  async function exercise(base, fixture) {
    const setup = client(base, fixture), session = setup.session(await setup.exchange(await setup.mint()));
    const origin = new URL(base).origin, project = fixture.projectId;
    const auditCount = async () => {
      if (origin === worker) {
        const data = await (await originalFetch(`${origin}/__mapi/test`, { method: 'POST', body: JSON.stringify({ command: 'events' }) })).json();
        return data.events.find((event) => event.event_type === 'user.updated')?.count ?? 0;
      }
      return nativeDB.prepare('SELECT count(*) AS n FROM events WHERE project_id = ? AND event_type = ?').get(project, 'user.updated').n;
    };
    const beforeAudit = await auditCount();
    const csrfResponse = await originalFetch(`${origin}/sessions/me/csrf?project_id=${encodeURIComponent(project)}`, { headers: { cookie: session.cookie } });
    assert.equal(csrfResponse.status, 200); const csrf = (await csrfResponse.json()).csrf_token; assert.ok(csrf);
    const seen = [];
    globalThis.fetch = async (input, init) => {
      const request = new Request(input, init); const url = new URL(request.url);
      if (url.origin === origin) { request.headers.set('cookie', session.cookie); request.headers.set('origin', origin); }
      seen.push({ origin: url.origin, method: request.method, hasCsrf: request.headers.has('x-zitadel-csrf') });
      return originalFetch(request);
    };
    const sdk = createZitadelClient({ baseUrl: origin });
    const params = { project_id: project };
    const update = (name) => sdk.updateMyUser({ attributes: { email: `${name}@example.test` } }, params);
    try {
      setApiCsrfRejectionHandler(undefined, origin); setApiCsrfToken(undefined, origin);
      const missing = await failure(() => update('missing-csrf')); assert.equal(missing.status, 403); assert.equal(missing.code, 'auth.csrf_invalid');
      setApiCsrfToken(csrf, origin); const direct = await update('direct-csrf'); assert.equal(direct.attributes.email, 'direct-csrf@example.test');
      let refreshes = 0; setApiCsrfToken('invalid', origin);
      setApiCsrfRejectionHandler(async () => { refreshes++; return csrf; }, origin);
      const beforeRetry = seen.length; const retried = await update('retry-csrf');
      assert.equal(retried.attributes.email, 'retry-csrf@example.test'); assert.equal(refreshes, 1); assert.equal(seen.length - beforeRetry, 2);
      let refused = 0; setApiCsrfToken('invalid', origin);
      setApiCsrfRejectionHandler(async () => { refused++; return undefined; }, origin);
      const beforeRefused = seen.length; const stale = await failure(() => update('refused-csrf'));
      assert.equal(stale.status, 403); assert.equal(stale.code, 'auth.csrf_invalid'); assert.equal(refused, 1); assert.equal(seen.length - beforeRefused, 1);
      assert.equal((await sdk.getMyUser(params)).attributes.email, 'retry-csrf@example.test');
      assert.equal(await auditCount(), beforeAudit + 2, 'refused or retried requests emitted extra audit records');
      // A token scoped to another origin must not travel to this server.
      setApiCsrfRejectionHandler(undefined, origin); setApiCsrfToken(csrf, 'https://other-origin.example');
      const beforeScoped = seen.length; const scoped = await failure(() => update('cross-origin-csrf'));
      assert.equal(scoped.status, 403); assert.equal(seen.length - beforeScoped, 1); assert.equal(seen.at(-1).hasCsrf, false);
      assert.equal((await sdk.getMyUser(params)).attributes.email, 'retry-csrf@example.test');
      assert.equal(await auditCount(), beforeAudit + 2, 'cross-origin token refusal emitted an audit record');
      assert.equal((await setup.revoke(session)).status, 204);
      assert.equal((await failure(() => sdk.getMyUser(params))).status, 401);
      return { missing, stale, scoped, retryRequests: 2, refusalRequests: 1 };
    } finally {
      globalThis.fetch = originalFetch; setApiCsrfToken(undefined, origin); setApiCsrfRejectionHandler(undefined, origin);
    }
  }
  const a = await exercise(native.handle.baseUrl, nf), b = await exercise(worker, wf);
  assert.deepEqual(b, a, 'SDK session/CSRF behavior differs');
  console.log('Pinned @zitadel/api 0.7.0: native/workerd session CSRF, one retry, refusal, origin scope and revocation passed.');
} finally {
  globalThis.fetch = originalFetch; setApiCsrfToken(undefined); setApiCsrfRejectionHandler(undefined);
  if (server && server.exitCode === null && server.signalCode === null) { const stop = once(server, 'exit'); server.kill('SIGTERM'); await stop; }
  nativeDB?.close(); if (native) await native.stop(); await rm(dir, { recursive: true, force: true });
}
