// Synthetic rehearsal control for a fresh, isolated owner namespace.
import { NextgenApplication, ProjectRegistry as BaseRegistry, RelocationCoordinator } from '../worker/phase1-owner.js';

export { RelocationCoordinator };
export class ProjectRegistry extends BaseRegistry {
  proofState() { return this.ctx.storage.kv.get('real-owner-proof') ?? null; }
  saveProofState(state) { this.ctx.storage.kv.put('real-owner-proof', state); }
}
export class RealOwner extends NextgenApplication {
  seedRealValues(projectId, userId) {
    this.ctx.storage.transactionSync(() => {
      for (const [key, value] of [['positive', Infinity], ['negative', -Infinity], ['finite', 1.5], ['null', null]]) {
        this.ctx.storage.sql.exec('INSERT INTO user_attributes (project_id, user_id, key, value, value_hash) VALUES (?, ?, ?, ?, ?)', projectId, userId, `real-${key}`, '"fixture"', value);
      }
    });
  }
  realValues(projectId, userId) {
    return this.ctx.storage.sql.exec(`SELECT key, typeof(value_hash) AS kind,
      CASE WHEN value_hash = 1e999 THEN 'positive' WHEN value_hash = -1e999 THEN 'negative'
      WHEN value_hash = 1.5 THEN 'finite' WHEN value_hash IS NULL THEN 'null' ELSE 'other' END AS value
      FROM user_attributes WHERE project_id = ? AND user_id = ? AND key GLOB 'real-*' ORDER BY key`, projectId, userId).toArray();
  }
}
const check = (condition, message) => { if (!condition) throw Error(message); };
export default {
  async fetch(request, env) {
    const encoder = new TextEncoder();
    const supplied = encoder.encode(request.headers.get('authorization') ?? '');
    const expected = encoder.encode(`Bearer ${env.MAPI_STAGING_PROOF_TOKEN ?? ''}`);
    if (!env.MAPI_STAGING_PROOF_TOKEN || supplied.length !== expected.length || !crypto.subtle.timingSafeEqual(supplied, expected) || request.method !== 'POST' || new URL(request.url).pathname !== '/verify') return new Response(null, { status: 404 });
    const registry = env.PROJECT_REGISTRY.getByName('projects');
    let state = await registry.proofState();
    try {
      if (!state) {
        const id = crypto.randomUUID(), origin = `https://${id}.example.test`, objectName = `source-${id}`, moveId = `move-${id}`;
        const owner = env.NEXTGEN_APPLICATION.getByName(objectName);
        await registry.reserve(origin, objectName);
        const { projectId } = await owner.provision('Synthetic REAL proof', origin, { projectId: null, origin, objectName, generation: 1 });
        await registry.activate(origin, objectName, projectId);
        const { userId } = await owner.addUser('real@example.test', 'Synthetic-password-123!', { projectId, origin, objectName, generation: 1 });
        await owner.seedRealValues(projectId, userId);
        const rows = await owner.realValues(projectId, userId);
        check(JSON.stringify(rows.map(row => [row.kind, row.value])) === JSON.stringify([['real','finite'], ['real','negative'], ['null','null'], ['real','positive']]), 'Source REAL fixture differs');
        state = { origin, objectName, projectId, userId, moveId, rows, advances: 0, stage: 'move' };
      } else if (state.stage === 'move') {
        check(++state.advances <= 10000, 'Synthetic proof exceeded advance limit');
        const coordinator = env.RELOCATION_COORDINATOR.getByName('coordinator');
        try {
          const progress = await coordinator.advance(env.MAPI_RELOCATION_CONTROL_TOKEN, state.origin, state.projectId, state.moveId);
          check(!progress.done, 'Move cut over without archive authority');
        } catch (error) {
          if (!String(error).includes('independent archive proof is not configured')) throw error;
          const status = await registry.relocationStatus(env.MAPI_RELOCATION_CONTROL_TOKEN, state.projectId);
          const proofs = await registry.relocationProofs(env.MAPI_RELOCATION_CONTROL_TOKEN, state.projectId, state.moveId);
          const source = env.NEXTGEN_APPLICATION.getByName(state.objectName);
          const target = env.NEXTGEN_APPLICATION.getByName(status.move.destination_object);
          check((await registry.resolve(state.origin)).state === 'moving' && proofs.source.state === 'frozen' && proofs.destination.state === 'staged' && proofs.source.digest === proofs.destination.digest, 'Archive gate changed authority');
          check(JSON.stringify(await source.realValues(state.projectId, state.userId)) === JSON.stringify(state.rows) && JSON.stringify(await target.realValues(state.projectId, state.userId)) === JSON.stringify(state.rows), 'Transferred REAL values differ');
          state.stage = 'complete';
        }
      }
      await registry.saveProofState(state);
      return Response.json({ stage: state.stage, advances: state.advances, done: state.stage === 'complete' });
    } catch (error) {
      console.error('Synthetic REAL owner proof failed', state?.stage ?? 'provision', error?.message);
      return Response.json({ done: false, stage: state?.stage ?? 'provision' }, { status: 500 });
    }
  },
};
