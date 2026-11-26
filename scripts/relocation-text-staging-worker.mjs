// Synthetic-only staging proof. Each request advances at most one scan,
// transfer, history, or reconciliation page in fresh staging namespaces.
import { NextgenApplication, ProjectRegistry as BaseRegistry } from '../worker/phase1-owner.js';
import { invalidateTextPreflightMarker, readTextPreflightMarker } from '../worker/relocation-text-marker.js';

export class ProjectRegistry extends BaseRegistry {
  seedExistingIntentForTest(origin, projectId, moveId) {
    const route = this.resolve(origin);
    if (!route || route.state !== 'active' || route.project_id !== projectId) throw Error('Invalid synthetic route');
    this.ctx.storage.sql.exec('INSERT INTO mapi_move_intents VALUES (?, ?, ?, ?, ?, ?)', projectId, moveId, origin, route.object_name, `project:${crypto.randomUUID()}`, route.generation);
  }
  proofState() { return this.ctx.storage.kv.get('synthetic-text-proof') ?? null; }
  saveProofState(value) { this.ctx.storage.kv.put('synthetic-text-proof', value); }
}

export class RelocationTextStagingOwner extends NextgenApplication {
  proofBoot = crypto.randomUUID();
  proofBootId() { return this.proofBoot; }
  evictProof() { this.ctx.abort('synthetic preflight eviction'); }
  proofMarker() { return readTextPreflightMarker(this.ctx.storage); }
  proofFence() { return this.ctx.storage.sql.exec('SELECT * FROM mapi_owner_fence LIMIT 2').toArray(); }
  addTextFixture(projectId, userId) {
    this.ctx.storage.transactionSync(() => {
      invalidateTextPreflightMarker(this.ctx.storage);
      const sql = this.ctx.storage.sql;
      sql.exec("INSERT INTO user_attributes (project_id, user_id, key, value) VALUES (?, ?, 'utf8-valid', ?)", projectId, userId, '"é😀�"');
      sql.exec("INSERT INTO user_attributes (project_id, user_id, key, value) VALUES (?, ?, 'utf8-invalid', CAST(X'228022' AS TEXT))", projectId, userId);
      sql.exec("INSERT INTO user_attributes (project_id, user_id, key, value) VALUES (?, ?, 'utf8-large', ?)", projectId, userId, '"' + 'é'.repeat(262144) + '"');
    });
  }
  removeInvalidTextFixture(projectId, userId) {
    this.ctx.storage.transactionSync(() => {
      invalidateTextPreflightMarker(this.ctx.storage);
      this.ctx.storage.sql.exec("DELETE FROM user_attributes WHERE project_id = ? AND user_id = ? AND key = 'utf8-invalid'", projectId, userId);
    });
  }
  textFixtureState(projectId, userId) {
    return this.ctx.storage.sql.exec("SELECT key, hex(value) AS bytes FROM user_attributes WHERE project_id = ? AND user_id = ? AND key <> 'utf8-large' ORDER BY key", projectId, userId).toArray();
  }
  largeTextLength(projectId, userId) {
    return this.ctx.storage.sql.exec("SELECT length(CAST(value AS BLOB)) AS bytes FROM user_attributes WHERE project_id = ? AND user_id = ? AND key = 'utf8-large'", projectId, userId).one().bytes;
  }
  largeTextMatches(projectId, userId) {
    return this.ctx.storage.sql.exec("SELECT value = ? AS matches FROM user_attributes WHERE project_id = ? AND user_id = ? AND key = 'utf8-large'", '"' + 'é'.repeat(262144) + '"', projectId, userId).one().matches === 1;
  }
}

const encode = new TextEncoder();
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const check = (condition, message) => { if (!condition) throw Error(message); };

export default {
  async fetch(request, env) {
    const provided = encode.encode(request.headers.get('authorization') ?? '');
    const expected = encode.encode(`Bearer ${env.MAPI_STAGING_PROOF_TOKEN ?? ''}`);
    if (!env.MAPI_STAGING_PROOF_TOKEN || provided.length !== expected.length || !crypto.subtle.timingSafeEqual(provided, expected) || request.method !== 'POST' || new URL(request.url).pathname !== '/verify') return new Response(null, { status: 404 });
    const registry = env.PROJECT_REGISTRY.getByName('projects');
    const secret = env.MAPI_RELOCATION_CONTROL_TOKEN;
    let state = await registry.proofState();
    let stage = state?.stage ?? 'provision';
    try {
      if (!state) {
        const run = crypto.randomUUID();
        const origin = `https://${run}.example.test`, objectName = `source-${run}`, moveId = `move-${run}`;
        const owner = env.NEXTGEN_APPLICATION.getByName(objectName);
        await registry.reserve(origin, objectName);
        const { projectId } = await owner.provision('Synthetic TEXT staging proof', origin, { projectId: null, origin, objectName, generation: 1 });
        await registry.activate(origin, objectName, projectId);
        const route = { projectId, origin, objectName, generation: 1 };
        const { userId } = await owner.addUser('fixture@example.test', 'Synthetic-password-123!', route);
        await registry.seedExistingIntentForTest(origin, projectId, moveId);
        state = { stage: 'first-page', origin, objectName, moveId, projectId, userId, steps: 0 };
      } else {
        check(++state.steps <= 20000, 'Synthetic proof exceeded step budget');
        const { origin, objectName, moveId, projectId, userId } = state;
        const route = { projectId, origin, objectName, generation: 1 };
        const owner = env.NEXTGEN_APPLICATION.getByName(objectName);
        const advance = () => registry.beginRelocation(secret, origin, projectId, moveId);
        if (stage === 'first-page') {
          const move = await advance();
          const checkpoint = await registry.relocationTextPreflightStatus(secret, projectId, moveId);
          check(move.phase === 'preflighting' && checkpoint && !checkpoint.done, 'Expected an intermediate checkpoint');
          state.checkpoint = checkpoint;
          state.boot = await owner.proofBootId();
          try { await owner.evictProof(); } catch {}
          state.stage = 'eviction';
        } else if (stage === 'eviction') {
          check(await owner.proofBootId() !== state.boot, 'Owner eviction was not observed');
          check(same(await registry.relocationTextPreflightStatus(secret, projectId, moveId), state.checkpoint), 'Eviction changed checkpoint');
          check(await owner.proofMarker() === state.checkpoint.marker, 'Eviction changed marker');
          const move = await advance();
          check(move.phase === 'preflighting', 'Unexpected preflight phase');
          state.previousMarker = state.checkpoint.marker;
          state.stage = 'mutation';
        } else if (stage === 'mutation') {
          await owner.addUser('mutation@example.test', 'Synthetic-password-123!', route);
          check(await owner.proofMarker() === null, 'Go mutation did not invalidate marker');
          state.stage = 'restart-scan';
        } else if (stage === 'restart-scan') {
          const move = await advance();
          const checkpoint = await registry.relocationTextPreflightStatus(secret, projectId, moveId);
          check(move.phase === 'preflighting', 'Unexpected preflight response after mutation');
          if (checkpoint) {
            check(checkpoint.marker !== state.previousMarker, 'Scan did not restart after mutation');
            await owner.addTextFixture(projectId, userId);
            state.before = await owner.textFixtureState(projectId, userId);
            check(await owner.largeTextLength(projectId, userId) === 524290 && await owner.largeTextMatches(projectId, userId), 'Large TEXT fixture differs');
            check(state.before.some(row => row.key === 'utf8-invalid' && row.bytes === '228022') && state.before.some(row => row.key === 'utf8-valid' && row.bytes === '22C3A9F09F9880EFBFBD22'), 'Fixture bytes differ');
            state.stage = 'invalid-text';
          }
        } else if (stage === 'invalid-text') {
          let rejected = false;
          const beforeStatus = await registry.relocationStatus(secret, projectId);
          const beforeCheckpoint = await registry.relocationTextPreflightStatus(secret, projectId, moveId);
          const beforeFence = await owner.proofFence();
          try { const move = await advance(); check(move.phase === 'preflighting', 'Invalid TEXT reached freeze'); }
          catch (error) { if (!String(error).includes('Invalid UTF-8 TEXT')) throw error; rejected = true; }
          if (rejected) {
            const status = await registry.relocationStatus(secret, projectId);
            check(status.route?.state === 'active' && status.intent?.move_id === moveId && !status.move &&
              same(status, beforeStatus) && same(beforeCheckpoint, await registry.relocationTextPreflightStatus(secret, projectId, moveId)) &&
              same(beforeFence, await owner.proofFence()) && same(state.before, await owner.textFixtureState(projectId, userId)) &&
              await owner.largeTextMatches(projectId, userId), 'Rejection changed source, route, checkpoint, or fence');
            await owner.addUser('still-active@example.test', 'Synthetic-password-123!', route);
            await owner.removeInvalidTextFixture(projectId, userId);
            state.stage = 'valid-text';
          }
        } else if (stage === 'valid-text') {
          const move = await advance();
          if (move.phase === 'moving') {
            check(state.largePartial, 'Large TEXT was not scanned across pages');
            state.destination = move.destination_object; state.stage = 'prepare';
          }
          else check(move.phase === 'preflighting', 'Unexpected preflight response');
          if (move.phase === 'preflighting') {
            const checkpoint = await registry.relocationTextPreflightStatus(secret, projectId, moveId);
            if (checkpoint?.cursor?.length === 524290 && checkpoint.cursor.offset > 0 && checkpoint.cursor.offset < 524290) state.largePartial = true;
          }
        } else if (stage === 'prepare') {
          const target = env.NEXTGEN_APPLICATION.getByName(state.destination);
          await target.reserveMoveDestination(secret, { ...route, objectName: state.destination, generation: 2 }, moveId);
          await target.prepareRelocation(secret, projectId, moveId);
          await owner.beginRelocationExport(secret, projectId, moveId);
          await target.beginRelocationImport(secret, projectId, moveId);
          state.stage = 'import';
        } else if (stage === 'import') {
          const target = env.NEXTGEN_APPLICATION.getByName(state.destination);
          const checkpoint = await target.relocationImportStatus(secret, projectId, moveId);
          if (!checkpoint.done) await target.importRelocationChunk(secret, projectId, moveId, checkpoint.next_chunk);
          else {
            await target.restoreRelocationMetadata(secret, projectId, moveId);
            check(same(await target.textFixtureState(projectId, userId), await owner.textFixtureState(projectId, userId)), 'Destination bytes differ');
            check(await target.largeTextLength(projectId, userId) === 524290 && await target.largeTextMatches(projectId, userId), 'Destination large TEXT differs');
            state.stage = 'history';
          }
        } else if (stage === 'history') {
          if ((await registry.verifyRelocationHistory(secret, projectId, moveId)).done) state.stage = 'reconcile';
        } else if (stage === 'reconcile') {
          if ((await registry.reconcileRelocation(secret, projectId, moveId)).done) state.stage = 'archive-gate';
        } else if (stage === 'archive-gate') {
          let blocked = false;
          try { await registry.commitRelocation(secret, projectId, moveId); }
          catch (error) { if (!String(error).includes('independent archive proof is not configured')) throw error; blocked = true; }
          check(blocked && (await registry.resolve(origin)).state === 'moving', 'Archive gate did not preserve the staged route');
          state.stage = 'complete';
        } else if (stage !== 'complete') throw Error('Unknown synthetic proof stage');
      }
      await registry.saveProofState(state);
      return Response.json({ done: state.stage === 'complete', stage: state.stage });
    } catch (error) {
      console.error(`Synthetic TEXT staging proof failed during ${stage}`, error?.message);
      return Response.json({ done: false, stage }, { status: 500 });
    }
  },
};
