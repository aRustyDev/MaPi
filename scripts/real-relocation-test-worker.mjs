// Local-only rehearsal. Control methods trust bindings in this isolated harness.
import { RelocationCoordinator } from "../worker/relocation-coordinator.js";
import { NextgenApplication } from "../worker/app.js";
import { ProjectRegistry, validateReconciliationPage } from "../worker/registry.js";
import { beginRegistryMove } from "../worker/registry-move.js";
import { initializeOwnerFence } from "../worker/owner-fence.js";
import { projectFenceStatus } from "../worker/relocation.js";
import { execute } from "../worker/sql.js";
import { inspectRelocationDestination } from "../worker/relocation-manifest.js";
const quote = (s) => `"${s.replaceAll('"', '""')}"`;
const check = (condition, message) => { if (!condition) throw Error(message); };
const rejects = async (fn) => { try { await fn(); } catch { return; } throw Error("Expected rejection"); };
const rejectsWith = async (fn, message) => { try { await fn(); } catch (error) { if (String(error).includes(message)) return; throw error; } throw Error(`Expected rejection: ${message}`); };
export class RealRegistry extends ProjectRegistry {
  begin(project, source, target, generation, move) { return beginRegistryMove(this.ctx.storage, project, source, target, generation, move); }
  move(project) { return this.ctx.storage.sql.exec("SELECT * FROM mapi_route_moves WHERE project_id = ?", project).toArray()[0] ?? null; }
  history(project) { return this.ctx.storage.sql.exec("SELECT move_id, source_object, destination_object, generation FROM mapi_move_history WHERE project_id = ? ORDER BY generation", project).toArray(); }
  journalVersion(project, version) { this.ctx.storage.sql.exec('UPDATE mapi_move_reconciliation SET journal_version = ? WHERE project_id = ?', version, project); }
  journal(project) { return this.ctx.storage.sql.exec('SELECT * FROM mapi_move_reconciliation WHERE project_id = ?', project).toArray()[0] ?? null; }
  evidenceCount(project) { return this.ctx.storage.sql.exec('SELECT count(*) AS n FROM mapi_move_evidence WHERE project_id = ?', project).one().n; }
  evict() { this.ctx.abort("registry restart"); }
}
export class RealOwner extends NextgenApplication {
  #legacyDigestForTest = false;
  #malformedPageForTest = null;
  #heldRestore;
  #releaseRestore;
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
    super(ctx, importing ? { ...env, MAPI_SCHEMA_TARGET: "2" } : env);
  }
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
      await registry.commitRelocation("move-secret", projectId, moveId);
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
  async fetch(_request, env) {
    try {
      const page = (count, cursor, done) => ({ guardVersion: 2, count, cursor, done, digest: 'a'.repeat(64) });
      validateReconciliationPage(page(0, null, true), null);
      validateReconciliationPage(page(0, [{ integer: '-9223372036854775808' }], true), [{ integer: '-9223372036854775808' }]);
      validateReconciliationPage(page(64, [{ integer: '9223372036854775807' }, { blob: 'AAE=' }, { blob: 'AA==' }, { blob: '' }, 'key', 1.5], false), null);
      for (const blob of ['AB==', 'AAF=', 'AA=', 'AA-_', 'AA==\n']) {
        let rejected = false;
        try { validateReconciliationPage(page(1, [{ blob }], true), null); } catch { rejected = true; }
        check(rejected, 'Noncanonical blob key was accepted');
      }
      const largeBlob = 'A'.repeat(8_388_608);
      validateReconciliationPage(page(1, [{ blob: largeBlob }], true), null);
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
      await rejectsWith(() => source.freezeRelocation("wrong", route, "move-1"), "Relocation control denied");
      await rejectsWith(() => source.freezeRelocation("move-secret", route, "move-1"), "Source move is not reserved by registry");
      await rejectsWith(() => target.reserveMoveDestination("wrong", reservedRoute, "move-1"), "Relocation control denied");
      await rejectsWith(() => target.reserveMoveDestination("move-secret", reservedRoute, "move-1"), "Destination is not reserved by registry");
      const login = await source.login("source@example.test", "Example-password-123!", "192.0.2.1", route);
      check(login.status === 200 && login.cookie, "Source login failed");
      const sourceCounts = await source.testCounts(), tables = await source.manifest();
      const restoreAttempt = source.holdRestoreForTest("old-bookmark").then(() => false, error => String(error).includes("Coordinated recovery is required"));
      while (!await source.restoreHeldForTest()) await new Promise(resolve => setTimeout(resolve, 0));
      const move = await registry.beginRelocation("move-secret", origin, projectId, "move-1");
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
      await rejectsWith(() => source.restore("old-bookmark"), "Coordinated recovery is required");
      await rejects(() => coordinator.evict()); coordinator = env.COORDINATOR.getByName("coordinator");
      const concurrent = await Promise.allSettled([resume("secret", "chunk"), other.addUser("concurrent@example.test", "Concurrent-password-123!", otherRoute)]);
      check(concurrent[0].status === "rejected" && String(concurrent[0].reason).includes("Injected interruption after chunk") && concurrent[1].status === "fulfilled", "Concurrent traffic failed");
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
      for (;;) {
        const progress = await coordinator.advance("move-secret", origin, projectId, "move-1");
        if (progress.phase === "reconciling") break;
        check(progress.phase === "importing", "Unexpected coordinator phase");
      }
      const stagedBeforeRetry = await target.stagedStatus(projectId);
      const stagedRowsBeforeRetry = await target.evidence(tables);
      check(stagedBeforeRetry?.state === 'staged', 'Destination was not staged before reservation retry');
      await target.reserveMoveDestination('move-secret', reservedRoute, 'move-1');
      await rejects(() => target.evict()); target = env.OWNER.getByName(targetName);
      await target.reserveMoveDestination('move-secret', reservedRoute, 'move-1');
      check(JSON.stringify(await target.stagedStatus(projectId)) === JSON.stringify(stagedBeforeRetry), 'Staged reservation retry changed the owner state');
      check(JSON.stringify(await target.evidence(tables)) === JSON.stringify(stagedRowsBeforeRetry), 'Staged reservation retry changed project rows');
      let checkpoint = await registry.journal(projectId);
      check(checkpoint?.journal_version === 2, 'Current reconciliation version missing');
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
      await registry.journalVersion(projectId, 1);
      const oldPartial = async () => {
        await rejectsWith(() => registry.reconcileRelocation('move-secret', projectId, 'move-1'), 'Legacy reconciliation');
        await rejectsWith(() => registry.commitRelocation('move-secret', projectId, 'move-1'), 'Reconciliation is incomplete');
        await rejectsWith(() => coordinator.advance('move-secret', origin, projectId, 'move-1'), 'Legacy reconciliation');
        check((await registry.resolve(otherOrigin)).state === 'active', 'Legacy checkpoint affected other project');
      };
      await oldPartial(); await rejects(() => registry.evict()); registry = env.REGISTRY.getByName('projects'); await oldPartial();
      await registry.journalVersion(projectId, 2);
      await rejects(() => coordinator.evict()); coordinator = env.COORDINATOR.getByName("coordinator");
      await rejectsWith(() => resume("secret", "reconcile"), "Injected interruption after reconciliation page");
      await rejectsWith(() => registry.commitRelocation("move-secret", projectId, "move-1"), "Reconciliation is incomplete");
      await rejects(() => coordinator.evict()); coordinator = env.COORDINATOR.getByName("coordinator");
      while (!(await registry.reconcileRelocation('move-secret', projectId, 'move-1')).done) {}
      await registry.journalVersion(projectId, 1);
      const oldComplete = async () => {
        await rejectsWith(() => registry.reconcileRelocation('move-secret', projectId, 'move-1'), 'Legacy reconciliation');
        await rejectsWith(() => registry.commitRelocation('move-secret', projectId, 'move-1'), 'Reconciliation is incomplete');
        await rejectsWith(() => coordinator.advance('move-secret', origin, projectId, 'move-1'), 'Legacy reconciliation');
        check((await source.sourceStatus()).state === 'frozen', 'Legacy complete source unfenced');
        check((await target.stagedStatus(projectId)).state === 'staged', 'Legacy complete destination activated');
      };
      await oldComplete(); await rejects(() => registry.evict()); registry = env.REGISTRY.getByName('projects'); await oldComplete();
      await registry.journalVersion(projectId, 2);
      await rejectsWith(() => resume("secret", "committed"), "Injected interruption after registry commit");
      await registry.journalVersion(projectId, 1);
      const oldCommitted = async () => {
        await rejectsWith(() => coordinator.advance('move-secret', origin, projectId, 'move-1'), 'Legacy committed relocation');
        await rejectsWith(() => target.activateRelocation('move-secret', projectId, 'move-1'), 'Legacy committed relocation');
        await rejectsWith(() => source.retireRelocation('move-secret', projectId, 'move-1'), 'Legacy committed relocation');
        await rejectsWith(() => registry.finalizeRelocation('move-secret', projectId, 'move-1'), 'Legacy committed relocation');
        await rejectsWith(() => registry.commitRelocation('move-secret', projectId, 'move-1'), 'Legacy committed relocation');
        check((await source.sourceStatus()).state === 'frozen', 'Legacy committed source unfenced');
        check((await target.stagedStatus(projectId)).state === 'staged', 'Legacy committed destination activated');
        check((await registry.resolve(otherOrigin)).state === 'active', 'Legacy committed move affected other project');
      };
      await oldCommitted(); await rejects(() => registry.evict()); registry = env.REGISTRY.getByName('projects'); await oldCommitted();
      await registry.journalVersion(projectId, 2);
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
      await registry.journalVersion(projectId, 1);
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
      let second;
      for (;;) {
        second = await coordinator.advance("move-secret", origin, projectId, "move-2");
        if (second.done) break;
      }
      check(second.generation === 3 && second.objectName !== "source" && second.objectName !== targetName, "Second move reused an owner or generation");
      const latestRoute = { ...route, objectName: second.objectName, generation: 3 };
      const latest = env.OWNER.getByName(second.objectName);
      check((await latest.identity()) === projectId, "Second move changed project ID");
      check((await latest.login("source@example.test", "Example-password-123!", "192.0.2.4", latestRoute)).status === 200, "Second move lost credentials");
      await rejects(() => target.addUser("stale-second@example.test", "Stale-password-123!", targetRoute));
      const history = await registry.history(projectId);
      check(history.length === 2 && history[0].move_id === "move-1" && history[1].move_id === "move-2" && history[1].generation === 2, "Move history was not preserved");
      check(JSON.stringify(await readEvidence()) === JSON.stringify(journal), "Earlier move evidence was not preserved");
      await rejectsWith(() => registry.beginRelocation("move-secret", origin, projectId, "move-1"), "Move ID already used");
      return Response.json({ ok: true, tables: tables.length, users: movedCounts.users, events: movedCounts.events });
    } catch (error) { return Response.json({ error: String(error), stack: error?.stack }, { status: 500 }); }
  },
};
