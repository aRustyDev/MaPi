import { DurableObject } from "cloudflare:workers";
import { ProjectRegistry } from "../worker/registry.js";
import { beginRegistryMove, commitRegistryMove } from "../worker/registry-move.js";
import { initializeHistoryCheckpoint, advanceHistoryCheckpoint } from '../worker/registry-history.js';
import { initializeOwnerFence, freezeOwnerFence, withOwnerFence, createOwnerFenceTable } from "../worker/owner-fence.js";
import { beginChunkExport, exportChunk, beginChunkImport, importChunk, chunkImportStatus } from "../worker/relocation-chunks.js";
import { projectFenceStatus } from "../worker/relocation.js";

const tables = ["users", "events"];
const check = (value, message) => { if (!value) throw Error(message); };
const rejects = async (fn) => { try { await fn(); } catch { return; } throw Error("Expected rejection"); };
export class RehearsalRegistry extends ProjectRegistry {
  begin(project, source, target, generation, move) { return beginRegistryMove(this.ctx.storage, project, source, target, generation, move); }
  commit(project, generation, move, source, target) { return commitRegistryMove(this.ctx.storage, project, generation, move, source, target); }
  // This older synthetic coordinator model does not exercise history RPCs.
  syntheticCompletedHistory(projectId, moveId, sourceObject, destinationObject, generation, digest) {
    return this.ctx.storage.transactionSync(() => {
      const id = { projectId, moveId, sourceObject, destinationObject, generation };
      const prior = initializeHistoryCheckpoint(this.ctx.storage.sql, id, 1, digest);
      return advanceHistoryCheckpoint(this.ctx.storage.sql, id, 1, digest, prior, digest);
    });
  }
  move(project) { return this.ctx.storage.sql.exec("SELECT * FROM mapi_route_moves WHERE project_id = ?", project).toArray()[0] ?? null; }
}
export class RehearsalOwner extends DurableObject {
  constructor(ctx, env) { super(ctx, env); this.s = ctx.storage; this.s.sql.exec("CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, data BLOB)"); this.s.sql.exec("CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, user_id TEXT REFERENCES users(id))"); this.s.sql.exec("CREATE TABLE IF NOT EXISTS test_provision (project_id TEXT NOT NULL, origin TEXT NOT NULL, object_name TEXT NOT NULL, generation INTEGER NOT NULL)"); }
  provisioningAttestation(origin, objectName, generation) {
    const projectId = { source: 'proj_first', other: 'proj_other' }[objectName];
    if (!projectId || this.ctx.id.toString() !== this.env.NEXTGEN_APPLICATION.idFromName(objectName).toString()) throw Error('Unexpected synthetic provisioning identity');
    return { projectId, origin, objectName, generation, objectId: this.ctx.id.toString() };
  }
  activateProvisioning(route) {
    const attestation = this.provisioningAttestation(route.origin, route.objectName, route.generation);
    if (attestation.projectId !== route.projectId) throw Error('Synthetic provisioning project mismatch');
    const existing = this.s.sql.exec('SELECT * FROM test_provision').toArray()[0];
    if (existing) {
      if (existing.project_id !== route.projectId || existing.origin !== route.origin || existing.object_name !== route.objectName || existing.generation !== route.generation) throw Error('Conflicting synthetic provisioning');
    } else this.s.sql.exec('INSERT INTO test_provision VALUES (?, ?, ?, ?)', route.projectId, route.origin, route.objectName, route.generation);
  }
  init(route) {
    const provision = this.s.sql.exec('SELECT * FROM test_provision').one();
    check(provision.project_id === route.projectId && provision.origin === route.origin && provision.object_name === route.objectName && provision.generation === route.generation, 'Synthetic provisioning mismatch');
    initializeOwnerFence(this.s, route);
  }
  write(route, id) { return withOwnerFence(this.s, route, () => { this.s.sql.exec("INSERT INTO users VALUES (?, X'0102')", id); this.s.sql.exec("INSERT INTO events VALUES (?, ?)", `event-${id}`, id); }); }
  seed(route) { return withOwnerFence(this.s, route, () => { for (let i = 0; i < 100; i++) { const id = `user-${String(i).padStart(3, "0")}`; this.s.sql.exec("INSERT INTO users VALUES (?, ?)", id, new Uint8Array(2000).buffer); this.s.sql.exec("INSERT INTO events VALUES (?, ?)", `event-${id}`, id); } }); }
  freeze(route, move) { freezeOwnerFence(this.s, route, move); }
  beginExport(route, move) { beginChunkExport(this.s, route.projectId, route.generation, move, tables); }
  export(route, move, index) { return exportChunk(this.s, route.projectId, route.generation, move, index); }
  beginImport(route, target, move) { beginChunkImport(this.s, route.projectId, route.generation, move, target, tables); }
  import(project, chunk) { return importChunk(this.s, project, chunk); }
  importStatus(project) { return chunkImportStatus(this.s, project); }
  sourceStatus() { return this.s.sql.exec("SELECT project_id, object_name, generation, state, move_id, digest FROM mapi_owner_fence WHERE singleton = 1").one(); }
  stagedStatus(project) { return projectFenceStatus(this.s, project); }
  activate(route, move) {
    return this.s.transactionSync(() => {
      const staged = projectFenceStatus(this.s, route.projectId);
      const exists = this.s.sql.exec("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'mapi_owner_fence'").toArray().length;
      if (exists) {
        const prior = this.s.sql.exec("SELECT * FROM mapi_owner_fence WHERE singleton = 1").one();
        check(prior.project_id === route.projectId && prior.object_name === route.objectName && prior.generation === route.generation && prior.state === "active" && prior.move_id === move, "Conflicting destination fence");
        return;
      }
      check(staged?.state === "staged" && staged.generation === route.generation && staged.object_name === route.objectName && staged.move_id === move, "Destination not staged");
      createOwnerFenceTable(this.s);
      this.s.sql.exec("INSERT INTO mapi_owner_fence VALUES (1, ?, ?, ?, ?, 'active', ?, ?)", route.projectId, route.origin, route.objectName, route.generation, move, staged.digest);
      this.s.sql.exec("DELETE FROM mapi_relocation_project WHERE project_id = ?", route.projectId);
    });
  }
  retire(route, move) {
    return this.s.transactionSync(() => {
      const fence = this.s.sql.exec("SELECT * FROM mapi_owner_fence WHERE singleton = 1").one();
      if (fence.state === "retired" && fence.move_id === move) return;
      check(fence.state === "frozen" && fence.move_id === move && fence.generation + 1 === route.generation && fence.project_id === route.projectId && fence.object_name !== route.objectName, "Cannot retire source");
      this.s.sql.exec("UPDATE mapi_owner_fence SET state = 'retired' WHERE singleton = 1");
    });
  }
  async evidence() {
    const users = this.s.sql.exec("SELECT id, hex(data) AS data FROM users ORDER BY id").toArray();
    const events = this.s.sql.exec("SELECT id, user_id FROM events ORDER BY id").toArray();
    const data = new TextEncoder().encode(JSON.stringify({ users, events }));
    const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", data));
    return { users: users.length, events: events.length, foreignKeys: this.s.sql.exec("PRAGMA foreign_key_check").toArray().length, digest: [...hash].map(byte => byte.toString(16).padStart(2, "0")).join("") };
  }
  evict() { this.ctx.abort("rehearsal owner restart"); }
}
export class RehearsalCoordinator extends DurableObject {
  evict() { this.ctx.abort("rehearsal coordinator restart"); }
  async resume(secret, origin, projectId, sourceName, targetName, move, failAt) {
    if (secret !== this.env.COORDINATOR_SECRET) throw Error("Coordinator denied");
    const registry = this.env.REGISTRY.getByName("registry");
    const source = this.env.OWNER.getByName(sourceName), target = this.env.OWNER.getByName(targetName);
    const sourceRoute = { projectId, origin, objectName: sourceName, generation: 1 };
    let checkpoint = await registry.move(projectId);
    if (!checkpoint) checkpoint = await registry.begin(projectId, sourceName, targetName, 1, move);
    check(checkpoint.move_id === move && checkpoint.source_object === sourceName && checkpoint.destination_object === targetName, "Conflicting coordinator request");
    if (checkpoint.phase === "moving") {
      await source.freeze(sourceRoute, move);
      if (failAt === "frozen") throw Error("Injected coordinator interruption");
      await source.beginExport(sourceRoute, move); await target.beginImport(sourceRoute, targetName, move);
      for (;;) {
        const status = await target.importStatus(projectId);
        if (status.done) break;
        const chunk = await source.export(sourceRoute, move, status.next_chunk);
        await target.import(projectId, chunk);
        if (failAt === "chunk") throw Error("Injected coordinator interruption");
      }
      const sourceProof = await source.sourceStatus(), destinationProof = await target.stagedStatus(projectId);
      await rejects(() => registry.commit(projectId, 1, move, sourceProof, destinationProof));
      await registry.syntheticCompletedHistory(projectId, move, sourceName, targetName, 1, sourceProof.digest);
      await registry.commit(projectId, 1, move, sourceProof, destinationProof);
      if (failAt === "committed") throw Error("Injected coordinator interruption");
    }
    const committed = await registry.resolve(origin);
    check(committed?.state === "active" && committed.project_id === projectId && committed.object_name === targetName && committed.generation === 2, "Unexpected committed route");
    const newRoute = { projectId, origin, objectName: targetName, generation: 2 };
    await target.activate(newRoute, move);
    if (failAt === "activated") throw Error("Injected coordinator interruption");
    await source.retire(newRoute, move);
    return newRoute;
  }
}
export default {
 async fetch(_request, env) {
  try {
   const registry = env.REGISTRY.getByName("registry"), origin = "https://project.example", otherOrigin = "https://other.example";
   const route = { projectId: "proj_first", origin, objectName: "source", generation: 1 };
   const otherRoute = { projectId: "proj_other", origin: otherOrigin, objectName: "other", generation: 1 };
   await registry.reserve(origin, "source"); await registry.activate(origin, "source", route.projectId);
   await registry.reserve(otherOrigin, "other"); await registry.activate(otherOrigin, "other", otherRoute.projectId);
   let source = env.OWNER.getByName("source"), target = env.OWNER.getByName("destination");
   const other = env.OWNER.getByName("other");
   let coordinator = env.COORDINATOR.getByName("coordinator");
   await source.init(route); await source.seed(route); await other.init(otherRoute);
   const resume = (secret, fail) => coordinator.resume(secret, origin, route.projectId, "source", "destination", "move-1", fail);
   await rejects(() => resume("wrong", "")); await rejects(() => resume("secret", "frozen"));
   await rejects(() => coordinator.evict()); coordinator = env.COORDINATOR.getByName("coordinator");
   check((await registry.resolve(origin)).state === "moving", "Route opened before import");
   await rejects(() => source.write(route, "stale")); await other.write(otherRoute, "other");
   await rejects(() => source.evict()); source = env.OWNER.getByName("source");
   const concurrent = await Promise.allSettled([resume("secret", "chunk"), other.write(otherRoute, "other-concurrent")]);
   check(concurrent[0].status === "rejected" && concurrent[1].status === "fulfilled", "Concurrent project traffic failed");
   await rejects(() => target.write({ ...route, objectName: "destination", generation: 2 }, "premature"));
   await rejects(() => target.evict()); target = env.OWNER.getByName("destination");
   await rejects(() => resume("secret", "committed"));
   await rejects(() => coordinator.evict()); coordinator = env.COORDINATOR.getByName("coordinator");
   await rejects(() => target.write({ ...route, objectName: "destination", generation: 2 }, "before-activation"));
   await rejects(() => resume("secret", "activated"));
   const next = await resume("secret", ""); await resume("secret", "");
   check(JSON.stringify(await source.evidence()) === JSON.stringify(await target.evidence()), "Source and destination records differ");
   await rejects(() => source.write(route, "stale-after")); await target.write(next, "after");
   const result = await target.evidence(), isolated = await other.evidence();
   check(result.users === 101 && result.events === 101 && result.foreignKeys === 0, "Destination reconciliation failed");
   check(isolated.users === 2 && isolated.events === 2, "Other project changed");
   return Response.json({ ok: true });
  } catch (error) { return Response.json({ error: String(error) }, { status: 500 }); }
 },
};
