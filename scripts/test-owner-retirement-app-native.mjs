// Actual application method with native SQLite and a synthetic registry. This
// is not the registry, a real-owner relocation, or a cutover rehearsal.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import vm from 'node:vm';
import * as fence from '../worker/owner-fence.js';
import { recoveryEpochConfiguration } from '../worker/recovery-epochs.js';

const source = await readFile('worker/app.js', 'utf8');
const noop = () => { throw Error('Unexpected dependency'); };
const modules = {
  'cloudflare:workers': { DurableObject: class { constructor(ctx,env) { this.ctx=ctx; this.env=env; } } },
  './generated/baseline.json': { default: {} }, './wasm-module.js': { default: {} },
  './wasi.js': { instantiateReactor: noop }, './sql.js': { execute: noop, sqliteHost: () => ({}) },
  './registry.js': { canonicalOrigin: noop, ProjectRegistry: class {} }, './login-ui.js': { renderLogin: noop },
  './flow-proxy.js': { handleFlowProxy: noop }, './oauth-ingress.js': { handleOAuthIngress: noop, isOAuthRoute: noop },
  './runtime-diagnostics.js': { logOverload: noop, logReactorLifecycle: noop, logRuntimeDiagnostic: noop, logRuntimeError: noop, observeWasmHighWater: noop }, './flow-diagnostics.js': { classifyFlowSubmission: noop },
  './owner-fence.js': fence, './relocation-source-identity.js': { sourceIdentityMatches: noop },
  './relocation-manifest.js': { digestRelocationPage: noop, inspectRelocationDestination: noop, inspectRelocationSource: noop, prepareRelocationDestination: noop, restoreRelocationMetadata: noop, validateRelocationSourceSchema: noop },
  './relocation-chunks.js': { beginChunkExport: noop, beginChunkImport: noop, chunkImportStatus: noop, exportChunk: noop, importChunk: noop },
  './relocation-history.js': { destinationTransferHistory: noop, sourceTransferHistory: noop, transferHistoryStatus: noop },
  './recovery-scopes.js': { assertRecoveryEnvelope: noop, readOwnerRecoveryScopes: noop, recoveryPageDigest: noop, validRecoveryStamp: noop, validateRecoveryScope: noop },
  './recovery-epochs.js': { recoveryEpochConfiguration }, './schema-migration.js': { authorizeSchemaMigration: noop },
  './login-throttle.js': { admitLogin: noop }, './request-body.js': { readBoundedText: noop },
  './relocation-coordinator.js': { RelocationCoordinator: class {} },
};
const context = vm.createContext({ Request, Response, Headers, URL, URLSearchParams, TextEncoder, TextDecoder, Uint8Array, crypto, console });
const app = new vm.SourceTextModule(source, { context, identifier: 'synthetic-retirement-app.mjs' });
await app.link(specifier => {
  const exports = modules[specifier];
  if (!exports) throw Error(`Unexpected import ${specifier}`);
  return new vm.SyntheticModule(Object.keys(exports), function () { for (const [name,value] of Object.entries(exports)) this.setExport(name,value); }, { context, identifier: specifier });
});
await app.evaluate();
const db = new DatabaseSync(':memory:');
const storage = {
  transactionSync(fn) { db.exec('BEGIN'); try { const v=fn(); db.exec('COMMIT'); return v; } catch(e) { db.exec('ROLLBACK'); throw e; } },
  sql: { exec(sql,...args) {
    const stmt=db.prepare(sql), data=stmt.columns().length ? stmt.all(...args) : (stmt.run(...args), []);
    return { toArray:()=>data, one:()=>data[0] };
  } },
};
const route = { origin:'https://p.example', object_name:'destination', generation:2 };
const move = { phase:'committed', move_id:'move', source_object:'source', destination_object:'destination', generation:1, digest:'digest', reconciliationReady:true };
let registryResult = {route,move};
const env = { MAPI_RELOCATION_ENABLED:'1', MAPI_RELOCATION_CONTROL_TOKEN:'secret',
  PROJECT_REGISTRY:{ getByName:()=>({ relocationStatus:async()=>registryResult }) },
  NEXTGEN_APPLICATION:{ idFromName:name=>({toString:()=>name}) },
};
try {
  const owner = new app.namespace.NextgenApplication({storage,id:{toString:()=> 'source'}},env);
  fence.createOwnerFenceTable(storage);
  db.exec("INSERT INTO mapi_owner_fence VALUES (1, 'p', 'https://p.example', 'source', 1, 'frozen', 'move', 'digest')");
  db.exec('CREATE TABLE business (id INTEGER PRIMARY KEY)');
  db.exec("CREATE TRIGGER retirement_fault BEFORE UPDATE ON mapi_owner_fence BEGIN INSERT INTO business VALUES (1); SELECT RAISE(IGNORE); END");
  await assert.rejects(owner.retireRelocation('secret','p','move'), /Owner retirement did not take effect/);
  assert.equal(db.prepare('SELECT state FROM mapi_owner_fence').get().state,'frozen');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM business').get().n,0);
  db.exec('DROP TRIGGER retirement_fault');
  await assert.rejects(owner.retireRelocation('wrong','p','move'), /Relocation control denied/);
  registryResult = {route:{...route,generation:3},move};
  await assert.rejects(owner.retireRelocation('secret','p','move'), /Source retirement is not committed/);
  registryResult = {route,move};
  await owner.retireRelocation('secret','p','move');
  assert.equal(db.prepare('SELECT state FROM mapi_owner_fence').get().state,'retired');
  await owner.retireRelocation('secret','p','move');
  console.log('Application retirement method passed with native SQLite and synthetic registry');
} finally { db.close(); }
