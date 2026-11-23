// In-process synthetic test of the direct flow-release RPC. No Worker entry or
// deployment configuration is produced, and no Cloudflare credential is used.
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

const wasm = await readFile('worker/generated/phase1-owner.wasm');
const names = new Set(WebAssembly.Module.exports(await WebAssembly.compile(wasm)).map(item => item.name));
for (const name of ['mapi_init', 'mapi_provision', 'mapi_flow_release']) if (!names.has(name)) throw Error(`Missing flow test export: ${name}`);
const flow = JSON.parse(await readFile('.mapi/nextgen/packages/config/defaults/default-login.json', 'utf8'));
const secret = randomBytes(32).toString('base64url');
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
const master = Buffer.from(JSON.stringify({ id: 'synthetic-master', pem: privateKey })).toString('base64');

const source = `
import { NextgenApplication } from './worker/app.js';
import { ProjectRegistry } from './worker/registry.js';
import { freezeOwnerFence } from './worker/owner-fence.js';
import { execute } from './worker/sql.js';
export { ProjectRegistry };
export class FlowOwner extends NextgenApplication {
  snapshot() {
    if (this.env.MAPI_LOCAL_TEST !== '1') throw Error('Local test disabled');
    const tables = ['projects', 'flow_definitions', 'releases', 'deployments', 'events'];
    return Object.fromEntries(tables.map(name => [name, execute(this.ctx.storage, { statement: 'SELECT * FROM ' + name + (name === 'projects' ? ' ORDER BY id' : ' ORDER BY project_id, id'), args: [], query: true })]));
  }
  freeze(route) {
    if (this.env.MAPI_LOCAL_TEST !== '1') throw Error('Local test disabled');
    return freezeOwnerFence(this.ctx.storage, route, 'synthetic-flow-freeze');
  }
  evict() { if (this.env.MAPI_LOCAL_TEST !== '1') throw Error('Local test disabled'); this.ctx.abort('synthetic flow test eviction'); }
}
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
async function reject(fn, expected) {
  try { await fn(); } catch (error) { if (!expected || String(error).includes(expected)) return; throw Error('Unexpected rejection'); }
  throw Error('Expected rejection');
}
export default {
  async fetch(request, env) {
    if (env.MAPI_LOCAL_TEST !== '1' || !env.TEST_SECRET || request.headers.get('authorization') !== 'Bearer ' + env.TEST_SECRET || new URL(request.url).hostname !== '127.0.0.1') return new Response(null, { status: 404 });
    let phase = 'setup';
    try {
      const origin = 'https://flow-authority.example', objectName = 'flow-authority-owner';
      const registry = env.PROJECT_REGISTRY.getByName('projects');
      await registry.reserve(origin, objectName);
      let owner = env.NEXTGEN_APPLICATION.getByName(objectName);
      const projectId = (await owner.provision('Synthetic flow project', origin, { projectId: null, origin, objectName, generation: 1 })).projectId;
      await registry.activate(origin, objectName, projectId);
      const route = { projectId, origin, objectName, generation: 1 };
      phase = 'status';
      const initial = await owner.flowRelease('status', {}, route);
      const snapshot = await owner.snapshot();
      const document = ${JSON.stringify(flow)};
      document.name = initial.loginFlows[0].name;
      document.steps[0].name = 'identifier_custom';
      document.purposes.login = 'identifier_custom';
      for (const step of document.steps) for (const transition of Object.values(step.transitions ?? {})) if (transition.target === 'identifier') transition.target = 'identifier_custom';
      phase = 'override';
      for (const options of [
        { action: 'publish', document, expectedDeploymentId: initial.deploymentId },
        { projectId: 'proj_foreign' }, { origin: 'https://foreign.example' },
        { ProjectID: 'proj_foreign' }, { Action: 'publish' },
        { document }, null, [],
      ]) {
        await reject(() => owner.flowRelease('status', options, route), 'Invalid flow release options');
        if (!same(await owner.snapshot(), snapshot)) throw Error('Rejected options changed rows');
      }
      if (!same(await owner.flowRelease('status', {}, route), initial)) throw Error('Rejected options changed deployment');
      const hidden = {};
      Object.defineProperty(hidden, 'action', { value: 'publish', enumerable: false });
      const inherited = Object.create({ action: 'publish' });
      const special = {};
      for (const [label, options] of [['hidden', hidden], ['inherited', inherited]]) {
        let value, wasRejected = false;
        try { value = await owner.flowRelease('status', options, route); } catch { wasRejected = true; }
        if (!wasRejected && !same(value, initial)) throw Error('Non-enumerable authority changed status');
        special[label] = wasRejected ? 'rejected' : 'accepted-status';
        if (!same(await owner.snapshot(), snapshot)) throw Error('Special options changed rows');
      }
      phase = 'publish';
      const published = await owner.flowRelease('publish', { document, expectedDeploymentId: initial.deploymentId }, route);
      const afterPublish = await owner.snapshot();
      if (!published.deploymentId || published.deploymentId === initial.deploymentId || afterPublish.events.rows.length <= snapshot.events.rows.length) throw Error('Valid publish did not commit with audit');
      phase = 'rollback';
      const rolledBack = await owner.flowRelease('rollback', { targetDeploymentId: initial.deploymentId, expectedDeploymentId: published.deploymentId }, route);
      const afterRollback = await owner.snapshot();
      if (!rolledBack.deploymentId || afterRollback.events.rows.length <= afterPublish.events.rows.length) throw Error('Valid rollback did not commit with audit');
      const finalStatus = await owner.flowRelease('status', {}, route);
      if (finalStatus.deploymentId !== rolledBack.deploymentId) throw Error('Final flow status mismatch');
      phase = 'stale';
      const beforeStale = await owner.snapshot();
      await reject(() => owner.flowRelease('publish', { document, expectedDeploymentId: finalStatus.deploymentId }, { ...route, generation: 2 }));
      if (!same(await owner.snapshot(), beforeStale)) throw Error('Stale call changed rows');
      await owner.freeze(route);
      const frozen = await owner.snapshot();
      await reject(() => owner.flowRelease('publish', { document, expectedDeploymentId: finalStatus.deploymentId }, route));
      if (!same(await owner.snapshot(), frozen)) throw Error('Frozen call changed rows');
      await reject(() => owner.evict());
      owner = env.NEXTGEN_APPLICATION.getByName(objectName);
      await reject(() => owner.flowRelease('publish', { document, expectedDeploymentId: finalStatus.deploymentId }, route));
      if (!same(await owner.snapshot(), frozen)) throw Error('Evicted frozen call changed rows');
      return Response.json({ ok: true, overrideRejected: true, validPublishAndRollback: true, staleAndFrozenRejected: true, special });
    } catch { return Response.json({ ok: false, phase }, { status: 500 }); }
  },
};`;

const bundle = await build({
  stdin: { contents: source, resolveDir: process.cwd(), sourcefile: 'flow-release-authority-test.js', loader: 'js' },
  bundle: true, write: false, format: 'esm', platform: 'neutral', target: 'es2022', external: ['cloudflare:workers'],
  plugins: [{ name: 'prebuilt-phase1-wasm', setup(build) {
    build.onResolve({ filter: /^\.\/wasm-module\.js$/ }, args => args.importer === resolve('worker/app.js') ? { path: 'phase1-test-wasm', namespace: 'phase1-test' } : null);
    build.onLoad({ filter: /.*/, namespace: 'phase1-test' }, () => ({ contents: 'import wasm from "./phase1-owner.wasm"; export default wasm;', loader: 'js' }));
    build.onResolve({ filter: /^\.\/phase1-owner\.wasm$/ }, () => ({ path: './phase1-owner.wasm', external: true }));
  } }],
});
const mf = new Miniflare(convertV4MiniflareOptions({
  workers: [{ name: 'synthetic-flow-release-authority', compatibilityDate: '2026-11-19',
    modules: [{ type: 'ESModule', path: 'worker.js', contents: bundle.outputFiles[0].text }, { type: 'CompiledWasm', path: 'phase1-owner.wasm', contents: wasm }],
    durableObjects: { NEXTGEN_APPLICATION: { className: 'FlowOwner', useSQLite: true }, PROJECT_REGISTRY: { className: 'ProjectRegistry', useSQLite: true } },
    bindings: { TEST_SECRET: secret, MAPI_LOCAL_TEST: '1', MAPI_OIDC_EXPERIMENTAL: '1', MAPI_MASTER_KEY: master },
  }], host: '127.0.0.1', port: 0, telemetry: { enabled: false },
}));
try {
  const response = await mf.dispatchFetch('http://127.0.0.1/', { headers: { authorization: 'Bearer ' + secret } });
  const result = await response.json();
  assert.equal(response.status, 200, `Local flow-release test failed at ${result.phase ?? 'unknown'}`);
  assert.equal(result.ok, true);
  assert.equal(result.overrideRejected, true);
  assert.equal(result.validPublishAndRollback, true);
  assert.equal(result.staleAndFrozenRejected, true);
  for (const label of ['hidden', 'inherited']) assert.ok(['accepted-status', 'rejected'].includes(result.special?.[label]));
  console.log(JSON.stringify({ message: 'Flow release authority and fenced mutation checks passed.', specialOptions: result.special }));
} finally { await mf.dispose(); }
