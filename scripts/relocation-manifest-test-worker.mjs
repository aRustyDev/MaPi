import { NextgenApplication } from '../worker/app.js';
import { initializeOwnerFence, freezeOwnerFence, reserveMoveDestination } from '../worker/owner-fence.js';
import { beginChunkExport, exportChunk, beginChunkImport, importChunk, chunkImportStatus } from '../worker/relocation-chunks.js';
import { inspectRelocationSource, inspectRelocationDestination, restoreRelocationMetadata, digestRelocationPage, prepareRelocationDestination } from '../worker/relocation-manifest.js';
import { execute } from '../worker/sql.js';
import issuerSchema from '../worker/relocation-issuer-schema.json';
import { canonicalScopeVectors, noncanonicalScopeVectors } from './recovery-scope-vectors.mjs';
import { ProjectRegistry } from '../worker/registry.js';
import baseline from '../worker/generated/baseline.json';
export { ProjectRegistry };

const check = (condition, message) => { if (!condition) throw Error(message); };
const reject = async (fn, message) => { try { await fn(); } catch (error) { if (String(error).includes(message)) return; throw error; } throw Error(`Expected ${message}`); };
const quote = value => '"' + value.replaceAll('"', '""') + '"';

export class ManifestProject extends NextgenApplication {
  arm(route, move) { initializeOwnerFence(this.ctx.storage, route); freezeOwnerFence(this.ctx.storage, route, move); }
  reserve(route, move) {
    reserveMoveDestination(this.ctx.storage, route, move);
    if (this.ctx.storage.sql.exec("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'mapi_schema_version'").toArray().length) return;
    this.ctx.storage.transactionSync(() => {
      const sql = this.ctx.storage.sql;
      sql.exec('CREATE TABLE mapi_schema_version (version INTEGER PRIMARY KEY)');
      sql.exec('CREATE TABLE mapi_project (project_id TEXT PRIMARY KEY, schema_url TEXT NOT NULL)');
      sql.exec('CREATE TABLE mapi_project_origin (origin TEXT NOT NULL)');
      sql.exec('CREATE TABLE mapi_login_limits (key TEXT PRIMARY KEY, window INTEGER NOT NULL, count INTEGER NOT NULL)');
      sql.exec('CREATE TABLE mapi_recovery_epoch (epoch TEXT NOT NULL)'); sql.exec("INSERT INTO mapi_recovery_epoch VALUES ('0')");
      for (const statement of baseline.statements) sql.exec(statement);
      sql.exec('INSERT INTO mapi_schema_version VALUES (?)', baseline.version);
    });
  }
  prepare(manifest, route) { return prepareRelocationDestination(this.ctx.storage, manifest, route); }
  source(route, move) { return inspectRelocationSource(this.ctx.storage, route, move); }
  destination(manifest) { return inspectRelocationDestination(this.ctx.storage, manifest); }
  restoreMetadata(manifest) { return restoreRelocationMetadata(this.ctx.storage, manifest); }
  digest(manifest, role, table, cursor) { return digestRelocationPage(this.ctx.storage, manifest, role, table, cursor); }
  installRealDigestFixtures() {
    this.ctx.storage.sql.exec('CREATE TABLE test_real_infinity (id INTEGER PRIMARY KEY, value REAL)');
    this.ctx.storage.sql.exec('INSERT INTO test_real_infinity VALUES (1, 1e999), (2, -1e999)');
    this.ctx.storage.sql.exec('CREATE TABLE test_real_null (id INTEGER PRIMARY KEY, value REAL)');
    this.ctx.storage.sql.exec('INSERT INTO test_real_null VALUES (1, NULL)');
  }
  exportBegin(route, move, tables) { return beginChunkExport(this.ctx.storage, route.projectId, route.generation, move, tables); }
  chunk(route, move, index) { return exportChunk(this.ctx.storage, route.projectId, route.generation, move, index); }
  importBegin(route, move, name, tables) { return beginChunkImport(this.ctx.storage, route.projectId, route.generation, move, name, tables); }
  receive(projectId, chunk) { return importChunk(this.ctx.storage, projectId, chunk); }
  checkpoint(projectId) { return chunkImportStatus(this.ctx.storage, projectId); }
  installIssuer(projectId, seed = false) {
    this.ctx.storage.transactionSync(() => {
      const sql = this.ctx.storage.sql;
      for (const item of issuerSchema.filter(item => item.type === 'table')) sql.exec(item.sql);
      for (const item of issuerSchema.filter(item => item.type === 'index')) sql.exec(item.sql);
      if (!seed) return;
      for (const item of issuerSchema.filter(item => item.type === 'table')) {
        const columns = sql.exec(`PRAGMA table_xinfo(${quote(item.name)})`).toArray().filter(column => column.hidden === 0);
        const values = columns.map(column => {
          if (column.name === 'project_id') return projectId;
          if (column.name === 'kind') return 'par';
          if (column.name === 'prompt') return 'consent';
          if (column.name === 'profile') return 'bearer';
          if (column.type.toUpperCase() === 'INTEGER') return 1;
          if (column.type.toUpperCase() === 'BLOB') return new Uint8Array([1, 2, 3]).buffer;
          return 'fixture';
        });
        sql.exec(`INSERT INTO ${quote(item.name)} (${columns.map(column => quote(column.name)).join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`, ...values);
      }
    });
  }
  changeReference() { this.ctx.storage.sql.exec("UPDATE authz_catalogs SET owner_id = 'changed'"); }
  reference() { return this.ctx.storage.sql.exec('SELECT owner_id FROM authz_catalogs').one().owner_id; }
  corrupt(kind, projectId) {
    const sql = this.ctx.storage.sql;
    if (kind === 'unknown') sql.exec('CREATE TABLE unauthorized_extension (id TEXT PRIMARY KEY)');
    else if (kind === 'hidden') sql.exec('CREATE TABLE __unexpected (id TEXT PRIMARY KEY)');
    else if (kind === 'sqlite-prefix') sql.exec('CREATE TABLE sqliteXunexpected (id TEXT PRIMARY KEY)');
    else if (kind === 'schema') sql.exec('CREATE INDEX unauthorized_user_index ON users (id)');
    else if (kind === 'foreign') sql.exec("INSERT INTO events (project_id,id,event_type,category,occurred_at,created_at) VALUES ('other','event_other','fixture','entity',1,1)");
    else if (kind === 'principal') sql.exec("UPDATE authz_assignments SET principal_type = 'user', principal_id = 'missing' WHERE project_id = ?", projectId);
    else if (kind === 'global') sql.exec("INSERT INTO event_sinks (id,type,scope,enabled) VALUES ('sink','http','global',0)");
    else if (kind === 'origin') sql.exec("UPDATE mapi_project_origin SET origin='https://wrong.example'");
    else if (kind === 'issuer-foreign') sql.exec("UPDATE mapi_oauth_codes SET project_id='foreign'");
    else if (kind === 'issuer-index') sql.exec('DROP INDEX mapi_fapi_reload_expiry');
    else if (kind === 'issuer-schema') sql.exec('ALTER TABLE mapi_oauth_codes ADD COLUMN extra TEXT');
    else if (kind === 'issuer-prompt') sql.exec("UPDATE mapi_fapi_prompts SET token_hash=X'99'");
    else if (kind === 'clock-empty') sql.exec('DELETE FROM mapi_revision_clock');
    else if (kind === 'clock-text') sql.exec("UPDATE mapi_revision_clock SET stamp = 'invalid'");
    else if (kind === 'clock-multiple') { sql.exec('PRAGMA ignore_check_constraints = ON'); sql.exec('INSERT INTO mapi_revision_clock VALUES (2, 7)'); sql.exec('PRAGMA ignore_check_constraints = OFF'); }
    else if (kind === 'scope-text') sql.exec("UPDATE mapi_revision_scopes SET stamp = 'invalid'");
    else if (kind === 'scope-empty') sql.exec("UPDATE mapi_revision_scopes SET scope = '' WHERE scope = (SELECT min(scope) FROM mapi_revision_scopes)");
    else if (kind === 'scope-ahead') sql.exec('UPDATE mapi_revision_clock SET stamp = 1');
    else if (kind === 'scope-none') sql.exec('DELETE FROM mapi_revision_scopes');
    else if (kind === 'scope-foreign') sql.exec('INSERT INTO mapi_revision_scopes VALUES (?, 1)', JSON.stringify({ v: 1, kind: 'user-update', args: ['proj_foreign', 'user_deleted'] }));
    else if (kind === 'scope-event-foreign') sql.exec('INSERT INTO mapi_revision_scopes VALUES (?, 1)', JSON.stringify({ v: 1, kind: 'event', args: [projectId, 'proj_foreign'] }));
    else if (kind === 'scope-unknown') sql.exec('INSERT INTO mapi_revision_scopes VALUES (?, 1)', JSON.stringify({ v: 1, kind: 'unknown-kind', args: [projectId, 'x'] }));
    else if (kind === 'scope-arity') sql.exec('INSERT INTO mapi_revision_scopes VALUES (?, 1)', JSON.stringify({ v: 1, kind: 'user-update', args: [projectId] }));
    else if (kind === 'scope-duplicate') sql.exec('INSERT INTO mapi_revision_scopes VALUES (?, 1)', `{"v":1,"kind":"project-create","args":null,"args":null}`);
    else if (kind.startsWith('scope-noncanonical-')) sql.exec('INSERT INTO mapi_revision_scopes VALUES (?, 1)', noncanonicalScopeVectors(projectId)[Number(kind.slice('scope-noncanonical-'.length))]);
  }
  sequence() { return execute(this.ctx.storage, { statement: 'SELECT name, seq FROM sqlite_sequence ORDER BY name', args: [], query: true }); }
  sequenceWrite() { return this.ctx.storage.sql.exec("UPDATE sqlite_sequence SET seq = 9007199254740993 WHERE name = 'goose_db_version'").toArray(); }
  installClock() { this.ctx.storage.sql.exec('CREATE TABLE mapi_revision_clock (id INTEGER PRIMARY KEY CHECK (id = 1), stamp INTEGER NOT NULL)'); this.ctx.storage.sql.exec('INSERT INTO mapi_revision_clock VALUES (1, 9007199254740993)'); }
  clearClocks() { this.ctx.storage.sql.exec('DROP TABLE IF EXISTS mapi_revision_scopes'); this.ctx.storage.sql.exec('DROP TABLE IF EXISTS mapi_revision_clock'); }
  installScopes(projectId) { this.ctx.storage.sql.exec('CREATE TABLE mapi_revision_scopes (scope TEXT PRIMARY KEY, stamp INTEGER NOT NULL)'); this.ctx.storage.sql.exec('INSERT INTO mapi_revision_scopes VALUES (?, 9007199254740993), (?, 9007199254740992), (?, 4), (?, 3), (?, 2)', JSON.stringify({ v: 1, kind: 'user-password', args: [projectId, 'user_deleted'] }), JSON.stringify({ v: 1, kind: 'team-update', args: [projectId, 'team_deleted'] }), JSON.stringify({ v: 1, kind: 'project-create', args: null }), JSON.stringify({ v: 1, kind: 'json-schema', args: [projectId, null] }), JSON.stringify({ v: 1, kind: 'event', args: [projectId, projectId] })); }
  addCanonicalScopes(projectId) { for (const scope of canonicalScopeVectors(projectId)) this.ctx.storage.sql.exec('INSERT INTO mapi_revision_scopes VALUES (?, 1)', scope); }
  mutate(table) { this.ctx.storage.sql.exec(`DELETE FROM ${quote(table)}`); }
}

export default {
  async fetch(_request, env) {
    try {
      const origin = 'https://manifest.example';
      const registry = env.PROJECT_REGISTRY.getByName('projects');
      const source = env.PROJECT.getByName('source');
      let target = env.PROJECT.getByName('target');
      await registry.reserve(origin, 'source');
      const projectId = (await source.provision('Manifest project', origin, { projectId: null, origin, objectName: 'source', generation: 1 })).projectId;
      await registry.activate(origin, 'source', projectId);
      const route = { projectId, origin, objectName: 'source', generation: 1 };
      await source.addUser('manifest@example.test', 'Manifest-password-123!', route);
      await source.installIssuer(projectId, true);
      await source.clearClocks();
      await source.installClock();
      await source.installScopes(projectId);
      await source.addCanonicalScopes(projectId);
      await source.arm(route, 'move');
      await source.sequenceWrite();
      const manifest = await source.source(route, 'move');
      check(manifest.tables.length === 85, `Unexpected table count ${manifest.tables.length}`);
      check(manifest.sequences[0][1].integer === '9007199254740993', 'Source sequence lost precision');
      await reject(() => source.source({ ...route, generation: 2 }, 'move'), 'Source is not frozen');
      const destinationRoute = { ...route, objectName: 'target', generation: 2 };
      const invalidTarget = env.PROJECT.getByName('invalid-target');
      const invalidRoute = { ...destinationRoute, objectName: 'invalid-target' };
      await invalidTarget.reserve(invalidRoute, 'move');
      await invalidTarget.changeReference();
      await reject(() => invalidTarget.prepare(manifest, invalidRoute), 'Destination reference rows differ');
      check(await invalidTarget.reference() === 'changed', 'Rejected preparation changed reference data');
      await target.reserve(destinationRoute, 'move');
      await reject(() => target.prepare(manifest, { ...destinationRoute, generation: 3 }), 'Invalid destination route');
      await target.prepare(manifest, destinationRoute);
      await target.prepare(manifest, destinationRoute);
      await reject(() => target.prepare({ ...manifest, recoveryEpoch: 'conflicting' }, destinationRoute), 'Conflicting destination preparation');
      await source.exportBegin(route, 'move', manifest.tables);
      await target.importBegin(route, 'move', 'target', manifest.tables);
      for (;;) {
        const status = await target.checkpoint(projectId);
        if (status.done) break;
        const chunk = await source.chunk(route, 'move', status.next_chunk);
        await target.receive(projectId, chunk);
        if (status.next_chunk === 0) {
          await target.prepare(manifest, destinationRoute);
          try { await target.evict(); throw Error('Expected eviction'); } catch (error) { if (String(error).includes('Expected eviction')) throw error; }
          target = env.PROJECT.getByName('target');
          await target.prepare(manifest, destinationRoute);
          await target.receive(projectId, chunk);
        }
      }
      await reject(() => target.destination(manifest), 'Destination metadata differs');
      await target.restoreMetadata(manifest);
      await target.restoreMetadata(manifest);
      const destination = await target.destination(manifest);
      check((await target.sequence()).rows[0][1].integer === '9007199254740993', 'Destination sequence lost precision');
      check(destination.projectId === projectId && destination.origin === origin, 'Destination identity mismatch');
      let pages = 0;
      for (const table of manifest.tables) {
        let cursor = null;
        for (;;) {
          const left = await source.digest(manifest, 'source', table, cursor);
          const right = await target.digest(manifest, 'destination', table, cursor);
          check(JSON.stringify(left) === JSON.stringify(right), `Digest differs for ${table}`);
          pages++;
          if (left.done) break;
          cursor = left.cursor;
        }
      }
      const other = env.PROJECT.getByName('other');
      await registry.reserve('https://other.example', 'other');
      await other.provision('Other project', 'https://other.example', { projectId: null, origin: 'https://other.example', objectName: 'other', generation: 1 });
      const otherId = await other.identity();
      await registry.activate('https://other.example', 'other', otherId);
      const otherRoute = { projectId: otherId, origin: 'https://other.example', objectName: 'other', generation: 1 };
      await other.arm(otherRoute, 'other-move');
      await other.corrupt('foreign', otherId);
      await reject(() => other.source(otherRoute, 'other-move'), 'Foreign or global row');
      for (const [kind, message] of [
        ['unknown', 'Unreviewed schema object'], ['hidden', 'Unreviewed schema object'], ['sqlite-prefix', 'Unreviewed schema object'],
        ['schema', 'Unreviewed schema object'], ['principal', 'Unresolved or unsupported assignment'],
        ['global', 'Foreign or global row'], ['origin', 'Project origin differs'],
        ['issuer-foreign', 'Foreign or global row'], ['issuer-index', 'Missing issuer index'],
        ['issuer-schema', 'Issuer schema differs'], ['issuer-prompt', 'Unresolved FAPI prompt'],
        ['clock-empty', 'Invalid revision clock'], ['clock-text', 'Invalid revision clock'], ['clock-multiple', 'Invalid revision clock'],
        ['scope-empty', 'revision scope'], ['scope-text', 'revision scope'], ['scope-ahead', 'Revision clock is below a scope'],
        ['scope-none', 'revision scope'], ['clock-only', 'Revision clock tables must coexist'], ['scope-only', 'Revision clock tables must coexist'],
        ['scope-foreign', 'revision scope'], ['scope-event-foreign', 'revision scope'], ['scope-unknown', 'revision scope'], ['scope-arity', 'revision scope'], ['scope-duplicate', 'revision scope'],
        ...noncanonicalScopeVectors('proj_ref').map((_, index) => [`scope-noncanonical-${index}`, 'revision scope']),
      ]) {
        const object = env.PROJECT.getByName(`case-${kind}`);
        const caseOrigin = `https://${kind}.example`;
        await registry.reserve(caseOrigin, `case-${kind}`);
        const caseId = (await object.provision('Invalid case', caseOrigin, { projectId: null, origin: caseOrigin, objectName: `case-${kind}`, generation: 1 })).projectId;
        await registry.activate(caseOrigin, `case-${kind}`, caseId);
        const caseRoute = { projectId: caseId, origin: caseOrigin, objectName: `case-${kind}`, generation: 1 };
        await object.clearClocks();
        if (kind.startsWith('issuer-')) await object.installIssuer(caseId, true);
        if (kind.startsWith('clock-')) await object.installClock();
        if (kind.startsWith('scope-')) { if (kind !== 'scope-only') await object.installClock(); await object.installScopes(caseId); }
        await object.arm(caseRoute, 'case-move');
        await object.corrupt(kind, caseId);
        await reject(() => object.source(caseRoute, 'case-move'), message);
      }
      await target.mutate('events');
      const left = await source.digest(manifest, 'source', 'events', null);
      const right = await target.digest(manifest, 'destination', 'events', null);
      check(left.digest !== right.digest || left.count !== right.count, 'Missing audit rows were not detected');
      await source.installRealDigestFixtures();
      const realManifest = { version: 1, ...route, moveId: 'move', tables: ['test_real_infinity', 'test_real_null'] };
      await reject(() => source.digest(realManifest, 'source', 'test_real_infinity', null), 'Non-finite REAL');
      await reject(() => source.digest(realManifest, 'source', 'test_real_infinity', [{ integer: '1' }]), 'Non-finite REAL');
      check((await source.digest(realManifest, 'source', 'test_real_null', null)).count === 1, 'SQL NULL digest was rejected');
      return Response.json({ ok: true, tables: manifest.tables.length, pages });
    } catch (error) { return Response.json({ error: String(error), stack: error?.stack }, { status: 500 }); }
  },
};
