import { ProjectRegistry, validNewRelocationMoveId } from "../worker/registry.js";
import { beginRegistryMove, commitRegistryMove } from "../worker/registry-move.js";
import { initializeHistoryCheckpoint, advanceHistoryCheckpoint } from '../worker/registry-history.js';
import { RELOCATION_RECONCILIATION_VERSION } from '../worker/relocation-values.js';
import { DurableObject } from "cloudflare:workers";

export class RegistryMoveOwner extends DurableObject {
  #attestation;
  #history;
  #freezeCalls = 0;
  setAttestation(value) { this.#attestation = value; }
  relocationAttestation() { return this.#attestation; }
  setSyntheticHistory(value) { this.#history = value; }
  relocationSourceHistoryStatus() { return { total: this.#history.length, digest: this.#attestation.digest }; }
  relocationDestinationHistoryStatus() { return this.relocationSourceHistoryStatus(); }
  async relocationSourceHistory(_s, _p, _m, digest, index) { await new Promise(resolve => setTimeout(resolve, 10)); return { total: this.#history.length, digest, index, previous: index ? this.#history[index-1] : '', chunkDigest: this.#history[index], done: index === this.#history.length-1 }; }
  relocationDestinationHistory(_s, _p, _m, digest, index) { return { total: this.#history.length, digest, index, chunkDigest: this.#history[index] }; }
  provisioningAttestation(origin, objectName, generation) {
    const projectId = { source: 'proj_first', other: 'proj_second', 'third-source': 'proj_third', 'legacy-source': 'proj_legacy', 'boundary-source': 'proj_boundary', 'id-uuid-source': 'proj_id_uuid', 'id-ascii-source': 'proj_id_ascii', 'id-multi-source': 'proj_id_multi', 'id-legacy-source': 'proj_id_legacy' }[objectName];
    if (!projectId) throw new Error('Unknown synthetic owner');
    return { projectId, origin, objectName, generation, objectId: this.ctx.id.toString() };
  }
  activateProvisioning() {}
  preFreezeRelocation(_secret, route, moveId) { this.#freezeCalls++; return { ...route, moveId, state: "frozen", objectId: this.ctx.id.toString() }; }
  freezeCalls() { return this.#freezeCalls; }
}

export class RegistryMoveTest extends ProjectRegistry {
  begin(project, source, destination, generation, move) { return beginRegistryMove(this.ctx.storage, project, source, destination, generation, move); }
  commit(project, generation, move, source, destination) { return commitRegistryMove(this.ctx.storage, project, generation, move, source, destination); }
  // Fixture for low-level registry model tests only. It is never exposed by the production class.
  syntheticCompletedHistory(projectId, moveId, sourceObject, destinationObject, generation, digest) {
    return this.ctx.storage.transactionSync(() => {
      const id = { projectId, moveId, sourceObject, destinationObject, generation };
      const prior = initializeHistoryCheckpoint(this.ctx.storage.sql, id, 1, digest);
      return advanceHistoryCheckpoint(this.ctx.storage.sql, id, 1, digest, prior, digest);
    });
  }
  syntheticCompletedReconciliation(projectId, moveId) {
    const sql = this.ctx.storage.sql;
    sql.exec('INSERT INTO mapi_move_reconciliation (project_id, move_id, tables, table_index, cursor, journal_version) VALUES (?, ?, ?, 1, NULL, ?) ON CONFLICT(project_id) DO UPDATE SET move_id = excluded.move_id, tables = excluded.tables, table_index = excluded.table_index, cursor = NULL, journal_version = excluded.journal_version', projectId, moveId, JSON.stringify(['synthetic']), RELOCATION_RECONCILIATION_VERSION);
    sql.exec('INSERT INTO mapi_move_journals (move_id, project_id, complete) VALUES (?, ?, 1)', moveId, projectId);
  }
  inconsistentIntent(project, origin, source, move) { this.ctx.storage.sql.exec("INSERT INTO mapi_move_intents VALUES (?, ?, ?, ?, ?, 1)", project, move, origin, source, "wrong-destination"); }
  seedLegacyIntent(project, origin, source, move) { this.ctx.storage.sql.exec("INSERT INTO mapi_move_intents VALUES (?, ?, ?, ?, ?, 1)", project, move, origin, source, "project:legacy-intent-destination"); }
  intentSnapshot(project) {
    const sql = this.ctx.storage.sql;
    return { route: sql.exec('SELECT origin, object_name, project_id, state, generation FROM project_routes WHERE project_id = ?', project).toArray(), intent: sql.exec('SELECT * FROM mapi_move_intents WHERE project_id = ?', project).toArray(), move: sql.exec('SELECT * FROM mapi_route_moves WHERE project_id = ?', project).toArray(), ids: sql.exec('SELECT COUNT(*) AS n FROM mapi_route_move_ids').one().n, objects: sql.exec('SELECT COUNT(*) AS n FROM mapi_route_move_objects').one().n };
  }
  setGeneration(project, generation) { this.ctx.storage.sql.exec('UPDATE project_routes SET generation = CAST(? AS INTEGER) WHERE project_id = ?', generation, project); }
  setMoveDigest(project, digest) { this.ctx.storage.sql.exec('UPDATE mapi_route_moves SET digest = ? WHERE project_id = ?', digest, project); }
  rawMove(project) { return { route: this.ctx.storage.sql.exec('SELECT origin, object_name, project_id, state, generation FROM project_routes WHERE project_id = ?', project).one(), move: this.ctx.storage.sql.exec('SELECT * FROM mapi_route_moves WHERE project_id = ?', project).one() }; }
  evict() { this.ctx.abort("registry move restart"); }
}
const reject = async (fn) => { try { await fn(); } catch { return; } throw new Error("Expected rejection"); };
export default {
  async fetch(_request, env) {
    try {
      let registry = env.REGISTRY.getByName(crypto.randomUUID());
      const uuid = crypto.randomUUID();
      for (const invalid of ['', 'x'.repeat(129), '€'.repeat(43), '😀'.repeat(33), '\ud800', '\udc00', 'a\ud800b', null, 1]) {
        if (validNewRelocationMoveId(invalid)) throw Error('Invalid new move ID accepted by validator');
      }
      for (const valid of [uuid, 'x'.repeat(128), 'é'.repeat(64), '😀'.repeat(32)]) {
        if (!validNewRelocationMoveId(valid)) throw Error('Valid bounded move ID rejected by validator');
      }
      const idOrigin = 'https://id-uuid.example';
      await registry.reserve(idOrigin, 'id-uuid-source'); await registry.activate(idOrigin, 'id-uuid-source', 'proj_id_uuid');
      const idOwner = env.NEXTGEN_APPLICATION.getByName('id-uuid-source');
      const beforeInvalid = JSON.stringify(await registry.intentSnapshot('proj_id_uuid'));
      for (const invalid of ['', 'x'.repeat(129), '€'.repeat(43), '😀'.repeat(33), '\ud800', '\udc00']) {
        await reject(() => registry.beginRelocation('move-secret', idOrigin, 'proj_id_uuid', invalid));
        if (JSON.stringify(await registry.intentSnapshot('proj_id_uuid')) !== beforeInvalid || await idOwner.freezeCalls() !== 0) throw Error('Invalid move ID changed registry or froze source');
      }
      if ((await registry.beginRelocation('move-secret', idOrigin, 'proj_id_uuid', uuid)).move_id !== uuid) throw Error('UUID move ID rejected');
      if ((await registry.beginRelocation('move-secret', idOrigin, 'proj_id_uuid', uuid)).move_id !== uuid) throw Error('UUID retry rejected');
      for (const [origin, object, project, move] of [
        ['https://id-ascii.example', 'id-ascii-source', 'proj_id_ascii', 'x'.repeat(128)],
        ['https://id-multi.example', 'id-multi-source', 'proj_id_multi', '😀'.repeat(32)],
      ]) {
        await registry.reserve(origin, object); await registry.activate(origin, object, project);
        if (project === 'proj_id_ascii') {
          const beforeReuse = JSON.stringify(await registry.intentSnapshot(project));
          await reject(() => registry.beginRelocation('move-secret', origin, project, uuid));
          if (JSON.stringify(await registry.intentSnapshot(project)) !== beforeReuse || await env.NEXTGEN_APPLICATION.getByName(object).freezeCalls() !== 0) throw Error('Reused move ID changed registry or froze source');
        }
        if ((await registry.beginRelocation('move-secret', origin, project, move)).move_id !== move) throw Error('128-byte move ID rejected');
      }
      const legacyIdOrigin = 'https://id-legacy.example', longLegacyId = 'L'.repeat(129);
      await registry.reserve(legacyIdOrigin, 'id-legacy-source'); await registry.activate(legacyIdOrigin, 'id-legacy-source', 'proj_id_legacy');
      await registry.seedLegacyIntent('proj_id_legacy', legacyIdOrigin, 'id-legacy-source', longLegacyId);
      const resumedLegacy = await registry.beginRelocation('move-secret', legacyIdOrigin, 'proj_id_legacy', longLegacyId);
      if (resumedLegacy.move_id !== longLegacyId || (await registry.beginRelocation('move-secret', legacyIdOrigin, 'proj_id_legacy', longLegacyId)).move_id !== longLegacyId) throw Error('Legacy intent retry rejected');
      const legacySource = { project_id: 'proj_id_legacy', object_name: 'id-legacy-source', generation: 1, state: 'frozen', move_id: longLegacyId, digest: 'd'.repeat(64) };
      const legacyDestination = { project_id: 'proj_id_legacy', object_name: resumedLegacy.destination_object, generation: 2, state: 'staged', move_id: longLegacyId, digest: 'd'.repeat(64) };
      await reject(() => registry.commit('proj_id_legacy', 1, longLegacyId, legacySource, legacyDestination));
      await registry.syntheticCompletedHistory('proj_id_legacy', longLegacyId, 'id-legacy-source', resumedLegacy.destination_object, 1, legacySource.digest);
      await registry.commit('proj_id_legacy', 1, longLegacyId, legacySource, legacyDestination);
      if ((await registry.beginRelocation('move-secret', legacyIdOrigin, 'proj_id_legacy', longLegacyId)).move_id !== longLegacyId) throw Error('Committed legacy move retry rejected');
      const origin = "https://first.example", other = "https://second.example";
      await registry.reserve(origin, "source"); await registry.activate(origin, "source", "proj_first");
      await registry.reserve(other, "other"); await registry.activate(other, "other", "proj_second");
      await reject(() => registry.begin("proj_first", "source", "other", 1, "move-reused"));
      if ((await registry.resolve(origin)).state !== "active") throw Error("Rejected destination closed route");
      await registry.begin("proj_first", "source", "destination", 1, "move-1");
      await registry.begin("proj_first", "source", "destination", 1, "move-1");
      if ((await registry.resolve(origin)).state !== "moving" || (await registry.resolve(other)).state !== "active") throw Error("Moving route did not close independently");
      if ((await registry.reserve(origin, "ignored")).state !== "moving") throw Error("Reservation bypassed moving state");
      await reject(() => registry.activate(origin, "source", "proj_first"));
      await reject(() => registry.begin("proj_first", "source", "other-destination", 1, "move-2"));
      const source = { project_id: "proj_first", object_name: "source", generation: 1, state: "frozen", move_id: "move-1", digest: "a".repeat(64) };
      const destination = { project_id: "proj_first", object_name: "destination", generation: 2, state: "staged", move_id: "move-1", digest: "a".repeat(64) };
      await reject(() => registry.commit("proj_first", 1, "move-1", source, { ...destination, digest: "wrong" }));
      const prior = JSON.stringify(await registry.rawMove('proj_first'));
      for (const digest of ['', 'digest', 'a'.repeat(63), 'a'.repeat(65), 'A'.repeat(64), 'g'.repeat(64), 'a'.repeat(64) + '\n', null, 1]) {
        await reject(() => registry.commit('proj_first', 1, 'move-1', { ...source, digest }, { ...destination, digest }));
        if (JSON.stringify(await registry.rawMove('proj_first')) !== prior) throw Error('Invalid matching digest changed the route or move');
        if ((await registry.resolve(other)).object_name !== 'other') throw Error('Invalid digest changed another project');
      }
      if ((await registry.resolve(origin)).state !== "moving") throw Error("Failed reconciliation opened route");
      await reject(() => registry.commit('proj_first', 1, 'move-1', source, destination));
      await registry.syntheticCompletedHistory('proj_first', 'move-1', 'source', 'destination', 1, source.digest);
      await reject(() => registry.evict());
      const old = registry;
      registry = env.REGISTRY.get(old.id);
      if ((await registry.resolve(origin)).state !== "moving") throw Error("Move did not survive eviction");
      const route = await registry.commit("proj_first", 1, "move-1", source, destination);
      if (route.object_name !== "destination" || route.generation !== 2 || (await registry.resolve(origin)).state !== "active") throw Error("Cutover did not commit atomically");
      await registry.commit("proj_first", 1, "move-1", source, destination);
      await reject(() => registry.begin("proj_first", "destination", "source", 2, "move-back-reused"));
      await reject(() => registry.begin("proj_first", "destination", "next", 2, "move-1"));
      await reject(() => registry.begin("proj_first", "source", "next", 1, "move-3"));
      if ((await registry.resolve(other)).object_name !== "other") throw Error("Other project changed");
      // An already-committed legacy row is not rewritten or revalidated by
      // the low-level idempotent retry. The public API still requires the
      // existing reconciliation or finalized checkpoint before returning it.
      await registry.setMoveDigest('proj_first', 'legacy-invalid');
      const legacyRetry = await registry.commit('proj_first', 1, 'move-1', { ...source, digest: 'legacy-invalid' }, { ...destination, digest: 'legacy-invalid' });
      if (legacyRetry.object_name !== 'destination' || legacyRetry.generation !== 2 || (await registry.rawMove('proj_first')).move.digest !== 'legacy-invalid') throw Error('Legacy committed retry changed state');
      await reject(() => registry.commitRelocation('move-secret', 'proj_first', 'move-1'));
      await reject(() => registry.finalizeRelocation('move-secret', 'proj_first', 'move-1'));
      await registry.syntheticCompletedReconciliation('proj_first', 'move-1');
      const recovered = await registry.commitRelocation('move-secret', 'proj_first', 'move-1');
      if (recovered.object_name !== 'destination' || recovered.generation !== 2) throw Error('Committed move retry did not return its route');
      await reject(() => registry.commitRelocation('move-secret', 'proj_first', 'different-move'));
      const third = "https://third.example";
      await registry.reserve(third, "third-source"); await registry.activate(third, "third-source", "proj_third");
      await reject(() => registry.beginRelocation("wrong", third, "proj_third", "move-3"));
      await reject(() => registry.beginRelocation("move-secret", third, "proj_first", "move-3"));
      const allocated = await registry.beginRelocation("move-secret", third, "proj_third", "move-3");
      if (!allocated.destination_object.startsWith("project:") || allocated.source_object !== "third-source") throw Error("Destination not allocated by registry");
      const repeated = await registry.beginRelocation("move-secret", third, "proj_third", "move-3");
      if (repeated.destination_object !== allocated.destination_object) throw Error("Relocation retry changed destination");
      await reject(() => registry.beginRelocation("move-secret", third, "proj_third", "move-4"));
      await reject(() => registry.relocationStatus("wrong", "proj_third"));
      const status = await registry.relocationStatus("move-secret", "proj_third");
      if (status.move.destination_object !== allocated.destination_object || status.route.object_name !== "third-source") throw Error("Registry move status changed");
      const sourceOwner = env.NEXTGEN_APPLICATION.getByName('third-source');
      const destinationOwner = env.NEXTGEN_APPLICATION.getByName(allocated.destination_object);
      const sourceProof = { project_id: 'proj_third', object_name: 'third-source', generation: 1, state: 'frozen', move_id: 'move-3', digest: 'bad' };
      const destinationProof = { project_id: 'proj_third', object_name: allocated.destination_object, generation: 2, state: 'staged', move_id: 'move-3', digest: 'bad' };
      await sourceOwner.setAttestation(sourceProof); await destinationOwner.setAttestation(destinationProof);
      await reject(() => registry.relocationProofs('move-secret', 'proj_third', 'move-3'));
      if ((await registry.resolve(third)).state !== 'moving') throw Error('Invalid owner proof reopened route');
      await sourceOwner.setAttestation({ ...sourceProof, digest: 'b'.repeat(64) });
      await destinationOwner.setAttestation({ ...destinationProof, digest: 'b'.repeat(64) });
      if ((await registry.relocationProofs('move-secret', 'proj_third', 'move-3')).source.digest !== 'b'.repeat(64)) throw Error('Valid owner proofs were rejected');
      await sourceOwner.setSyntheticHistory(['a'.repeat(64), 'b'.repeat(64)]);
      await destinationOwner.setSyntheticHistory(['a'.repeat(64), 'b'.repeat(64)]);
      const races = await Promise.allSettled([registry.verifyRelocationHistory('move-secret', 'proj_third', 'move-3'), registry.verifyRelocationHistory('move-secret', 'proj_third', 'move-3')]);
      if (races.filter(r => r.status === 'fulfilled').length !== 1 || races.filter(r => r.status === 'rejected').length !== 1) throw Error('Concurrent history verification did not enforce checkpoint CAS');
      const registryId = registry.id;
      await reject(() => registry.evict()); registry = env.REGISTRY.get(registryId);
      const resumed = await registry.verifyRelocationHistory('move-secret', 'proj_third', 'move-3');
      if (!resumed.done || resumed.nextIndex !== 2) throw Error('Lost history acknowledgement did not resume from checkpoint');
      if (!(await registry.verifyRelocationHistory('move-secret', 'proj_third', 'move-3')).done) throw Error('Completed history replay failed');
      // Even matching owner attestations, verified transfer history and a
      // completed reconciliation are not an independent recovery archive.
      await registry.syntheticCompletedReconciliation('proj_third', 'move-3');
      const beforeCutover = JSON.stringify(await registry.rawMove('proj_third'));
      const attempts = await Promise.allSettled([
        registry.commitRelocation('move-secret', 'proj_third', 'move-3'),
        registry.commitRelocation('move-secret', 'proj_third', 'move-3'),
      ]);
      if (attempts.some(result => result.status !== 'rejected' || !String(result.reason).includes('independent archive proof'))) throw Error('Direct cutover did not fail closed on archive proof');
      if (JSON.stringify(await registry.rawMove('proj_third')) !== beforeCutover || (await registry.resolve(third)).state !== 'moving' || (await registry.resolve(other)).state !== 'active') throw Error('Rejected archive gate changed routes or move');
      // The last safe increment is accepted and retained exactly. This uses
      // test-only synthetic owner attestations and exercises the registry CAS.
      const boundary = 'https://boundary.example', boundaryGeneration = Number.MAX_SAFE_INTEGER - 1;
      await registry.reserve(boundary, 'boundary-source'); await registry.activate(boundary, 'boundary-source', 'proj_boundary');
      await registry.setGeneration('proj_boundary', '9007199254740990');
      const boundaryMove = await registry.beginRelocation('move-secret', boundary, 'proj_boundary', 'boundary-move');
      const boundarySource = { project_id: 'proj_boundary', object_name: 'boundary-source', generation: boundaryGeneration, state: 'frozen', move_id: 'boundary-move', digest: 'c'.repeat(64) };
      const boundaryDestination = { project_id: 'proj_boundary', object_name: boundaryMove.destination_object, generation: Number.MAX_SAFE_INTEGER, state: 'staged', move_id: 'boundary-move', digest: 'c'.repeat(64) };
      await registry.syntheticCompletedHistory('proj_boundary', 'boundary-move', 'boundary-source', boundaryMove.destination_object, boundaryGeneration, boundarySource.digest);
      const boundaryRoute = await registry.commit('proj_boundary', boundaryGeneration, 'boundary-move', boundarySource, boundaryDestination);
      if (boundaryRoute.generation !== Number.MAX_SAFE_INTEGER || (await registry.resolve(boundary)).generation !== Number.MAX_SAFE_INTEGER) throw Error('Last safe generation did not survive cutover');
      if ((await registry.beginRelocation('move-secret', boundary, 'proj_boundary', 'boundary-move')).move_id !== 'boundary-move') throw Error('Committed boundary retry was rejected');
      const legacy = "https://legacy.example";
      await registry.reserve(legacy, "legacy-source"); await registry.activate(legacy, "legacy-source", "proj_legacy");
      // Simulate a row created by code predating durable pre-freeze intents.
      await registry.begin("proj_legacy", "legacy-source", "legacy-destination", 1, "old-move");
      const rejectLegacy = async () => {
        await reject(() => registry.beginRelocation("move-secret", legacy, "proj_legacy", "old-move"));
        await reject(() => registry.relocationStatus("move-secret", "proj_legacy"));
        await reject(() => registry.relocationProofs("move-secret", "proj_legacy", "old-move"));
        await reject(() => registry.reconcileRelocation("move-secret", "proj_legacy", "old-move"));
        await reject(() => registry.commitRelocation("move-secret", "proj_legacy", "old-move"));
        if ((await registry.resolve(legacy)).state !== "moving") throw Error("Legacy move reopened");
        if ((await registry.resolve(other)).state !== "active") throw Error("Legacy move affected another project");
      };
      await rejectLegacy();
      const legacyRegistryId = registry.id;
      await reject(() => registry.evict()); registry = env.REGISTRY.get(legacyRegistryId);
      await rejectLegacy();
      await registry.inconsistentIntent("proj_legacy", legacy, "legacy-source", "old-move");
      await rejectLegacy();
      return Response.json({ ok: true });
    } catch (error) { return Response.json({ error: String(error) }, { status: 500 }); }
  },
};
