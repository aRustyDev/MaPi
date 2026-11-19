// Local-only performance experiment. No public authentication route.
import { DurableObject } from 'cloudflare:workers';
import wasm from '../worker/generated/upstream-split-test.wasm';
import fixture from '../worker/generated/fixture.json';
import { instantiateReactor } from '../worker/wasi.js';
import { execute, sqliteError } from '../worker/sql.js';
import { installMutationGeneration, mutationGeneration, missingGenerationCoverage } from './mutation-generation.mjs';
import { verifySplit, SplitBusy, SplitStale } from './password-split-protocol.mjs';

const enc = new TextEncoder(), dec = new TextDecoder(), rollback = Symbol('rollback');
const check = (value, message) => { if (!value) throw new Error(message); };

export class SplitLatencyTest extends DurableObject {
  setup({ key, user }) {
    check(!this.reactor && user?.email && user?.password, 'invalid setup');
    const storage = this.ctx.storage, sql = storage.sql;
    storage.transactionSync(() => {
      sql.exec('PRAGMA defer_foreign_keys=ON');
      for (const query of fixture.statements) sql.exec(query);
      sql.exec('CREATE TABLE split_jobs(project TEXT NOT NULL,attempt TEXT NOT NULL,challenge TEXT NOT NULL,job TEXT NOT NULL,lease_until INTEGER NOT NULL,PRIMARY KEY(project,attempt,challenge))');
      installMutationGeneration(storage);
    });
    check(!missingGenerationCoverage(storage).length, 'schema not covered');
    let output, reactor, memory;
    reactor = instantiateReactor(wasm, get => {
      memory = get;
      return {
        sql: (p, n) => { const q = JSON.parse(dec.decode(new Uint8Array(memory(), p, n))); let result; try { result = execute(storage, q); } catch (e) { result = { error: sqliteError(e) }; } output = enc.encode(JSON.stringify(result)); return output.length; },
        result: (p, n) => { new Uint8Array(memory(), p, n).set(output); output.fill(0); output = undefined; },
        transaction: () => { try { storage.transactionSync(() => { if (reactor.mapi_transaction_body() !== 0) throw rollback; }); return 0; } catch (e) { return e === rollback ? 1 : 2; } },
      };
    });
    this.reactor = reactor; this.memory = memory; this.project = fixture.projectId; this.user = user; this.entries = [];
    this.call('mapi_init', { ...key, projectId: this.project });
    this.token = this.call('mapi_project_token', { projectId: this.project }).token;
    for (let i = 0; i < 4; i++) {
      const id = this.ok(this.api('POST', '/auth_attempts', { project_id: this.project })).attempt_id;
      const path = `/auth_attempts/${id}/challenges`;
      const identifier = this.ok(this.api('POST', path, { method: 'identifier' })).challenge_id;
      this.ok(this.api('POST', `${path}/${identifier}/verify`, { login_name: user.email }));
      const challenge = this.ok(this.api('POST', path, { method: 'password' })).challenge_id;
      this.entries.push({ id, path, challenge });
    }
    this.initialSuccessAudits = sql.exec("SELECT count(*) AS n FROM events WHERE project_id=? AND event_type='auth.check.succeeded'", this.project).one().n;
    return { ready: true, attempts: this.entries.length };
  }
  call(name, value) {
    const bytes = enc.encode(JSON.stringify(value)), p = this.reactor.mapi_alloc(bytes.length);
    new Uint8Array(this.memory(), p, bytes.length).set(bytes); bytes.fill(0);
    try { const packed = this.reactor[name](), ptr = Number(packed >> 32n), len = Number(packed & 0xffffffffn); const result = JSON.parse(dec.decode(new Uint8Array(this.memory(), ptr, len))); if (result?.error) throw new Error(`${name}: ${result.code ?? 'failed'}`); return result; }
    finally { this.reactor.mapi_release(); }
  }
  api(method, path, body, options = {}) {
    const headers = { accept: ['application/json'] };
    if (!options.noAuth) headers.authorization = [`Bearer ${this.token}`];
    if (options.cookie) headers.cookie = [options.cookie];
    if (body !== undefined) headers['content-type'] = ['application/json'];
    const result = this.call('mapi_request', { method, url: 'https://split.example' + path, headers, body: body === undefined ? '' : enc.encode(JSON.stringify(body)).toBase64(), peer: '127.0.0.1' });
    return { ...result, data: result.body ? JSON.parse(dec.decode(Uint8Array.fromBase64(result.body))) : null };
  }
  ok(result) { check(result.status >= 200 && result.status < 300, 'upstream operation failed'); return result.data; }
  async verify(mode, index) {
    check(this.reactor && ['inline', 'split'].includes(mode) && Number.isInteger(index) && index >= 0 && index < this.entries.length, 'invalid request');
    const a = this.entries[index], project = this.project, password = this.user.password, storage = this.ctx.storage;
    if (mode === 'inline') {
      const result = this.api('POST', `${a.path}/${a.challenge}/verify`, { password });
      return { outcome: result.status === 200 ? 'success' : 'error' };
    }
    const load = (_project, id, challenge) => { try { return { ...this.call('mapi_split_prepare', { projectId: project, attemptId: id, challengeId: challenge }), epoch: mutationGeneration(storage) }; } catch { return null; } };
    const verify = async ({ password: value, hash, signal }) => {
      const response = await this.env.ARGON_VERIFIER.fetch('https://argon.internal/verify', { method: 'POST', headers: { authorization: `Bearer ${this.env.ARGON_SPIKE_SECRET}`, 'content-type': 'application/json' }, body: JSON.stringify({ password: value, hash }), signal });
      if (!response.ok) throw new Error('verifier unavailable');
      const result = await response.json(); return { verified: result.verified, rehash: result.rehash };
    };
    const finish = (snapshot, verified) => {
      const result = this.call('mapi_split_finish', { projectId: project, attemptId: a.id, challengeId: a.challenge, password, hash: snapshot.hash, verified });
      check(result.ok === verified, 'unexpected upstream result');
    };
    try { const result = await verifySplit({ storage, project, attempt: a.id, challenge: a.challenge, password, load, verify, success: snapshot => finish(snapshot, true), failure: snapshot => finish(snapshot, false) }); return { outcome: result ? 'success' : 'error' }; }
    catch (e) { return { outcome: e instanceof SplitStale ? 'stale' : e instanceof SplitBusy ? 'busy' : 'error' }; }
  }
  finalize() {
    let established = 0, rejectedReplay = 0;
    for (const a of this.entries) {
      const handoff = this.ok(this.api('POST', `/auth_attempts/${a.id}/handoff`)).handoff_token;
      const path = `/sessions/exchange?project_id=${encodeURIComponent(this.project)}`;
      const exchange = this.api('POST', path, { handoff_token: handoff }); this.ok(exchange);
      const cookie = (exchange.headers['Set-Cookie'] ?? [])[0]?.split(';')[0]; check(cookie, 'missing cookie');
      check(this.api('GET', `/sessions/me?project_id=${encodeURIComponent(this.project)}`, undefined, { noAuth: true, cookie }).status === 200, 'session unreadable');
      established++;
      if (this.api('POST', path, { handoff_token: handoff }).status >= 400) rejectedReplay++;
    }
    const events = this.ctx.storage.sql.exec("SELECT count(*) AS n FROM events WHERE project_id=? AND event_type='auth.check.succeeded'", this.project).one().n;
    return { established, rejectedReplay, successAudits: events - this.initialSuccessAudits, wasmBytes: this.memory().byteLength };
  }
}

export default { async fetch(request, env) {
  const url = new URL(request.url);
  if (env.MAPI_LOCAL_TEST !== '1' || !['localhost', '127.0.0.1'].includes(url.hostname) || request.method !== 'POST') return new Response(null, { status: 404 });
  try {
    const body = await request.json();
    if (!['inline', 'split'].includes(body.mode) || !Number.isInteger(body.round) || body.round < 0 || body.round > 9) return new Response(null, { status: 400 });
    const target = env.BENCHMARK.getByName(`${body.mode}-${body.round}`);
    if (url.pathname === '/setup') return Response.json(await target.setup(body));
    if (url.pathname === '/verify') return Response.json(await target.verify(body.mode, body.index));
    if (url.pathname === '/finalize') return Response.json(await target.finalize());
    return new Response(null, { status: 404 });
  } catch { return Response.json({ error: 'test failed' }, { status: 500 }); }
} };
