// Synthetic capacity proof. Deploy only with fresh, isolated DO namespaces.
// Each request performs one bounded seed batch or one relocation advance.
import { NextgenApplication, ProjectRegistry as BaseRegistry } from '../worker/phase1-owner.js';
import { invalidateTextPreflightMarker } from '../worker/relocation-text-marker.js';

const ROWS = 2000;
const BATCH = 100;
const VALUE_BYTES = 1024;
const LARGE_BYTES = 8300000;
const largeText = () => 'z' + '😀'.repeat(2074999) + 'xyz';
const key = i => `capacity-${String(i).padStart(6, '0')}`;
const check = (condition, message) => { if (!condition) throw Error(message); };

export class CapacityRegistry extends BaseRegistry {
  proofState() { return this.ctx.storage.kv.get('synthetic-capacity-proof') ?? null; }
  saveProofState(value) { this.ctx.storage.kv.put('synthetic-capacity-proof', value); }
}

export class CapacityOwner extends NextgenApplication {
  seedBatch(projectId, userId, start) {
    if (!Number.isInteger(start) || start < 0 || start >= ROWS || start % BATCH) throw Error('Invalid seed cursor');
    return this.ctx.storage.transactionSync(() => {
      invalidateTextPreflightMarker(this.ctx.storage);
      const sql = this.ctx.storage.sql;
      for (let i = start; i < Math.min(start + BATCH, ROWS); i++) {
        sql.exec('INSERT INTO user_attributes (project_id, user_id, key, value) VALUES (?, ?, ?, ?)', projectId, userId, key(i), 'x'.repeat(VALUE_BYTES));
      }
      return Math.min(start + BATCH, ROWS);
    });
  }

  seedLarge(projectId, userId) {
    return this.ctx.storage.transactionSync(() => {
      invalidateTextPreflightMarker(this.ctx.storage);
      this.ctx.storage.sql.exec('INSERT INTO user_attributes (project_id, user_id, key, value) VALUES (?, ?, ?, ?)', projectId, userId, 'capacity-large', largeText());
    });
  }

  snapshot(projectId, userId) {
    return this.ctx.storage.sql.exec(`SELECT COUNT(*) AS count,
      COALESCE(SUM(length(CAST(value AS BLOB))),0) AS bytes,
      COALESCE(SUM(CASE WHEN key = 'capacity-large' AND typeof(value) = 'text' AND length(CAST(value AS BLOB)) = ? AND value = ? THEN 1 ELSE 0 END),0) AS large_matches,
      COALESCE(SUM(CASE WHEN key <> 'capacity-large' AND typeof(value) = 'text' AND value = ? THEN 1 ELSE 0 END),0) AS small_matches
      FROM user_attributes WHERE project_id = ? AND user_id = ? AND key GLOB 'capacity-*'`,
      LARGE_BYTES, largeText(), 'x'.repeat(VALUE_BYTES), projectId, userId).one();
  }
  fence() { return this.ctx.storage.sql.exec('SELECT project_id, origin, object_name, generation, state, move_id FROM mapi_owner_fence LIMIT 2').toArray(); }
}

const encoder = new TextEncoder();
export default {
  async fetch(request, env) {
    const provided = encoder.encode(request.headers.get('authorization') ?? '');
    const expected = encoder.encode(`Bearer ${env.MAPI_STAGING_PROOF_TOKEN ?? ''}`);
    if (!env.MAPI_STAGING_PROOF_TOKEN || provided.length !== expected.length || !crypto.subtle.timingSafeEqual(provided, expected) || request.method !== 'POST' || new URL(request.url).pathname !== '/verify') return new Response(null, { status: 404 });
    const registry = env.PROJECT_REGISTRY.getByName('projects');
    const secret = env.MAPI_RELOCATION_CONTROL_TOKEN;
    let state = await registry.proofState();
    const stage = state?.stage ?? 'provision';
    try {
      if (!state) {
        const run = crypto.randomUUID();
        const origin = `https://${run}.example.test`, objectName = `capacity-${run}`, moveId = `capacity-${run}`;
        const owner = env.NEXTGEN_APPLICATION.getByName(objectName);
        await registry.reserve(origin, objectName);
        const { projectId } = await owner.provision('Synthetic capacity', origin, { projectId: null, origin, objectName, generation: 1 });
        await registry.activate(origin, objectName, projectId);
        const route = { projectId, origin, objectName, generation: 1 };
        const { userId } = await owner.addUser('capacity@example.test', 'Synthetic-password-123!', route);
        state = { stage: 'seed', origin, objectName, moveId, projectId, userId, seeded: 0, pages: 0, largePages: 0, maxOffset: 0 };
      } else {
        const { origin, objectName, moveId, projectId, userId } = state;
        const owner = env.NEXTGEN_APPLICATION.getByName(objectName);
        if (stage === 'seed') {
          state.seeded = await owner.seedBatch(projectId, userId, state.seeded);
          if (state.seeded === ROWS) state.stage = 'seed-large';
        } else if (stage === 'seed-large') {
          await owner.seedLarge(projectId, userId);
          const snapshot = await owner.snapshot(projectId, userId);
          check(snapshot.count === ROWS + 1 && snapshot.bytes === ROWS * VALUE_BYTES + LARGE_BYTES && snapshot.large_matches === 1 && snapshot.small_matches === ROWS, 'Synthetic seed differs');
          state.before = snapshot;
          state.stage = 'preflight';
        } else if (stage === 'preflight') {
          check(++state.pages <= 20000, 'Capacity page budget exceeded');
          const move = await registry.beginRelocation(secret, origin, projectId, moveId);
          if (move.phase === 'preflighting') {
            const checkpoint = await registry.relocationTextPreflightStatus(secret, projectId, moveId);
            if (checkpoint?.cursor?.length === LARGE_BYTES && checkpoint.cursor.offset > 0) {
              check(checkpoint.cursor.offset > state.maxOffset, 'Large TEXT cursor did not advance');
              state.largePages++;
              state.maxOffset = checkpoint.cursor.offset;
            }
            const status = await registry.relocationStatus(secret, projectId);
            check(status.route?.state === 'active' && !status.move, 'Source was frozen before preflight completed');
          } else {
            check(move.phase === 'moving' && state.largePages >= 2, 'Large TEXT did not span scan pages');
            const fence = await owner.fence();
            check(fence.length === 1 && fence[0].state === 'frozen' && fence[0].move_id === moveId, 'Source fence differs');
            state.stage = 'manifest';
          }
        } else if (stage === 'manifest') {
          const manifest = await owner.relocationManifest(secret, projectId, moveId);
          check(manifest.projectId === projectId && manifest.moveId === moveId && manifest.tables.includes('user_attributes'), 'Frozen source manifest differs');
          const after = await owner.snapshot(projectId, userId);
          check(JSON.stringify(after) === JSON.stringify(state.before), 'Synthetic source data changed');
          state.stage = 'complete';
        } else if (stage !== 'complete') throw Error('Unknown synthetic capacity stage');
      }
      await registry.saveProofState(state);
      return Response.json({ stage: state.stage, done: state.stage === 'complete', seeded: state.seeded, pages: state.pages, largePages: state.largePages });
    } catch (error) {
      console.error('Synthetic capacity proof failed', stage, error?.message);
      return Response.json({ done: false, stage }, { status: 500 });
    }
  },
};
