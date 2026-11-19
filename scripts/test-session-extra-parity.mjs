import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { startLocalZitadel, bootstrapProject } from '@zitadel/testing';
import { client } from './parity.mjs';

async function port() {
  const socket = createServer().listen(0, '127.0.0.1'); await once(socket, 'listening');
  const value = socket.address().port; await new Promise((done, reject) => socket.close(e => e ? reject(e) : done())); return value;
}
const dir = await mkdtemp(resolve(tmpdir(), 'mapi-session-extra-'));
let native, server, nativeDB, diagnostic = '';
try {
  native = await startLocalZitadel({ dir: resolve(dir, 'native'), projectName: 'Session parity' });
  const user = await native.seedUser();
  const foreign = await bootstrapProject({ baseUrl: native.handle.baseUrl, projectName: 'Foreign session parity' });
  const nativeFixture = { ...native.handle, user, otherProjectId: foreign.projectId, otherProjectSecret: foreign.projectSecret };
  const workerFixture = JSON.parse(await readFile('.mapi/fixture.json', 'utf8'));
  nativeDB = new DatabaseSync(resolve(dir, 'native/.zitadel/local/nextgen-data/zitadel.db'), { readOnly: true });
  const p = await port(), inspector = await port();
  server = spawn(process.execPath, [resolve('node_modules/wrangler/bin/wrangler.js'), 'dev', '--local', '--config', 'scripts/session-extra-test.wrangler.jsonc', '--env-file', resolve('.dev.vars.poc'), '--ip', '127.0.0.1', '--port', String(p), '--inspector-port', String(inspector), '--persist-to', resolve(dir, 'state')], {
    stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, WRANGLER_LOG_PATH: resolve(dir, 'wrangler.log'), WRANGLER_SEND_METRICS: 'false' },
  });
  server.stderr.on('data', c => { diagnostic = (diagnostic + c).slice(-10000); });
  const worker = `http://127.0.0.1:${p}`;
  for (let n = 0;; n++) {
    if (server.exitCode !== null || n === 100) throw Error('workerd not ready');
    try { await fetch(worker + '/livez'); break; } catch { await setTimeout(200); }
  }
  async function run(base, fixture, workerSide) {
    const api = client(base, fixture), project = `?project_id=${encodeURIComponent(fixture.projectId)}`;
    const result = {};
    const rec = (label, response) => { result[label] = { status: response.status, code: response.data?.code ?? null }; return response; };
    const countAudit = async type => {
      if (!workerSide) return nativeDB.prepare('SELECT count(*) AS n FROM events WHERE project_id=? AND event_type=?').get(fixture.projectId, type).n;
      const r = await fetch(base + '/__mapi/test', { method: 'POST', body: JSON.stringify({ command: 'events' }) });
      assert.equal(r.status, 200); const data = await r.json(); return data.events.find(e => e.event_type === type)?.count ?? 0;
    };
    const created = rec('anonymous create', await api.send('POST', '/sessions', { body: { project_id: fixture.projectId } }));
    assert.equal(created.status, 201); const anonymous = created.data.session, oldToken = created.data.session_token;
    assert.equal(anonymous.state, 'building'); assert.ok(oldToken);
    assert.ok(Math.abs(Date.parse(anonymous.expires_at) - Date.parse(anonymous.created_at) - 600000) < 2000, 'anonymous session TTL');
    const oldCookie = created.headers.getSetCookie()[0].split(';', 1)[0];
    const sessionId = anonymous.session_id;
    const byId = rec('operator get', await api.send('GET', '/sessions/' + sessionId)); assert.equal(byId.status, 200);
    assert.equal(byId.data.session_id, sessionId);
    rec('operator get no auth', await api.send('GET', '/sessions/' + sessionId, { token: null }));
    rec('operator get session only', await api.send('GET', '/sessions/' + sessionId, { token: null, cookie: oldCookie }));
    const query = rec('operator query', await api.send('POST', '/sessions/query' + project, { body: {} })); assert.equal(query.status, 200);
    assert.ok(query.data.sessions.some(x => x.session_id === sessionId));
    rec('query no auth', await api.send('POST', '/sessions/query' + project, { token: null, body: {} }));
    rec('create no auth', await api.send('POST', '/sessions', { token: null, body: { project_id: fixture.projectId } }));
    rec('create foreign project', await api.send('POST', '/sessions', { body: { project_id: fixture.otherProjectId } }));
    rec('foreign operator', await api.send('GET', '/sessions/' + sessionId, { token: fixture.otherProjectSecret }));

    const missingProof = rec('stepup missing proof', await api.send('POST', '/auth_attempts', { body: { project_id: fixture.projectId, session_id: sessionId } }));
    assert.equal(missingProof.status, 400);
    const linked = rec('stepup create', await api.send('POST', '/auth_attempts', { body: { project_id: fixture.projectId, session_id: sessionId, session_token: oldToken } }));
    assert.equal(linked.status, 201); assert.equal(linked.data.session_id, sessionId);
    api.ok(await api.proof(linked.data.attempt_id, 'identifier', { login_name: fixture.user.email }));
    api.ok(await api.proof(linked.data.attempt_id, 'password', { password: fixture.user.password }));
    const handoff = api.ok(await api.handoff(linked.data.attempt_id)).handoff_token;
    const eventBefore = await countAudit('session.established');
    const tooLong = rec('ttl exceeds max', await api.exchange(handoff, 'PT720H1S'));
    assert.equal(tooLong.status, 400); assert.equal(tooLong.data.code, 'sess.invalid_ttl');
    assert.equal(await countAudit('session.established'), eventBefore, 'invalid TTL wrote audit');
    const upgraded = rec('stepup exchange', await api.exchange(handoff, 'PT1H')); assert.equal(upgraded.status, 200);
    assert.equal(upgraded.data.session.session_id, sessionId); assert.equal(upgraded.data.session.user_id, fixture.user.id);
    const newCookie = upgraded.headers.getSetCookie()[0].split(';', 1)[0];
    assert.equal((await api.send('GET', '/sessions/me' + project, { token: null, cookie: oldCookie })).status, 401, 'old token still active');
    const after = rec('stepup read', await api.send('GET', '/sessions/me' + project, { token: null, cookie: newCookie })); assert.equal(after.status, 200);
    assert.ok(Date.parse(after.data.expires_at) - Date.now() > 3500000 && Date.parse(after.data.expires_at) - Date.now() <= 3600000, 'one hour TTL');
    const expires = after.data.expires_at; await setTimeout(30);
    assert.equal((await api.send('GET', '/sessions/me' + project, { token: null, cookie: newCookie })).data.expires_at, expires, 'read extended session');
    assert.equal(await countAudit('session.established'), eventBefore + 1, 'successful exchange audit missing');
    rec('stepup handoff replay', await api.exchange(handoff, 'PT1H'));
    assert.equal((await api.send('DELETE', '/sessions/' + sessionId)).status, 204);
    assert.equal((await api.send('GET', '/sessions/me' + project, { token: null, cookie: newCookie })).status, 401);
    assert.equal((await api.send('DELETE', '/sessions/' + sessionId)).status, 204, 'operator revoke idempotence');

    for (const [label, ttl, expected] of [['zero ttl', 'PT0S', 'sess.invalid_ttl'], ['negative ttl', '-PT1S', 'req.invalid']]) {
      const token = await api.mint(); const before = await countAudit('session.established');
      const rejected = rec(label, await api.exchange(token, ttl)); assert.equal(rejected.status, 400, label); assert.equal(rejected.data.code, expected, label);
      assert.equal(await countAudit('session.established'), before); assert.equal((await api.exchange(token, 'PT1H')).status, 200, 'invalid TTL consumed handoff');
    }
    const short = api.session(await api.exchange(await api.mint(), 'PT1S')); await setTimeout(1500);
    rec('short expired', await api.read(short)); assert.equal(result['short expired'].status, 401);
    const def = await api.exchange(await api.mint()); assert.equal(def.status, 200);
    const defaultRemaining = Date.parse(def.data.session.expires_at) - Date.now(); assert.ok(defaultRemaining > 86300000 && defaultRemaining <= 86400000, 'default TTL');
    const max = await api.exchange(await api.mint(), 'PT720H'); assert.equal(max.status, 200);
    assert.ok(Date.parse(max.data.session.expires_at) - Date.now() > 719 * 3600000, 'maximum TTL');
    const firstPage = rec('session query page one', await api.send('POST', '/sessions/query' + project, { body: { limit: 1 } }));
    assert.equal(firstPage.status, 200); assert.equal(firstPage.data.sessions.length, 1); assert.ok(firstPage.data.next_page_token);
    const nextPage = rec('session query page two', await api.send('POST', '/sessions/query' + project, { body: { limit: 1, page_token: firstPage.data.next_page_token } }));
    assert.equal(nextPage.status, 200); assert.equal(nextPage.data.sessions.length, 1); assert.notEqual(nextPage.data.sessions[0].session_id, firstPage.data.sessions[0].session_id);
    const badCursor = rec('session query invalid cursor', await api.send('POST', '/sessions/query' + project, { body: { limit: 1, page_token: 'invalid' } })); assert.equal(badCursor.status, 400);
    if (workerSide) {
      const token = await api.mint(); const before = await countAudit('session.established');
      await fetch(base + '/__mapi/test', { method: 'POST', body: JSON.stringify({ command: 'fail_audit' }) });
      assert.equal((await api.exchange(token, 'PT1H')).status, 500);
      assert.equal(await countAudit('session.established'), before, 'failed exchange retained audit');
      assert.equal((await api.exchange(token, 'PT1H')).status, 200, 'failed exchange consumed handoff');
    }
    return result;
  }
  const a = await run(native.handle.baseUrl, nativeFixture, false), b = await run(worker, workerFixture, true);
  for (const key of Object.keys(a)) if (key !== 'foreign operator') assert.deepEqual(b[key], a[key], key);
  assert.ok(a['foreign operator'].status >= 400 && a['foreign operator'].status < 500);
  assert.ok(b['foreign operator'].status >= 400 && b['foreign operator'].status < 500);
  console.log(JSON.stringify({ native: a, worker: b }, null, 2));
  console.log('Native/workerd session create, query, step-up, TTL, audit and revocation parity passed; foreign status reported.');
} catch (error) { if (diagnostic) console.error(diagnostic); throw error; }
finally {
  nativeDB?.close();
  if (server && server.exitCode === null && server.signalCode === null) { const done = once(server, 'exit'); server.kill('SIGTERM'); await done; }
  if (native) await native.stop();
  await rm(dir, { recursive: true, force: true });
}
