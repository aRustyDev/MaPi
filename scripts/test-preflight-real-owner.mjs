// INCOMPLETE LOCAL EXPERIMENT: the last completed runs failed in the issuer
// phase. See docs/preflight-real-owner-local-proof.md before using it.
// Local, in-process test of the experimental preflight counter against the
// real Go/JS owner. This file is not a Worker entry point and has no deploy
// configuration. Its dynamic Worker requires an ephemeral secret binding.
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

const wasm = await readFile('worker/generated/phase1-owner.wasm');
const module = await WebAssembly.compile(wasm);
const exports = new Set(WebAssembly.Module.exports(module).map(entry => entry.name));
for (const name of ['mapi_init', 'mapi_provision', 'mapi_add_user', 'mapi_request', 'mapi_oauth_admin', 'mapi_oauth_request']) {
  if (!exports.has(name)) throw Error(`Prebuilt Phase 1 Wasm missing ${name}`);
}
const secret = randomBytes(32).toString('base64url');
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
const master = Buffer.from(JSON.stringify({ id: 'synthetic-master', pem: privateKey })).toString('base64');

// This module is assembled in memory: it has no checked-in Worker entry or
// deploy configuration. Direct SQL below is test-only, not product authority.
const source = `
import { NextgenApplication } from './worker/app.js';
import { ProjectRegistry } from './worker/registry.js';
import { freezeOwnerFence } from './worker/owner-fence.js';
import { installPreflightGeneration, preflightGeneration, missingPreflightGenerationCoverage } from './scripts/preflight-mutation-generation.mjs';
export { ProjectRegistry };
export class Owner extends NextgenApplication {
  installGeneration() {
    if (this.env.MAPI_LOCAL_TEST !== '1') throw Error('Local test disabled');
    this.ctx.storage.transactionSync(() => installPreflightGeneration(this.ctx.storage));
    return this.observation();
  }
  observation() {
    if (this.env.MAPI_LOCAL_TEST !== '1') throw Error('Local test disabled');
    const sql = this.ctx.storage.sql;
    const trace = Object.fromEntries(sql.exec('SELECT table_name, changes FROM mapi_preflight_trace').toArray().map(row => [row.table_name, row.changes]));
    const count = name => sql.exec('SELECT COUNT(*) AS n FROM ' + name).one().n;
    return { generation: preflightGeneration(this.ctx.storage), missing: missingPreflightGenerationCoverage(this.ctx.storage), users: count('users'), events: count('events'), throttle: count('mapi_login_limits'), trace };
  }
  rewindGeneration(value) {
    if (this.env.MAPI_LOCAL_TEST !== '1') throw Error('Local test disabled');
    this.ctx.storage.sql.exec('UPDATE mapi_preflight_generation SET counter=CAST(? AS INTEGER) WHERE singleton=1', value);
  }
  freeze(route) {
    if (this.env.MAPI_LOCAL_TEST !== '1') throw Error('Local test disabled');
    freezeOwnerFence(this.ctx.storage, route, 'synthetic-move');
  }
}
const fail = message => { throw Error(message); };
const advanced = (before, after, table) => BigInt(after.generation) > BigInt(before.generation) && (after.trace[table] ?? 0) > (before.trace[table] ?? 0);
const rejected = async call => { try { await call(); } catch { return; } fail('Expected failure'); };
export default {
  async fetch(request, env) {
    if (env.MAPI_LOCAL_TEST !== '1' || !env.TEST_SECRET || request.headers.get('authorization') !== 'Bearer ' + env.TEST_SECRET || new URL(request.url).hostname !== '127.0.0.1') return new Response(null, { status: 404 });
    let phase = 'provision';
    try {
      const origin = 'https://preflight-owner.example', objectName = 'synthetic-preflight-owner';
      let owner = env.NEXTGEN_APPLICATION.getByName(objectName);
      const registry = env.PROJECT_REGISTRY.getByName('projects');
      await registry.reserve(origin, objectName);
      const projectId = (await owner.provision('Synthetic', origin, { projectId: null, origin, objectName, generation: 1 })).projectId;
      await registry.activate(origin, objectName, projectId);
      const route = { projectId, origin, objectName, generation: 1 };
      phase = 'install';
      const initial = await owner.installGeneration();
      if (initial.missing.length) fail('Initial trigger coverage incomplete');
      phase = 'user-create';
      await owner.addUser('one@example.test', 'Synthetic-password-123!', route);
      const created = await owner.observation();
      if (!advanced(initial, created, 'users') || !advanced(initial, created, 'events') || created.users !== initial.users + 1) fail('Go user and audit writes not observed');
      phase = 'audit-rollback';
      await owner.failNextAudit();
      await rejected(() => owner.addUser('rolled-back@example.test', 'Synthetic-password-456!', route));
      const rollback = await owner.observation();
      if (JSON.stringify(rollback) !== JSON.stringify(created)) fail('Audit failure did not roll back revision and rows');
      phase = 'flow-throttle';
      const flow = { method: 'POST', url: origin + '/api/v1/flows/flow_missing/submit', headers: { origin: [origin], 'content-type': ['application/json'] }, body: 'e30=', peer: '192.0.2.44' };
      const flowResult = await owner.flowRequest(flow, route);
      if (flowResult.status >= 500) fail('Synthetic flow failed');
      const throttled = await owner.observation();
      if (!advanced(rollback, throttled, 'mapi_login_limits') || throttled.throttle <= rollback.throttle) fail('JS throttle write not observed');
      phase = 'issuer-call';
      await owner.oauthAdmin('initialize', {}, route);
      phase = 'issuer-assertion';
      const issuer = await owner.observation();
      if (!advanced(throttled, issuer, 'mapi_oauth_signing_keys') || !advanced(throttled, issuer, 'events')) fail('Go issuer initialization not observed');
      // A privileged SQL writer can rewind this prototype's excluded control
      // table after a genuine owner mutation, defeating revision equality.
      phase = 'counter-rewind';
      const scanRevision = issuer.generation;
      await owner.addUser('two@example.test', 'Synthetic-password-789!', route);
      const changed = await owner.observation();
      if (!advanced(issuer, changed, 'users') || changed.users !== issuer.users + 1) fail('Expected owner mutation missing');
      await owner.rewindGeneration(scanRevision);
      const rewound = await owner.observation();
      if (rewound.generation !== scanRevision || rewound.users !== changed.users || rewound.missing.length) fail('Counter rewind reproduction failed');
      phase = 'frozen-owner';
      await owner.freeze(route);
      const frozen = await owner.observation();
      await rejected(() => owner.addUser('frozen@example.test', 'Synthetic-password-000!', route));
      const afterReject = await owner.observation();
      if (JSON.stringify(afterReject) !== JSON.stringify(frozen)) fail('Frozen write changed state');
      await rejected(() => owner.evict());
      owner = env.NEXTGEN_APPLICATION.getByName(objectName);
      await rejected(() => owner.addUser('evicted@example.test', 'Synthetic-password-111!', route));
      const afterEviction = await owner.observation();
      if (JSON.stringify(afterEviction) !== JSON.stringify(frozen)) fail('Evicted frozen owner changed state');
      return Response.json({ ok: true, realGoUserAndAudit: true, auditRollback: true, jsThrottle: true, realGoIssuer: true, realOwnerCounterRewind: true, frozenAndEvictedRejection: true });
    } catch { return Response.json({ ok: false, phase }, { status: 500 }); }
  },
};`;

const bundle = await build({
  stdin: { contents: source, resolveDir: process.cwd(), sourcefile: 'preflight-real-owner-test.js', loader: 'js' },
  bundle: true, write: false, format: 'esm', platform: 'neutral', target: 'es2022',
  external: ['cloudflare:workers', 'node:crypto'],
  plugins: [{ name: 'prebuilt-phase1-wasm', setup(build) {
    build.onResolve({ filter: /^\.\/wasm-module\.js$/ }, args => args.importer === resolve('worker/app.js') ? { path: 'phase1-test-wasm', namespace: 'phase1-test' } : null);
    build.onLoad({ filter: /.*/, namespace: 'phase1-test' }, () => ({ contents: 'import wasm from "./phase1-owner.wasm"; export default wasm;', loader: 'js' }));
    build.onResolve({ filter: /^\.\/phase1-owner\.wasm$/ }, () => ({ path: './phase1-owner.wasm', external: true }));
  } }],
});
const mf = new Miniflare(convertV4MiniflareOptions({
  workers: [{ name: 'synthetic-preflight-real-owner', compatibilityDate: '2026-11-19',
    modules: [{ type: 'ESModule', path: 'worker.js', contents: bundle.outputFiles[0].text }, { type: 'CompiledWasm', path: 'phase1-owner.wasm', contents: wasm }],
    durableObjects: { NEXTGEN_APPLICATION: { className: 'Owner', useSQLite: true }, PROJECT_REGISTRY: { className: 'ProjectRegistry', useSQLite: true } },
    bindings: { TEST_SECRET: secret, MAPI_LOCAL_TEST: '1', MAPI_OIDC_EXPERIMENTAL: '1', MAPI_MASTER_KEY: master },
  }], host: '127.0.0.1', port: 0, telemetry: { enabled: false },
}));
try {
  const response = await mf.dispatchFetch('http://127.0.0.1/', { headers: { authorization: 'Bearer ' + secret } });
  const result = await response.json();
  assert.equal(response.status, 200, `Local owner proof failed in ${result.phase ?? 'unknown'} (HTTP ${response.status})`);
  assert.deepEqual(result, { ok: true, realGoUserAndAudit: true, auditRollback: true, jsThrottle: true, realGoIssuer: true, realOwnerCounterRewind: true, frozenAndEvictedRejection: true });
  console.log('Real-owner preflight counter coverage and privileged-rewind counterexample passed.');
} finally { await mf.dispose(); }
