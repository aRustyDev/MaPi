import { DurableObject } from "cloudflare:workers";

function authorize(env, secret) {
  const token = env.MAPI_RELOCATION_CONTROL_TOKEN;
  if (env.MAPI_RELOCATION_ENABLED !== "1" || !token || typeof secret !== "string" || secret.length !== token.length) throw new Error("Relocation control denied");
  let difference = 0;
  for (let index = 0; index < token.length; index++) difference |= secret.charCodeAt(index) ^ token.charCodeAt(index);
  if (difference) throw new Error("Relocation control denied");
}

// Private RPC only. Each call advances at most one bounded import or digest
// page. Authoritative progress is stored by the registry and owners, so an
// evicted coordinator can resume without an in-memory journal.
export class RelocationCoordinator extends DurableObject {
  async advance(secret, origin, projectId, moveId) {
    authorize(this.env, secret);
    const registry = this.env.PROJECT_REGISTRY.getByName("projects");
    const move = await registry.beginRelocation(secret, origin, projectId, moveId);
    const namespace = this.env.NEXTGEN_APPLICATION;
    const source = namespace.getByName(move.source_object), destination = namespace.getByName(move.destination_object);
    if (move.phase === "committed") {
      if (move.finalized) return { done: true, phase: "retired", objectName: move.destination_object, generation: move.generation + 1 };
      if (!move.reconciliationReady) throw new Error("Legacy committed relocation requires manual review");
      await destination.activateRelocation(secret, projectId, moveId);
      await source.retireRelocation(secret, projectId, moveId);
      await registry.finalizeRelocation(secret, projectId, moveId);
      return { done: true, phase: "retired", objectName: move.destination_object, generation: move.generation + 1 };
    }
    const sourceRoute = { projectId, origin, objectName: move.source_object, generation: move.generation };
    await source.armRelocation(secret, projectId, moveId);
    await source.freezeRelocation(secret, sourceRoute, moveId);
    await destination.reserveMoveDestination(secret, { ...sourceRoute, objectName: move.destination_object, generation: move.generation + 1 }, moveId);
    await destination.prepareRelocation(secret, projectId, moveId);
    await source.beginRelocationExport(secret, projectId, moveId);
    await destination.beginRelocationImport(secret, projectId, moveId);
    const checkpoint = await destination.relocationImportStatus(secret, projectId, moveId);
    if (!checkpoint.done) {
      await destination.importRelocationChunk(secret, projectId, moveId, checkpoint.next_chunk);
      return { done: false, phase: "importing", nextChunk: checkpoint.next_chunk + 1 };
    }
    await destination.restoreRelocationMetadata(secret, projectId, moveId);
    const history = await registry.verifyRelocationHistory(secret, projectId, moveId);
    if (!history.done) return { done: false, phase: "verifying-history", nextChunk: history.nextIndex };
    const comparison = await registry.reconcileRelocation(secret, projectId, moveId);
    if (!comparison.done) return { done: false, phase: "reconciling", tableIndex: comparison.tableIndex, evidence: comparison.evidence };
    await registry.commitRelocation(secret, projectId, moveId);
    return { done: false, phase: "committed", evidence: comparison.evidence };
  }

  evidence(secret, projectId, moveId, after = 0) {
    authorize(this.env, secret);
    return this.env.PROJECT_REGISTRY.getByName("projects").relocationEvidence(secret, projectId, moveId, after);
  }
}
