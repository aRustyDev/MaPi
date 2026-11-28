import { syntheticHistoricalFreeze } from './synthetic-historical-freeze.mjs';
// Local-only rehearsal. Control methods trust bindings in this isolated harness.
import { RelocationCoordinator } from "../worker/relocation-coordinator.js";
import { NextgenApplication } from "../worker/app.js";
import { ProjectRegistry, validateReconciliationPage } from "../worker/registry.js";
import { beginRegistryMove, commitRegistryMove } from "../worker/registry-move.js";
import { RELOCATION_RECONCILIATION_VERSION } from "../worker/relocation-values.js";
import { initializeOwnerFence } from "../worker/owner-fence.js";
import { projectFenceStatus } from "../worker/relocation.js";
import { execute } from "../worker/sql.js";
import { inspectRelocationDestination } from "../worker/relocation-manifest.js";
import { assertNoTextPreflightMarkerAccess } from "../worker/relocation-text-marker.js";
import { chunkImportStatus } from '../worker/relocation-chunks.js';
const quote = (s) => `"${s.replaceAll('"', '""')}"`;
const check = (condition, message) => { if (!condition) throw Error(message); };
const rejects = async (fn) => { try { await fn(); } catch { return; } throw Error("Expected rejection"); };
const rejectsWith = async (fn, message) => { try { await fn(); } catch (error) { if (String(error).includes(message)) return; throw error; } throw Error(`Expected rejection: ${message}`); };
export class RealRegistry extends ProjectRegistry {
  seedExistingIntentForTest(origin, projectId, moveId) {
    if (this.env.MAPI_LOCAL_TEST !== '1') throw Error('Local relocation test required');
    const route = this.resolve(origin);
    if (!route || route.state !== 'active' || route.project_id !== projectId) throw Error('Invalid synthetic route');
    this.ctx.storage.sql.exec('INSERT INTO mapi_move_intents VALUES (?, ?, ?, ?, ?, ?)', projectId, moveId, origin, route.object_name, `project:${crypto.randomUUID()}`, route.generation);
  }
  begin(project, source, target, generation, move) { return beginRegistryMove(this.ctx.storage, project, source, target, generation, move); }
  move(project) { return this.ctx.storage.sql.exec("SELECT * FROM mapi_route_moves WHERE project_id = ?", project).toArray()[0] ?? null; }
  history(project) { return this.ctx.storage.sql.exec("SELECT move_id, source_object, destination_object, generation FROM mapi_move_history WHERE project_id = ? ORDER BY generation", project).toArray(); }
  journalVersion(project, version) { this.ctx.storage.sql.exec('UPDATE mapi_move_reconciliation SET journal_version = ? WHERE project_id = ?', version, project); }
  corruptJournal(project, field, kind) {
    if (!['cursor', 'tables'].includes(field)) throw Error('Invalid fixture');
    const sql = this.ctx.storage.sql, expr = kind === 'invalid-utf8' ? "CAST(X'80' AS TEXT)" : '?';
    const value = kind === 'oversized' ? 'x'.repeat(150000) : '{synthetic_private_sentinel';
    sql.exec(`UPDATE mapi_move_reconciliation SET ${field} = ${expr} WHERE project_id = ?`, ...(kind === 'invalid-utf8' ? [project] : [value, project]));
  }
  restoreJournal(project, value) { this.ctx.storage.sql.exec('UPDATE mapi_move_reconciliation SET tables = ?, cursor = ? WHERE project_id = ?', value.tables, value.cursor, project); }
  journalFingerprint(project) { return this.ctx.storage.sql.exec("SELECT typeof(tables) AS tables_type, length(CAST(tables AS BLOB)) AS tables_size, hex(substr(CAST(tables AS BLOB),1,32)) AS tables_head, typeof(cursor) AS cursor_type, length(CAST(cursor AS BLOB)) AS cursor_size, hex(substr(CAST(cursor AS BLOB),1,32)) AS cursor_head, table_index, journal_version FROM mapi_move_reconciliation WHERE project_id = ?", project).one(); }
  evidenceCursor(project) { return this.ctx.storage.sql.exec('SELECT cursor_in FROM mapi_move_evidence WHERE project_id = ? ORDER BY rowid LIMIT 1', project).one().cursor_in; }
  evidenceNextCursor(project) { return this.ctx.storage.sql.exec('SELECT cursor_out FROM mapi_move_evidence WHERE project_id = ? ORDER BY rowid LIMIT 1', project).one().cursor_out; }
  setEvidenceNextCursor(project, value) { this.ctx.storage.sql.exec('UPDATE mapi_move_evidence SET cursor_out = ? WHERE rowid = (SELECT rowid FROM mapi_move_evidence WHERE project_id = ? ORDER BY rowid LIMIT 1)', value, project); }
  corruptEvidenceCursor(project, kind) {
    const expr = kind === 'invalid-utf8' ? "CAST(X'80' AS TEXT)" : '?';
    const value = kind === 'oversized' ? 'x'.repeat(150000) : '{synthetic_private_sentinel';
    this.ctx.storage.sql.exec(`UPDATE mapi_move_evidence SET cursor_in = ${expr} WHERE rowid = (SELECT rowid FROM mapi_move_evidence WHERE project_id = ? ORDER BY rowid LIMIT 1)`, ...(kind === 'invalid-utf8' ? [project] : [value, project]));
  }
  restoreEvidenceCursor(project, value) { this.ctx.storage.sql.exec('UPDATE mapi_move_evidence SET cursor_in = ? WHERE rowid = (SELECT rowid FROM mapi_move_evidence WHERE project_id = ? ORDER BY rowid LIMIT 1)', value, project); }
  journal(project) { return this.ctx.storage.sql.exec('SELECT * FROM mapi_move_reconciliation WHERE project_id = ?', project).toArray()[0] ?? null; }
  evidenceCount(project) { return this.ctx.storage.sql.exec('SELECT count(*) AS n FROM mapi_move_evidence WHERE project_id = ?', project).one().n; }
  historyVerification(project, move) { return this.ctx.storage.sql.exec('SELECT total_chunks, next_index, chain, final_digest, complete FROM mapi_move_history_verification WHERE project_id = ? AND move_id = ?', project, move).toArray()[0] ?? null; }
  // Create a historical committed fixture only after the real archive gate
  // has refused this otherwise reconciled, disposable relocation.
  async seedCommittedMoveForTest(secret, project, moveId) {
    if (this.env.MAPI_LOCAL_TEST !== "1") throw Error("Local relocation test required");
    await rejectsWith(() => super.commitRelocation(secret, project, moveId), "independent archive proof is not configured");
    const { source, destination } = await this.relocationProofs(secret, project, moveId);
    return commitRegistryMove(this.ctx.storage, project, source.generation, moveId, source, destination);
  }
  evict() { this.ctx.abort("registry restart"); }
}
export class RealOwner extends NextgenApplication {
  preFreezeRelocation(secret, route, moveId, marker) { return syntheticHistoricalFreeze(this, () => super.preFreezeRelocation(secret, route, moveId, marker), route, moveId, marker); }
  preFreezeProductionForTest(secret, route, moveId, marker) { return super.preFreezeRelocation(secret, route, moveId, marker); }
  setFenceStateForTest(state, moveId) {
    if (this.env.MAPI_LOCAL_TEST !== '1' || !['active', 'frozen'].includes(state)) throw Error('Local relocation test required');
    this.ctx.storage.sql.exec('UPDATE mapi_owner_fence SET state = ?, move_id = ? WHERE singleton = 1', state, state === 'frozen' ? moveId : null);
  }

  #legacyDigestForTest = false;
  #malformedPageForTest = null;
  #heldRestore;
  #releaseRestore;
  #holdExport = false;
  #heldExport = false;
  #releaseExport;
  legacyDigestForTest(value) { this.#legacyDigestForTest = value; }
  malformedPageForTest(value) { this.#malformedPageForTest = value; }
  async relocationReconcile(...args) {
    const result = await super.relocationReconcile(...args);
    if (this.#legacyDigestForTest) { const { guardVersion, ...legacy } = result; return legacy; }
    if (this.#malformedPageForTest) return { ...result, ...this.#malformedPageForTest };
    return result;
  }
  constructor(ctx, env) {
    const hasMetadata = ctx.storage.sql.exec("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='mapi_relocation_project'").toArray().length;
    const importing = hasMetadata && ctx.storage.sql.exec("SELECT 1 FROM mapi_relocation_project WHERE state IN ('importing','staged')").toArray().length;
    const hasEpoch = ctx.storage.sql.exec("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='mapi_recovery_epoch'").toArray().length;
    const epoch = hasEpoch ? ctx.storage.sql.exec('SELECT epoch FROM mapi_recovery_epoch').toArray()[0]?.epoch : null;
    const scoped = epoch === 'synthetic-current' || epoch === 'synthetic-stale';
    const objectId = ctx.id.toString();
    super(ctx, { ...env, ...(importing ? { MAPI_SCHEMA_TARGET: '2' } : {}), ...(scoped ? { MAPI_RECOVERY_TARGET_OBJECT: objectId, MAPI_RECOVERY_OBJECT_EPOCHS: JSON.stringify({ [objectId]: 'synthetic-current' }), MAPI_RECOVERY_EPOCH: 'synthetic-current' } : {}) });
  }
  setStoredEpochForTest(epoch) {
    if (this.env.MAPI_LOCAL_TEST !== '1' || !['synthetic-current', 'synthetic-stale'].includes(epoch)) throw Error('Invalid synthetic epoch');
    this.ctx.storage.sql.exec('UPDATE mapi_recovery_epoch SET epoch = ?', epoch);
  }
  holdNextExportForTest() { if (this.env.MAPI_LOCAL_TEST !== '1') throw Error('Local testing required'); this.#holdExport = true; }
  exportHeldForTest() { return this.#heldExport; }
  releaseExportForTest() { if (!this.#releaseExport) throw Error('Export is not held'); this.#releaseExport(); this.#releaseExport = undefined; }
  async exportRelocationChunk(...args) {
    const chunk = await super.exportRelocationChunk(...args);
    if (this.#holdExport) { this.#holdExport = false; this.#heldExport = true; await new Promise(resolve => { this.#releaseExport = resolve; }); this.#heldExport = false; }
    return chunk;
  }
  rawImportStateForTest(projectId) { return { checkpoint: chunkImportStatus(this.ctx.storage, projectId), counts: this.testCounts(), history: this.ctx.storage.sql.exec('SELECT COUNT(*) AS n FROM mapi_chunk_import_data WHERE project_id = ?', projectId).one().n }; }
  schemaVersion() { return this.ctx.storage.sql.exec("SELECT version FROM mapi_schema_version").one().version; }
  async holdRestoreForTest(bookmark) {
    if (this.#heldRestore) throw Error("Restore already held");
    this.#heldRestore = true;
    await new Promise(resolve => { this.#releaseRestore = resolve; });
    return super.restore(bookmark);
  }
  restoreHeldForTest() { return !!this.#heldRestore; }
  releaseRestoreForTest() { if (!this.#releaseRestore) throw Error("Restore is not held"); this.#releaseRestore(); }
  caseSensitiveLike() { return this.ctx.storage.sql.exec("SELECT 'a' LIKE 'A' AS matches").one().matches === 0; }
  async arm(route) { initializeOwnerFence(this.ctx.storage, route); await this.ctx.storage.sync(); }
  inspectDestination(manifest) { return inspectRelocationDestination(this.ctx.storage, manifest); }
  manifest() {
    const sql = this.ctx.storage.sql;
    const names = sql.exec("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'mapi_%' AND substr(name, 1, 2) <> '__' ORDER BY name").toArray().map(row => row.name);
    const pending = new Set(names), ordered = [];
    while (pending.size) {
      let progressed = false;
      for (const name of [...pending]) {
        const dependencies = sql.exec(`PRAGMA foreign_key_list(${quote(name)})`).toArray().map(row => row.table).filter(dep => dep !== name);
        if (dependencies.some(dep => pending.has(dep))) continue;
        if (dependencies.some(dep => !names.includes(dep))) throw Error(`Unknown dependency for ${name}`);
        if (!sql.exec(`PRAGMA table_xinfo(${quote(name)})`).toArray().some(column => column.pk > 0)) throw Error(`Missing primary key on ${name}`);
        ordered.push(name); pending.delete(name); progressed = true;
      }
      if (!progressed) throw Error("Cyclic table dependencies require a different import design");
    }
    const clockTables = sql.exec("SELECT name FROM sqlite_schema WHERE type = 'table' AND name IN ('mapi_revision_clock', 'mapi_revision_scopes') ORDER BY name").toArray().map(row => row.name);
    if (clockTables.length !== 2) throw Error("Real project did not initialize both revision clock tables");
    return ["mapi_project", "mapi_login_limits", ...clockTables, ...ordered];
  }
  sourceStatus() { return this.ctx.storage.sql.exec("SELECT project_id, object_name, generation, state, move_id, digest FROM mapi_owner_fence WHERE singleton=1").one(); }
  sourceFenceRows() {
    if (!this.ctx.storage.sql.exec("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='mapi_owner_fence'").toArray().length) return [];
    return this.ctx.storage.sql.exec('SELECT * FROM mapi_owner_fence').toArray();
  }
  seedAdmissionFixture(projectId, userId) {
    this.ctx.storage.sql.exec("INSERT INTO user_attributes (project_id, user_id, key, value) VALUES (?, ?, 'admission-fixture', ?)", projectId, userId, JSON.stringify('synthetic-é😀'));
  }
  admissionFixture(projectId, userId) {
    return this.ctx.storage.sql.exec("SELECT typeof(value) AS kind, hex(CAST(value AS BLOB)) AS bytes FROM user_attributes WHERE project_id = ? AND user_id = ? AND key = 'admission-fixture'", projectId, userId).one();
  }
  stagedStatus(project) { return projectFenceStatus(this.ctx.storage, project); }
  savedOrigin() { return this.ctx.storage.sql.exec("SELECT origin FROM mapi_project_origin").one().origin; }
  async evidence(tables) {
    const checks = [];
    for (const table of tables) {
      const cols = this.ctx.storage.sql.exec(`PRAGMA table_xinfo(${quote(table)})`).toArray();
      const names = cols.filter(col => col.hidden === 0).map(col => col.name);
      const keys = cols.filter(col => col.pk > 0).sort((a, b) => a.pk - b.pk).map(col => col.name);
      const result = execute(this.ctx.storage, { statement: `SELECT ${names.map(quote).join(",")} FROM ${quote(table)} ORDER BY ${keys.map(quote).join(",")}`, args: [], query: true });
      const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(result))));
      checks.push({ table, count: result.rows.length, digest: [...hash].map(byte => byte.toString(16).padStart(2, "0")).join("") });
    }
    return { checks, origin: this.savedOrigin(), schema: this.ctx.storage.sql.exec("SELECT version FROM mapi_schema_version").one().version, epoch: this.ctx.storage.sql.exec("SELECT epoch FROM mapi_recovery_epoch").one().epoch, foreignKeys: this.ctx.storage.sql.exec("PRAGMA foreign_key_check").toArray().length };
  }

}
export class RealCoordinator extends RelocationCoordinator {
  evict() { this.ctx.abort("coordinator restart"); }
  async resume(secret, origin, projectId, sourceName, targetName, moveId, failAt) {
    if (secret !== this.env.COORDINATOR_SECRET) throw Error("Coordinator denied");
    const registry = this.env.REGISTRY.getByName("projects"), source = this.env.OWNER.getByName(sourceName), target = this.env.OWNER.getByName(targetName);
    const oldRoute = { projectId, origin, objectName: sourceName, generation: 1 };
    let move = await registry.move(projectId);
    if (!move) move = await registry.begin(projectId, sourceName, targetName, 1, moveId);
    check(move.move_id === moveId && move.source_object === sourceName && move.destination_object === targetName, "Move conflict");
    if (move.phase === "moving") {
      await source.armRelocation("move-secret", projectId, moveId);
      await source.freezeRelocation("move-secret", oldRoute, moveId);
      if (failAt === "frozen") throw Error("Injected interruption after freeze");
      const manifest = await source.relocationManifest("move-secret", projectId, moveId), tables = manifest.tables;
      await target.reserveMoveDestination("move-secret", { ...oldRoute, objectName: targetName, generation: 2 }, moveId);
      await target.prepareRelocation("move-secret", projectId, moveId);
      await source.beginRelocationExport("move-secret", projectId, moveId);
      await target.beginRelocationImport("move-secret", projectId, moveId);
      for (;;) {
        const checkpoint = await target.relocationImportStatus("move-secret", projectId, moveId);
        if (checkpoint.done) break;
        await target.importRelocationChunk("move-secret", projectId, moveId, checkpoint.next_chunk);
        if (failAt === "chunk") throw Error("Injected interruption after chunk");
      }
      await target.restoreRelocationMetadata("move-secret", projectId, moveId);
      await target.inspectDestination(manifest);
      for (;;) {
        const progress = await registry.reconcileRelocation("move-secret", projectId, moveId);
        if (failAt === "reconcile") throw Error("Injected interruption after reconciliation page");
        if (progress.done) break;
      }
      await registry.seedCommittedMoveForTest("move-secret", projectId, moveId);
      if (failAt === "committed") throw Error("Injected interruption after registry commit");
    }
    const route = await registry.resolve(origin);
    check(route?.state === "active" && route.project_id === projectId && route.object_name === targetName && route.generation === 2, "Registry route mismatch");
    const newRoute = { projectId, origin, objectName: targetName, generation: 2 };
    await target.activateRelocation("move-secret", projectId, moveId);
    if (failAt === "activated") throw Error("Injected interruption after destination activation");
    await source.retireRelocation("move-secret", projectId, moveId);
    return newRoute;
  }
}
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (env.MAPI_LOCAL_TEST !== "1" || url.protocol !== "http:" || url.hostname !== "127.0.0.1") return new Response(null, { status: 404 });
    try {
      for (const statement of [
        "CREATE VIEW 'mapi_relocation_text_preflight_marker' AS SELECT '0123456789abcdef0123456789abcdef' AS token",
        "UPDATE users SET name='synthetic'; CREATE VIEW 'mapi_relocation_text_preflight_marker' AS SELECT '0123456789abcdef0123456789abcdef' AS token",
        'DROP VIEW "MAPI_RELOCATION_TEXT_PREFLIGHT_MARKER"',
        "DELETE FROM 'mapi_relocation_text_preflight_seal'",
      ]) {
        let denied = false;
        try { assertNoTextPreflightMarkerAccess(statement); } catch { denied = true; }
        check(denied, 'Reserved preflight object was accessible through SQL');
      }
      const page = (count, cursor, done) => ({ guardVersion: RELOCATION_RECONCILIATION_VERSION, count, cursor, done, digest: 'a'.repeat(64) });
      validateReconciliationPage(page(0, null, true), null);
      validateReconciliationPage(page(0, [{ integer: '-9223372036854775808' }], true), [{ integer: '-9223372036854775808' }]);
      validateReconciliationPage(page(64, [{ integer: '9223372036854775807' }, { blob: 'AAE=' }, { blob: 'AA==' }, { blob: '' }, 'key', 1.5], false), null);
      for (const blob of ['AB==', 'AAF=', 'AA=', 'AA-_', 'AA==\n']) {
        let rejected = false;
        try { validateReconciliationPage(page(1, [{ blob }], true), null); } catch { rejected = true; }
        check(rejected, 'Noncanonical blob key was accepted');
      }
      const largeBlob = 'A'.repeat(8_388_608);
      let largeKeyRejected = false;
      try { validateReconciliationPage(page(1, [{ blob: largeBlob }], true), null); } catch { largeKeyRejected = true; }
      check(largeKeyRejected, 'Oversized blob key was accepted');
      let largeCorruptionRejected = false;
      try { validateReconciliationPage(page(1, [{ blob: largeBlob.slice(0, -2) + '!A' }], true), null); } catch { largeCorruptionRejected = true; }
      check(largeCorruptionRejected, 'Late corruption in large blob key was accepted');
      let registry = env.REGISTRY.getByName("projects");
      const origin = "https://project.example", otherOrigin = "https://other.example";
      let source = env.OWNER.getByName("source"), target = env.OWNER.getByName("target");
      const other = env.OWNER.getByName("other"); let coordinator = env.COORDINATOR.getByName("coordinator");
      await registry.reserve(origin, "source"); await registry.reserve(otherOrigin, "other");
      const projectId = (await source.provision("Real source", origin, { projectId: null, origin, objectName: "source", generation: 1 })).projectId;
      const otherProject = (await other.provision("Real other", otherOrigin, { projectId: null, origin: otherOrigin, objectName: "other", generation: 1 })).projectId;
      await registry.activate(origin, "source", projectId); await registry.activate(otherOrigin, "other", otherProject);
      const route = { projectId, origin, objectName: "source", generation: 1 }, otherRoute = { projectId: otherProject, origin: otherOrigin, objectName: "other", generation: 1 };
      const user = await source.addUser("source@example.test", "Example-password-123!", route);
      await other.addUser("other@example.test", "Other-password-123!", otherRoute);
      await other.arm(otherRoute);
      let reservedRoute = { ...route, objectName: "target", generation: 2 };
      const beforeRejectedFreeze = await source.status(false, route);
      check(beforeRejectedFreeze.wasmMemoryBytes > 0, 'Source reactor was not initialized');
      await rejectsWith(() => source.freezeRelocation("wrong", route, "move-1"), "Relocation control denied");
      await rejectsWith(() => source.freezeRelocation("move-secret", route, "move-1"), "Source move is not reserved by registry");
      const afterRejectedFreeze = await source.status(false, route);
      check(afterRejectedFreeze.wasmMemoryBytes === beforeRejectedFreeze.wasmMemoryBytes && afterRejectedFreeze.reactorInitializations === beforeRejectedFreeze.reactorInitializations, 'Rejected freeze changed the source reactor');
      await rejectsWith(() => target.reserveMoveDestination("wrong", reservedRoute, "move-1"), "Relocation control denied");
      await rejectsWith(() => target.reserveMoveDestination("move-secret", reservedRoute, "move-1"), "Destination is not reserved by registry");
      const login = await source.login("source@example.test", "Example-password-123!", "192.0.2.1", route);
      check(login.status === 200 && login.cookie, "Source login failed");
      // Simulate an independently deployed object-specific epoch after real
      // Go/Wasm setup. The configured value is fixed across the next restart.
      await source.setStoredEpochForTest('synthetic-current');
      await rejects(() => source.evict()); source = env.OWNER.getByName('source');
      const liveRuntime = await source.status(true, route);
      check(liveRuntime.ready && liveRuntime.wasmMemoryBytes > 0 && liveRuntime.reactorInitializations > 0 && liveRuntime.reactorAttempts >= liveRuntime.reactorInitializations, 'Active Go/Wasm reactor was not initialized');
      await source.seedAdmissionFixture(projectId, user.userId);
      const sourceCounts = await source.testCounts(), tables = await source.manifest();
      const fixtureBeforeAdmission = await source.admissionFixture(projectId, user.userId);
      const routeBeforeAdmission = await registry.relocationStatus('move-secret', projectId);
      const fenceBeforeAdmission = await source.sourceFenceRows();
      await rejectsWith(() => registry.beginRelocation('move-secret', origin, projectId, 'move-1'), 'Relocation admission unavailable');
      await rejectsWith(() => coordinator.advance('move-secret', origin, projectId, 'move-1'), 'Relocation admission unavailable');
      check(JSON.stringify(await registry.relocationStatus('move-secret', projectId)) === JSON.stringify(routeBeforeAdmission), 'Rejected admission changed route or intent');
      check(JSON.stringify(await source.sourceFenceRows()) === JSON.stringify(fenceBeforeAdmission), 'Rejected admission changed owner fence');
      check(JSON.stringify(await source.testCounts()) === JSON.stringify(sourceCounts), 'Rejected admission changed application data');
      check(JSON.stringify(await source.admissionFixture(projectId, user.userId)) === JSON.stringify(fixtureBeforeAdmission), 'Rejected admission changed synthetic value');
      // The remaining end-to-end rehearsal covers a pre-existing intent, as
      // would be present after deployment interrupted an earlier attempt.
      await registry.seedExistingIntentForTest(origin, projectId, 'move-1');
      await rejectsWith(() => registry.beginRelocation('move-secret', origin, projectId, 'different-move'), 'Conflicting relocation intent');
      // A pre-existing intent may predate today's closed admission gate.
      // Complete its preflight without yet using the historical-freeze fixture.
      let priorCheckpoint;
      for (let page = 0; page < 4096; page++) {
        priorCheckpoint = await registry.relocationTextPreflightStatus('move-secret', projectId, 'move-1');
        if (priorCheckpoint?.done) break;
        const progress = await registry.beginRelocation('move-secret', origin, projectId, 'move-1');
        check(progress.phase === 'preflighting', 'Existing intent froze before preflight completed');
      }
      check(priorCheckpoint?.done, 'Existing intent preflight did not complete');
      const priorRoute = await registry.relocationStatus('move-secret', projectId), priorFence = await source.sourceFenceRows();
      await rejectsWith(() => source.preFreezeProductionForTest('move-secret', route, 'move-1', priorCheckpoint.marker), 'Relocation admission unavailable');
      check(JSON.stringify(await registry.relocationStatus('move-secret', projectId)) === JSON.stringify(priorRoute) &&
        JSON.stringify(await source.sourceFenceRows()) === JSON.stringify(priorFence) &&
        JSON.stringify(await source.admissionFixture(projectId, user.userId)) === JSON.stringify(fixtureBeforeAdmission), 'Rejected old intent changed source state');
      const restoreAttempt = source.holdRestoreForTest("old-bookmark").then(() => false, error => String(error).includes("Coordinated recovery is required"));
      while (!await source.restoreHeldForTest()) await new Promise(resolve => setTimeout(resolve, 0));
      let move;
      for (let page = 0; page < 4096; page++) {
        move = await registry.beginRelocation("move-secret", origin, projectId, "move-1");
        if (move.phase !== "preflighting") break;
      }
      check(move?.phase === "moving", "Bounded preflight did not finish");
      // Simulate an old/restored active fence while the registry still says
      // moving. A direct freeze RPC must leave the active source untouched.
      await source.setFenceStateForTest('active', 'move-1');
      const restoredActiveFence = await source.sourceFenceRows(), restoredActiveData = await source.admissionFixture(projectId, user.userId);
      await rejectsWith(() => source.freezeRelocation('move-secret', route, 'move-1'), 'Relocation admission unavailable');
      check(JSON.stringify(await source.sourceFenceRows()) === JSON.stringify(restoredActiveFence) &&
        JSON.stringify(await source.admissionFixture(projectId, user.userId)) === JSON.stringify(restoredActiveData), 'Direct freeze changed restored active source');
      await source.setFenceStateForTest('frozen', 'move-1');
      const frozenRuntime = await source.status(true, route);
      check(frozenRuntime.wasmHighWaterBytes >= beforeRejectedFreeze.wasmMemoryBytes, 'Frozen source lost its Wasm high-water observation');
      check(!frozenRuntime.ready && !frozenRuntime.fenceReady && frozenRuntime.wasmMemoryBytes === 0 && frozenRuntime.reactorInitializations === liveRuntime.reactorInitializations && frozenRuntime.reactorAttempts === liveRuntime.reactorAttempts, 'Frozen source retained or recreated its Go/Wasm reactor');
      const staleRequest = await source.handleRequest({ method: 'GET', url: `${origin}/readyz`, headers: {}, body: '', peer: '192.0.2.9' }, route);
      check(staleRequest.status === 503, 'Frozen source accepted stale ingress');
      await rejects(() => source.addUser('frozen-stale@example.test', 'Stale-password-123!', route));
      const afterStale = await source.status(true, route);
      check(afterStale.wasmMemoryBytes === 0 && afterStale.reactorInitializations === frozenRuntime.reactorInitializations && afterStale.reactorAttempts === frozenRuntime.reactorAttempts, 'Stale ingress attempted to recreate the frozen Go/Wasm reactor');
      await source.freezeRelocation('move-secret', route, 'move-1');
      const afterFreezeRetry = await source.status(true, route);
      check(afterFreezeRetry.wasmMemoryBytes === 0 && afterFreezeRetry.reactorInitializations === frozenRuntime.reactorInitializations && afterFreezeRetry.reactorAttempts === frozenRuntime.reactorAttempts, 'Idempotent freeze retry attempted to recreate the reactor');
      const targetName = move.destination_object;
      target = env.OWNER.getByName(targetName);
      reservedRoute = { ...route, objectName: targetName, generation: 2 };
      const movingRouteBeforeRecovery = await registry.resolve(origin), movingFenceBeforeRecovery = await source.sourceStatus();
      await rejectsWith(() => registry.beginProjectRecovery("move-secret", origin, projectId, "recovery-while-moving", "era-while-moving"), "Project route is not active");
      check(JSON.stringify(await registry.resolve(origin)) === JSON.stringify(movingRouteBeforeRecovery), "Recovery attempt changed the moving route");
      check(JSON.stringify(await source.sourceStatus()) === JSON.stringify(movingFenceBeforeRecovery), "Recovery attempt changed the frozen source");
      check((await registry.resolve(otherOrigin)).state === 'active', "Recovery attempt affected the other project");
      await source.releaseRestoreForTest();
      check(await restoreAttempt, "Held restore was admitted after move reservation");
      await rejectsWith(() => source.recover(route), "Coordinated recovery is required");
      await rejectsWith(() => registry.commitRelocation("move-secret", projectId, "move-1"), "Reconciliation is incomplete");
      await rejectsWith(() => source.armRelocation("wrong", projectId, "move-1"), "Fence adoption is not enabled");
      await rejectsWith(() => target.armRelocation("move-secret", projectId, "move-1"), "Source move is not reserved by registry");
      await source.armRelocation("move-secret", projectId, "move-1");
      await rejectsWith(() => other.freezeRelocation("move-secret", route, "move-1"), "Source object identity mismatch");
      await rejectsWith(() => other.reserveMoveDestination("move-secret", reservedRoute, "move-1"), "Destination object identity mismatch");
      await target.reserveMoveDestination("move-secret", reservedRoute, "move-1");
      await target.reserveMoveDestination("move-secret", reservedRoute, "move-1");
      await rejectsWith(() => target.reserveMoveDestination("move-secret", reservedRoute, "move-other"), "Destination is not reserved by registry");
      await rejectsWith(() => registry.relocationProofs("move-secret", projectId, "move-1"), "Relocation attestations do not match");
      await rejectsWith(() => target.addUser("premature@example.test", "Premature-password-123!", reservedRoute), "Owner import is not active");
      await rejects(() => target.evict()); target = env.OWNER.getByName(targetName);
      check(await target.caseSensitiveLike(), "Reserved destination lost case-sensitive LIKE after restart");
      await rejects(() => target.provision("Premature", origin, reservedRoute));
      await rejectsWith(() => source.reserveMoveDestination("move-secret", { ...route, generation: 2 }, "move-1"), "Destination is not reserved by registry");
      const resume = (secret, fail) => coordinator.resume(secret, origin, projectId, "source", targetName, "move-1", fail);
      await rejectsWith(() => resume("wrong", ""), "Coordinator denied"); await rejectsWith(() => resume("secret", "frozen"), "Injected interruption after freeze");
      check((await registry.resolve(origin)).state === "moving", "Moving route was exposed");
      await rejects(() => source.addUser("stale@example.test", "Stale-password-123!", route));
      await rejects(() => source.evict()); source = env.OWNER.getByName("source");
      check(await source.caseSensitiveLike(), "Frozen source lost case-sensitive LIKE after restart");
      await rejectsWith(() => source.addUser('restart-frozen@example.test', 'Synthetic-password-123!', route), 'Owner is fenced or route is stale');
      const restartedRuntime = await source.status(false, route);
      check(restartedRuntime.wasmMemoryBytes === 0 && restartedRuntime.reactorInitializations === 0, 'Frozen restart initialized the Go reactor');
      await rejectsWith(() => source.restore("old-bookmark"), "Coordinated recovery is required");
      await rejects(() => coordinator.evict()); coordinator = env.COORDINATOR.getByName("coordinator");
      const concurrent = await Promise.allSettled([resume("secret", "chunk"), other.addUser("concurrent@example.test", "Concurrent-password-123!", otherRoute)]);
      check(concurrent[0].status === "rejected" && String(concurrent[0].reason).includes("Injected interruption after chunk") && concurrent[1].status === "fulfilled", "Concurrent traffic failed");
      // Destination preparation requires its original epoch 0. Introduce the
      // separately configured synthetic epoch only after import has begun.
      await target.setStoredEpochForTest('synthetic-current');
      await rejects(() => target.evict()); target = env.OWNER.getByName(targetName);
      // In-flight source RPC reply arrives after a destination's independently
      // configured epoch no longer matches restored storage. The actual owner
      // import call must recheck it in the same transaction as its checkpoint.
      const beforeEpochRace = await target.rawImportStateForTest(projectId);
      await source.holdNextExportForTest();
      const epochRace = target.importRelocationChunk('move-secret', projectId, 'move-1', beforeEpochRace.checkpoint.next_chunk)
        .then(() => null, error => String(error));
      for (let attempt = 0; !(await source.exportHeldForTest()); attempt++) { if (attempt > 1000) throw Error('Synthetic source reply was not held'); await new Promise(resolve => setTimeout(resolve, 5)); }
      await target.setStoredEpochForTest('synthetic-stale');
      await source.releaseExportForTest();
      check((await epochRace)?.includes('Project recovery is not reconciled'), 'Stale destination epoch accepted an in-flight import');
      check(JSON.stringify(await target.rawImportStateForTest(projectId)) === JSON.stringify(beforeEpochRace), 'Stale in-flight import changed destination rows or checkpoint');
      await target.setStoredEpochForTest('synthetic-current');
      await target.importRelocationChunk('move-secret', projectId, 'move-1', beforeEpochRace.checkpoint.next_chunk);
      const targetRoute = { ...route, objectName: targetName, generation: 2 };
      await rejectsWith(() => target.addUser("premature@example.test", "Premature-password-123!", targetRoute), "Owner import is not active");
      await rejects(() => target.provision("Premature", origin, targetRoute));
      await rejectsWith(() => target.login("source@example.test", "Example-password-123!", "192.0.2.9", targetRoute), "Owner import is not active");
      await rejectsWith(() => target.session("", "read", "", targetRoute), "Owner import is not active");
      await rejectsWith(() => target.allowLogin("192.0.2.9"), "Owner import is not active");
      await rejectsWith(() => target.status(true, targetRoute), "Owner import is not active");
      await rejectsWith(() => target.handleRequest({ method: "GET", url: `${origin}/readyz`, headers: {}, body: "", peer: "192.0.2.9" }, targetRoute), "Owner import is not active");
      await rejectsWith(() => target.flowRequest({ method: "GET", url: `${origin}/api/v1/flows/flow_fake`, headers: {}, body: "", peer: "192.0.2.9" }, targetRoute), "Owner import is not active");
      await rejectsWith(() => target.oauthRequest({ method: "GET", url: `${origin}/oauth/${projectId}/jwks`, headers: {}, body: "", peer: "192.0.2.9" }, targetRoute), "Owner import is not active");
      await rejectsWith(() => target.oauthAdmin("initialize", {}, targetRoute), "Owner import is not active");
      await rejectsWith(() => target.flowRelease("status", {}, targetRoute), "Owner import is not active");
      await rejectsWith(() => target.recover(targetRoute), "Owner import is not active");
      await rejectsWith(() => target.restore("bookmark", targetRoute), "Owner import is not active");
      await rejects(() => target.evict()); target = env.OWNER.getByName(targetName);
      check(await target.caseSensitiveLike(), "Importing destination lost case-sensitive LIKE after restart");
      check(await target.schemaVersion() === 1, "Constructor migrated an importing destination");
      await rejectsWith(() => coordinator.advance("wrong", origin, projectId, "move-1"), "Relocation control denied");
      let verifiedChunks = 0;
      for (;;) {
        const progress = await coordinator.advance("move-secret", origin, projectId, "move-1");
        if (progress.phase === "reconciling") break;
        if (progress.phase === "verifying-history") {
          check(progress.nextChunk === ++verifiedChunks, "Transfer history did not advance by one chunk");
        } else {
          check(progress.phase === "importing" && verifiedChunks === 0, "Unexpected coordinator phase");
        }
      }
      const verifiedHistory = await registry.historyVerification(projectId, 'move-1');
      check(verifiedHistory?.complete === 1 && verifiedHistory.next_index === verifiedHistory.total_chunks &&
        verifiedHistory.chain === verifiedHistory.final_digest && verifiedChunks + 1 === verifiedHistory.total_chunks,
        "Coordinator did not complete transfer history verification");
      const stagedBeforeRetry = await target.stagedStatus(projectId);
      const stagedRowsBeforeRetry = await target.evidence(tables);
      check(stagedBeforeRetry?.state === 'staged', 'Destination was not staged before reservation retry');
      await target.reserveMoveDestination('move-secret', reservedRoute, 'move-1');
      await rejects(() => target.evict()); target = env.OWNER.getByName(targetName);
      await target.reserveMoveDestination('move-secret', reservedRoute, 'move-1');
      check(JSON.stringify(await target.stagedStatus(projectId)) === JSON.stringify(stagedBeforeRetry), 'Staged reservation retry changed the owner state');
      check(JSON.stringify(await target.evidence(tables)) === JSON.stringify(stagedRowsBeforeRetry), 'Staged reservation retry changed project rows');
      let checkpoint = await registry.journal(projectId);
      check(checkpoint?.journal_version === RELOCATION_RECONCILIATION_VERSION, 'Current reconciliation version missing');
      await source.legacyDigestForTest(true);
      await rejectsWith(() => registry.reconcileRelocation('move-secret', projectId, 'move-1'), 'Relocation owner guard version mismatch');
      check(JSON.stringify(await registry.journal(projectId)) === JSON.stringify(checkpoint), 'Rejected old owner changed checkpoint');
      await source.legacyDigestForTest(false);
      const originalEvidenceCount = await registry.evidenceCount(projectId);
      for (const malformed of [
        { count: -1 }, { count: 65 }, { count: 1.5 }, { done: 'true' },
        { digest: 'bad' }, { digest: 'a'.repeat(64) + '\n' }, { count: 1, cursor: null }, { count: 0, done: false },
        { count: 1, cursor: [null] }, { count: 1, cursor: [{ integer: '9223372036854775808' }] }, { count: 1, cursor: [{ integer: '1\n' }] },
        { count: 1, cursor: [{ blob: 'not base64!' }] }, { count: 1, cursor: [{ blob: 'AB==' }] },
      ]) {
        await source.malformedPageForTest(malformed); await target.malformedPageForTest(malformed);
        await rejectsWith(() => registry.reconcileRelocation('move-secret', projectId, 'move-1'), 'Invalid reconciliation page');
        check(JSON.stringify(await registry.journal(projectId)) === JSON.stringify(checkpoint), 'Rejected matching pages changed checkpoint');
        check(await registry.evidenceCount(projectId) === originalEvidenceCount, 'Rejected matching pages wrote evidence');
        check((await source.sourceStatus()).state === 'frozen' && (await target.stagedStatus(projectId)).state === 'staged', 'Rejected matching pages changed owner states');
      }
      await source.malformedPageForTest(null); await target.malformedPageForTest(null);
      await registry.reconcileRelocation('move-secret', projectId, 'move-1');
      check(await registry.evidenceCount(projectId) === originalEvidenceCount + 1, 'Valid page retry did not advance exactly once');
      checkpoint = await registry.journal(projectId);
      for (const field of ['cursor', 'tables']) for (const kind of ['oversized', 'invalid-utf8', 'malformed']) {
        await registry.corruptJournal(projectId, field, kind);
        const before = JSON.stringify(await registry.journalFingerprint(projectId));
        let message = ''; try { await registry.reconcileRelocation('move-secret', projectId, 'move-1'); } catch (error) { message = String(error); }
        check(message.includes('Invalid reconciliation checkpoint') && !message.includes('synthetic_private_sentinel'), 'Invalid journal was accepted or leaked data');
        check(JSON.stringify(await registry.journalFingerprint(projectId)) === before, 'Invalid journal changed state');
        await registry.restoreJournal(projectId, checkpoint);
      }
      const originalCursor = await registry.evidenceCursor(projectId);
      for (const kind of ['oversized', 'invalid-utf8', 'malformed']) {
        await registry.corruptEvidenceCursor(projectId, kind);
        let message = ''; try { await registry.relocationEvidence('move-secret', projectId, 'move-1'); } catch (error) { message = String(error); }
        check(message.includes('Invalid reconciliation checkpoint') && !message.includes('synthetic_private_sentinel'), 'Invalid evidence was accepted or leaked data');
        await registry.restoreEvidenceCursor(projectId, originalCursor);
      }
      const originalNextCursor = await registry.evidenceNextCursor(projectId);
      await registry.setEvidenceNextCursor(projectId, null);
      check((await registry.relocationEvidence('move-secret', projectId, 'move-1')).pages[0].nextCursor === null, 'Historical NULL evidence cursor became unreadable');
      await registry.setEvidenceNextCursor(projectId, originalNextCursor);
      await registry.journalVersion(projectId, 2);
      const journalState = async () => JSON.stringify({
        checkpoint: await registry.journal(projectId), evidenceCount: await registry.evidenceCount(projectId),
        history: await registry.historyVerification(projectId, 'move-1'),
        route: await registry.resolve(origin), source: await source.sourceStatus(), target: await target.stagedStatus(projectId),
      });
      const partialState = await journalState();
      const oldPartial = async () => {
        await rejectsWith(() => registry.reconcileRelocation('move-secret', projectId, 'move-1'), 'Legacy reconciliation');
        await rejectsWith(() => registry.commitRelocation('move-secret', projectId, 'move-1'), 'Reconciliation is incomplete');
        await rejectsWith(() => coordinator.advance('move-secret', origin, projectId, 'move-1'), 'Legacy reconciliation');
        check(await journalState() === partialState, 'Legacy partial journal changed relocation state');
        check((await registry.resolve(otherOrigin)).state === 'active', 'Legacy checkpoint affected other project');
      };
      await oldPartial(); await rejects(() => registry.evict()); registry = env.REGISTRY.getByName('projects'); await oldPartial();
      await registry.journalVersion(projectId, RELOCATION_RECONCILIATION_VERSION);
      await rejects(() => coordinator.evict()); coordinator = env.COORDINATOR.getByName("coordinator");
      await rejectsWith(() => resume("secret", "reconcile"), "Injected interruption after reconciliation page");
      await rejectsWith(() => registry.commitRelocation("move-secret", projectId, "move-1"), "Reconciliation is incomplete");
      await rejects(() => coordinator.evict()); coordinator = env.COORDINATOR.getByName("coordinator");
      while (!(await registry.reconcileRelocation('move-secret', projectId, 'move-1')).done) {}
      await registry.journalVersion(projectId, 3);
      const completeState = await journalState();
      const oldComplete = async () => {
        await rejectsWith(() => registry.reconcileRelocation('move-secret', projectId, 'move-1'), 'Legacy reconciliation');
        await rejectsWith(() => registry.commitRelocation('move-secret', projectId, 'move-1'), 'Reconciliation is incomplete');
        await rejectsWith(() => coordinator.advance('move-secret', origin, projectId, 'move-1'), 'Legacy reconciliation');
        check((await source.sourceStatus()).state === 'frozen', 'Legacy complete source unfenced');
        check((await target.stagedStatus(projectId)).state === 'staged', 'Legacy complete destination activated');
        check(await journalState() === completeState, 'Legacy complete journal changed relocation state');
      };
      await oldComplete(); await rejects(() => registry.evict()); registry = env.REGISTRY.getByName('projects'); await oldComplete();
      await registry.journalVersion(projectId, RELOCATION_RECONCILIATION_VERSION);
      const beforeArchiveGate = await journalState();
      await rejectsWith(() => coordinator.advance("move-secret", origin, projectId, "move-1"), "independent archive proof is not configured");
      check(await journalState() === beforeArchiveGate, "Archive rejection changed relocation state");
      check((await registry.resolve(origin)).state === 'moving' && (await source.sourceStatus()).state === 'frozen' &&
        (await target.stagedStatus(projectId)).state === 'staged', "Archive rejection changed owner authority");
      await rejectsWith(() => resume("secret", "committed"), "Injected interruption after registry commit");
      await registry.journalVersion(projectId, 2);
      const committedState = await journalState();
      const oldCommitted = async () => {
        await rejectsWith(() => coordinator.advance('move-secret', origin, projectId, 'move-1'), 'Legacy committed relocation');
        await rejectsWith(() => target.activateRelocation('move-secret', projectId, 'move-1'), 'Legacy committed relocation');
        await rejectsWith(() => source.retireRelocation('move-secret', projectId, 'move-1'), 'Legacy committed relocation');
        await rejectsWith(() => registry.finalizeRelocation('move-secret', projectId, 'move-1'), 'Legacy committed relocation');
        await rejectsWith(() => registry.commitRelocation('move-secret', projectId, 'move-1'), 'Legacy committed relocation');
        check(await journalState() === committedState, 'Legacy committed journal changed relocation state');
        check((await source.sourceStatus()).state === 'frozen', 'Legacy committed source unfenced');
        check((await target.stagedStatus(projectId)).state === 'staged', 'Legacy committed destination activated');
        check((await registry.resolve(otherOrigin)).state === 'active', 'Legacy committed move affected other project');
      };
      await oldCommitted(); await rejects(() => registry.evict()); registry = env.REGISTRY.getByName('projects'); await oldCommitted();
      await registry.journalVersion(projectId, RELOCATION_RECONCILIATION_VERSION);
      await rejectsWith(() => registry.beginProjectRecovery("move-secret", origin, projectId, "recovery-race", "era-race"), "Project relocation is pending");
      await rejectsWith(() => registry.finalizeRelocation("move-secret", projectId, "move-1"), "Relocation is not finalized by owners");
      await rejectsWith(() => registry.beginRelocation("move-secret", origin, projectId, "move-2"), "Previous move has not been finalized");
      await rejectsWith(() => target.addUser("staged@example.test", "Staged-password-123!", targetRoute), "Owner import is not active");
      await rejects(() => coordinator.evict()); coordinator = env.COORDINATOR.getByName("coordinator");
      await rejectsWith(() => resume("secret", "activated"), "Injected interruption after destination activation");
      const activatedRouteBeforeRecovery = await registry.resolve(origin), activatedSourceBeforeRecovery = await source.sourceStatus(), activatedTargetBeforeRecovery = await target.stagedStatus(projectId);
      await rejectsWith(() => registry.beginProjectRecovery("move-secret", origin, projectId, "recovery-after-activation", "era-after-activation"), "Project relocation is pending");
      check(JSON.stringify(await registry.resolve(origin)) === JSON.stringify(activatedRouteBeforeRecovery), "Recovery attempt changed the activated route");
      check(JSON.stringify(await source.sourceStatus()) === JSON.stringify(activatedSourceBeforeRecovery), "Recovery attempt changed the unretired source");
      check(JSON.stringify(await target.stagedStatus(projectId)) === JSON.stringify(activatedTargetBeforeRecovery), "Recovery attempt changed the activated destination");
      check((await registry.resolve(otherOrigin)).state === 'active', "Post-activation recovery attempt affected the other project");
      const final = await coordinator.advance("move-secret", origin, projectId, "move-1");
      check(final.done && final.phase === "retired", "Coordinator did not complete retirement");
      await registry.journalVersion(projectId, 2);
      const historical = await coordinator.advance('move-secret', origin, projectId, 'move-1');
      check(historical.done && historical.phase === 'retired', 'Completed legacy history was not preserved');
      await target.activateRelocation('move-secret', projectId, 'move-1');
      await source.retireRelocation('move-secret', projectId, 'move-1');
      check((await registry.resolve(origin)).state === 'active', 'Completed legacy project was interrupted');
      await coordinator.advance("move-secret", origin, projectId, "move-1");
      const next = targetRoute;
      check(await target.caseSensitiveLike(), "Activated destination lost case-sensitive LIKE");
      check((await target.identity()) === projectId, "Project ID changed");
      check(JSON.stringify(await source.evidence(tables)) === JSON.stringify(await target.evidence(tables)), "Moved data changed");
      const movedCounts = await target.testCounts();
      check(movedCounts.users === sourceCounts.users && movedCounts.events === sourceCounts.events && user.userId, "User or audit count changed");
      await rejectsWith(() => coordinator.evidence("wrong", projectId, "move-1"), "Relocation control denied");
      await rejectsWith(() => coordinator.evidence("move-secret", otherProject, "move-1"), "Move evidence not available");
      const readEvidence = async () => {
        let cursor = 0, pages = [];
        for (;;) {
          const chunk = await coordinator.evidence("move-secret", projectId, "move-1", cursor);
          check(chunk.complete, "Move evidence is incomplete");
          pages.push(...chunk.pages);
          if (chunk.done) break;
          check(chunk.next > cursor, "Evidence cursor did not advance");
          cursor = chunk.next;
        }
        return pages;
      };
      const journal = await readEvidence();
      check(journal.filter(page => page.table === 'users').reduce((count, page) => count + page.count, 0) === movedCounts.users, "User evidence mismatch");
      check(journal.filter(page => page.table === 'events').reduce((count, page) => count + page.count, 0) === movedCounts.events, "Audit evidence mismatch");
      check(journal.some(page => page.table === 'mapi_revision_clock') && journal.some(page => page.table === 'mapi_revision_scopes') && journal.every(page => /^[a-f0-9]{64}$/.test(page.digest)), "Clock evidence or digest missing");
      await rejects(() => registry.evict());
      registry = env.REGISTRY.getByName("projects");
      check(JSON.stringify(await readEvidence()) === JSON.stringify(journal), "Move evidence changed after registry restart");
      await rejects(() => source.addUser("stale-again@example.test", "Stale-password-123!", route));
      check((await target.session(login.cookie, "read", "", next)).status === 200, "Active session was not preserved");
      check((await target.login("source@example.test", "Example-password-123!", "192.0.2.2", next)).status === 200, "Migrated user cannot sign in");
      check((await other.login("concurrent@example.test", "Concurrent-password-123!", "192.0.2.3", otherRoute)).status === 200, "Other project was affected");
      await registry.seedExistingIntentForTest(origin, projectId, 'move-2');
      await rejectsWith(async () => {
        for (let attempt = 0; attempt < 256; attempt++) {
          const progress = await coordinator.advance("move-secret", origin, projectId, "move-2");
          check(!progress.done, "Second move cut over without archive proof");
        }
        throw Error("Second move exceeded the coordinator advance limit");
      }, "independent archive proof is not configured");
      await registry.seedCommittedMoveForTest("move-secret", projectId, "move-2");
      const second = await coordinator.advance("move-secret", origin, projectId, "move-2");
      check(second.done && second.generation === 3 && second.objectName !== "source" && second.objectName !== targetName, "Second move reused an owner or generation");
      const latestRoute = { ...route, objectName: second.objectName, generation: 3 };
      const latest = env.OWNER.getByName(second.objectName);
      check((await latest.identity()) === projectId, "Second move changed project ID");
      check((await latest.login("source@example.test", "Example-password-123!", "192.0.2.4", latestRoute)).status === 200, "Second move lost credentials");
      await rejects(() => target.addUser("stale-second@example.test", "Stale-password-123!", targetRoute));
      const history = await registry.history(projectId);
      check(history.length === 2 && history[0].move_id === "move-1" && history[1].move_id === "move-2" && history[1].generation === 2, "Move history was not preserved");
      check(JSON.stringify(await readEvidence()) === JSON.stringify(journal), "Earlier move evidence was not preserved");
      await rejectsWith(() => registry.beginRelocation("move-secret", origin, projectId, "move-1"), "Move ID already used");
      return Response.json({ ok: true, tables: tables.length, users: movedCounts.users, events: movedCounts.events, legacyJournalsRejected: true });
    } catch (error) { return Response.json({ error: String(error), stack: error?.stack }, { status: 500 }); }
  },
};
