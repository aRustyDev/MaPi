// Run with --experimental-vm-modules. This executes the real app.fetch logic
// with synthetic registry/owner bindings and no real Durable Object, Go Wasm,
// recovery, relocation or hosted services.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { readBoundedText } from '../worker/request-body.js';

const source = await readFile('worker/app.js', 'utf8');
const noop = () => { throw Error('unexpected mocked dependency'); };
const modules = {
  'cloudflare:workers': { DurableObject: class {} },
  './generated/baseline.json': { default: {} },
  './wasm-module.js': { default: {} },
  './wasi.js': { instantiateReactor: noop },
  './sql.js': { execute: noop, sqliteHost: () => ({}) },
  './registry.js': { canonicalOrigin: value => new URL(value).origin, ProjectRegistry: class {} },
  './login-ui.js': { renderLogin: noop },
  './flow-proxy.js': { handleFlowProxy: noop },
  './oauth-ingress.js': { handleOAuthIngress: noop, isOAuthRoute: () => false },
  './runtime-diagnostics.js': { logOverload: noop, logReactorLifecycle: noop, logRuntimeDiagnostic: noop, logRuntimeError: noop, observeWasmHighWater: noop },
  './flow-diagnostics.js': { classifyFlowSubmission: noop },
  './owner-fence.js': { assertOwnerFence: noop, createOwnerFenceTable: noop, freezeOwnerFence: noop, initializeOwnerFence: noop, reserveMoveDestination: noop, retireOwnerFence: noop, withOwnerFence: noop },
  './relocation-source-identity.js': { sourceIdentityMatches: noop },
  './relocation-manifest.js': { digestRelocationPage: noop, inspectRelocationDestination: noop, inspectRelocationSource: noop, prepareRelocationDestination: noop, restoreRelocationMetadata: noop, validateRelocationSourceSchema: noop },
  './relocation-chunks.js': { beginChunkExport: noop, beginChunkImport: noop, chunkImportStatus: noop, exportChunk: noop, importChunk: noop },
  './relocation-history.js': { destinationTransferHistory: noop, sourceTransferHistory: noop, transferHistoryStatus: noop },
  './recovery-scopes.js': { assertRecoveryEnvelope: noop, readOwnerRecoveryScopes: noop, recoveryPageDigest: noop, validRecoveryStamp: noop, validateRecoveryScope: noop },
  './recovery-epochs.js': { recoveryEpochConfiguration: noop },
  './schema-migration.js': { authorizeSchemaMigration: noop },
  './login-throttle.js': { admitLogin: noop },
  './request-body.js': { readBoundedText },
  './relocation-coordinator.js': { RelocationCoordinator: class {} },
};
const context = vm.createContext({ Request, Response, Headers, URL, URLSearchParams, TextEncoder, TextDecoder, Uint8Array, crypto, console });
const module = new vm.SourceTextModule(source, { context, identifier: 'synthetic-app.mjs' });
await module.link(specifier => {
  const exports = modules[specifier];
  if (!exports) throw Error(`Unexpected import ${specifier}`);
  return new vm.SyntheticModule(Object.keys(exports), function () {
    for (const [name, value] of Object.entries(exports)) this.setExport(name, value);
  }, { context, identifier: specifier });
});
await module.evaluate();
const app = module.namespace.default;
const origin = 'https://project.example';
const project = 'proj_test';
const route = { origin, project_id: project, object_name: 'project:test', generation: 1, state: 'active' };
let registryReads, activationCalls, identityReads, statusReads, loginCalls, sessionCalls, adminCalls, provisionCalls;
function reset() { registryReads = activationCalls = identityReads = statusReads = loginCalls = sessionCalls = adminCalls = provisionCalls = 0; }
const registry = {
  async resolve(value) { registryReads++; assert.equal(value, origin); return route; },
  async reserve() { throw Error('unexpected reservation'); },
  async activate() { activationCalls++; return route; },
};
const object = {
  async identity() { identityReads++; return project; },
  async status() { statusReads++; return { ready: true, recoveryReady: true, fenceReady: true, maintenance: false }; },
  async login(email, password) { loginCalls++; assert.equal(email, 'a@example.test'); assert.equal(password, 'secret'); return { status: 200, cookie: 'session=value; Secure; HttpOnly' }; },
  async session() { sessionCalls++; return { status: 204, headers: {} }; },
  async addUser() { adminCalls++; return {}; },
  async oauthAdmin() { adminCalls++; return {}; },
  async restore() { adminCalls++; },
  async provision() { provisionCalls++; return {projectId: project}; },
};
const env = {
  MAPI_APP_ORIGIN: origin, MAPI_OPERATOR_TOKEN: 'operator', MAPI_MASTER_KEY: 'synthetic',
  MAPI_OIDC_EXPERIMENTAL: '1',
  PROJECT_REGISTRY: { getByName() { return registry; } },
  NEXTGEN_APPLICATION: { getByName() { return object; } },
};
function streaming(chunks, keepOpen) {
  let index = 0, canceled = 0;
  const body = new ReadableStream({
    pull(controller) { if (index === chunks.length) { if (!keepOpen) controller.close(); } else controller.enqueue(chunks[index++]); },
    cancel() { canceled++; return new Promise(() => {}); },
  });
  return { body, canceled: () => canceled };
}
async function invoke(path, chunks, overrides = {}, keepOpen = false) {
  const input = streaming(chunks, keepOpen);
  const req = new Request(origin + path, { method: 'POST', headers: { origin, authorization: 'Bearer operator' }, body: input.body, duplex: 'half' });
  const result = await Promise.race([
    app.fetch(req, {...env, ...overrides}),
    new Promise((_, reject) => setTimeout(() => reject(Error('legacy body response stalled')), 1000)),
  ]);
  return { result, input };
}
const encode = value => new TextEncoder().encode(value);
reset();
let response = await invoke('/login', [encode('email=a%40example.test&password=secret')]);
assert.equal(response.result.status, 303);
assert.equal(response.result.headers.get('cache-control'), 'no-store');
assert.equal(loginCalls, 1); assert.equal(identityReads, 1); assert.equal(statusReads, 1); assert.equal(registryReads, 1);
reset();
response = await invoke('/logout', [encode('csrf=token')]);
assert.equal(response.result.status, 303); assert.equal(sessionCalls, 1);
reset();
response = await invoke('/login', [...Array.from({length: 1024}, () => new Uint8Array()), encode('email=a%40example.test&password=secret')]);
assert.equal(response.result.status, 303); assert.equal(loginCalls, 1);
reset();
response = await invoke('/_mapi/admin/users', [encode('{"email":"a@example.test","password":"secret"}')]);
assert.equal(response.result.status, 200); assert.equal(response.result.headers.get('cache-control'), 'no-store'); assert.equal(adminCalls, 1);

for (const [path, overrides, expectedStatus, expectedCache] of [
  ['/login', {}, 413, 'no-store'],
  ['/logout', {}, 413, 'no-store'],
  ['/_mapi/admin/users', {}, 413, null],
  ['/_mapi/admin/init', {}, 413, null],
  ['/_mapi/admin/projects', {}, 400, 'no-store'],
  ['/_mapi/admin/oidc/clients', {}, 400, 'no-store'],
  ['/_mapi/admin/restore', { MAPI_MAINTENANCE: '1' }, 413, null],
]) {
  for (const chunks of [[new Uint8Array(path.includes('/oidc/') ? 65537 : 4097)], Array.from({length: 1025}, () => new Uint8Array())]) {
    reset();
    const {result, input} = await invoke(path, chunks, overrides, true);
    assert.equal(result.status, expectedStatus, path);
    assert.equal(result.headers.get('cache-control'), expectedCache, path);
    assert.equal(input.canceled(), 1, path);
    assert.equal(loginCalls + sessionCalls + adminCalls + provisionCalls, 0, path);
    assert.equal(registryReads, 1, path);
    // The legacy singleton init path can attempt idempotent registry activation
    // before reading the body; its provision mutation must still not run.
    assert.equal(activationCalls, path === '/_mapi/admin/init' ? 1 : 0, path);
    if (path !== '/_mapi/admin/projects') assert.equal(identityReads, 1, path);
  }
}
console.log('Legacy app request-body limits and mutation boundaries passed with synthetic bindings.');
