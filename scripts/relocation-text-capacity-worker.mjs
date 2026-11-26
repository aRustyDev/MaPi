// Synthetic capacity proof. Deploy only with fresh, isolated DO namespaces.
// Each request performs one bounded seed batch or one relocation advance.
import { NextgenApplication, ProjectRegistry as BaseRegistry } from '../worker/phase1-owner.js';
import { invalidateTextPreflightMarker } from '../worker/relocation-text-marker.js';
import { validateRelocationSourceSchema } from '../worker/relocation-manifest.js';
import { RELOCATION_TEXT_PREFLIGHT_VERSION } from '../worker/relocation-text-preflight.js';

const ROWS = 2000;
const BATCH = 100;
const VALUE_BYTES = 1024;
const LARGE_BYTES = 8300000;
const OVERSIZED_BYTES = 8388609;
const largeText = () => 'z' + '😀'.repeat(2074999) + 'xyz';
const key = i => `capacity-${String(i).padStart(6, '0')}`;
const boundedKey = 'capacity-' + 'k'.repeat(991);
const check = (condition, message) => { if (!condition) throw Error(message); };
const rejectsWith = async (action, message) => {
  try { await action(); } catch (error) { if (String(error).includes(message)) return; throw error; }
  throw Error(`Expected rejection: ${message}`);
};

export class CapacityRegistry extends BaseRegistry {
  // This isolated synthetic worker models a relocation intent persisted by an
  // earlier version. The production registry has no such fixture method.
  seedExistingIntentForTest(origin, projectId, moveId) {
    const route = this.resolve(origin);
    if (!route || route.state !== 'active' || route.project_id !== projectId) throw Error('Invalid synthetic route');
    this.ctx.storage.sql.exec('INSERT INTO mapi_move_intents VALUES (?, ?, ?, ?, ?, ?)', projectId, moveId, origin, route.object_name, `project:${crypto.randomUUID()}`, route.generation);
  }
  proofState() { return this.ctx.storage.kv.get('synthetic-capacity-proof') ?? null; }
  saveProofState(value) { this.ctx.storage.kv.put('synthetic-capacity-proof', value); }
  testCheckpoint(projectId, moveId) {
    return this.ctx.storage.sql.exec('SELECT * FROM mapi_move_text_preflight WHERE project_id = ? AND move_id = ?', projectId, moveId).one();
  }
  testSetCheckpoint(projectId, moveId, cursor, done) {
    this.ctx.storage.sql.exec('UPDATE mapi_move_text_preflight SET cursor = ?, done = ? WHERE project_id = ? AND move_id = ?', cursor, done, projectId, moveId);
  }
  async testLegacyCheckpoints(secret, origin, projectId, moveId) {
    const sql = this.ctx.storage.sql;
    const original = sql.exec('SELECT * FROM mapi_move_text_preflight WHERE project_id = ? AND move_id = ?', projectId, moveId).one();
    for (const [version, done] of [[1, 0], [1, 1], [2, 0], [2, 1]]) {
      const cursor = JSON.parse(original.cursor);
      cursor.version = version;
      cursor.done = Boolean(done);
      delete cursor.cursorBytes;
      if (version === 1) delete cursor.rowBytes;
      sql.exec('UPDATE mapi_move_text_preflight SET cursor = ?, done = ? WHERE project_id = ? AND move_id = ?', JSON.stringify(cursor), done, projectId, moveId);
      try {
        this.relocationTextPreflightStatus(secret, projectId, moveId);
        throw Error('Legacy checkpoint was accepted');
      } catch (error) {
        if (!String(error).includes('Legacy TEXT preflight requires manual review')) throw error;
      }
      const row = sql.exec('SELECT cursor, done, revision FROM mapi_move_text_preflight WHERE project_id = ? AND move_id = ?', projectId, moveId).one();
      check(row.cursor === JSON.stringify(cursor) && row.done === done && row.revision === original.revision, 'Legacy rejection changed checkpoint');
    }
    sql.exec('UPDATE mapi_move_text_preflight SET cursor = ?, done = ? WHERE project_id = ? AND move_id = ?', original.cursor, original.done, projectId, moveId);
    return true;
  }
}

export class CapacityOwner extends NextgenApplication {
  textPreflightTableCount(route) { return validateRelocationSourceSchema(this.ctx.storage, route, { textGuard: true }).length; }
  #profileBoot = crypto.randomUUID();
  async holdForSyntheticMemorySample() {
    const boot = this.#profileBoot;
    await new Promise(resolve => setTimeout(resolve, 120000));
    return { sameBoot: boot === this.#profileBoot };
  }

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
      this.ctx.storage.sql.exec('INSERT INTO user_attributes (project_id, user_id, key, value) VALUES (?, ?, ?, ?)', projectId, userId, boundedKey, 'x'.repeat(VALUE_BYTES));
    });
  }

  seedOversized(projectId, userId) {
    return this.ctx.storage.transactionSync(() => {
      invalidateTextPreflightMarker(this.ctx.storage);
      this.ctx.storage.sql.exec('INSERT INTO user_attributes (project_id, user_id, key, value) VALUES (?, ?, ?, ?)', projectId, userId, 'oversized', 'x'.repeat(OVERSIZED_BYTES));
    });
  }
  oversizedMatches(projectId, userId) {
    return this.ctx.storage.sql.exec("SELECT typeof(value) = 'text' AND length(CAST(value AS BLOB)) = ? AND value = ? AS matches FROM user_attributes WHERE project_id = ? AND user_id = ? AND key = 'oversized'", OVERSIZED_BYTES, 'x'.repeat(OVERSIZED_BYTES), projectId, userId).one().matches === 1;
  }
  oversizedAbsent(projectId, userId) {
    return this.ctx.storage.sql.exec("SELECT COUNT(*) AS count FROM user_attributes WHERE project_id = ? AND user_id = ? AND key = 'oversized'", projectId, userId).one().count === 0;
  }
  replaceOversizedWithLongKey(projectId, userId) {
    this.ctx.storage.transactionSync(() => {
      invalidateTextPreflightMarker(this.ctx.storage);
      const sql = this.ctx.storage.sql;
      sql.exec("DELETE FROM user_attributes WHERE project_id = ? AND user_id = ? AND key = 'oversized'", projectId, userId);
      sql.exec('INSERT INTO user_attributes (project_id, user_id, key, value) VALUES (?, ?, ?, ?)', projectId, userId, 'K'.repeat(100_000), 'synthetic');
    });
  }
  longKeyMatches(projectId, userId) {
    return this.ctx.storage.sql.exec("SELECT value = 'synthetic' AS matches FROM user_attributes WHERE project_id = ? AND user_id = ? AND key = ?", projectId, userId, 'K'.repeat(100_000)).one().matches === 1;
  }
  replaceLongKeyWithNonfinite(projectId, userId) {
    this.ctx.storage.transactionSync(() => {
      invalidateTextPreflightMarker(this.ctx.storage);
      const sql = this.ctx.storage.sql;
      sql.exec('DELETE FROM user_attributes WHERE project_id = ? AND user_id = ? AND key = ?', projectId, userId, 'K'.repeat(100_000));
      sql.exec('UPDATE users SET updated_at = 1e999 WHERE project_id = ? AND id = ?', projectId, userId);
    });
  }
  nonfiniteMatches(projectId, userId) {
    return this.ctx.storage.sql.exec("SELECT typeof(updated_at) = 'real' AND updated_at > 1.7976931348623157e308 AS matches FROM users WHERE project_id = ? AND id = ?", projectId, userId).one().matches === 1;
  }

  snapshot(projectId, userId) {
    return this.ctx.storage.sql.exec(`SELECT COUNT(*) AS count,
      COALESCE(SUM(length(CAST(value AS BLOB))),0) AS bytes,
      COALESCE(SUM(CASE WHEN key = 'capacity-large' AND typeof(value) = 'text' AND length(CAST(value AS BLOB)) = ? AND value = ? THEN 1 ELSE 0 END),0) AS large_matches,
      COALESCE(SUM(CASE WHEN key = ? AND value = ? THEN 1 ELSE 0 END),0) AS bounded_key_matches,
      COALESCE(SUM(CASE WHEN key <> 'capacity-large' AND typeof(value) = 'text' AND value = ? THEN 1 ELSE 0 END),0) AS small_matches
      FROM user_attributes WHERE project_id = ? AND user_id = ? AND key GLOB 'capacity-*'`,
      LARGE_BYTES, largeText(), boundedKey, 'x'.repeat(VALUE_BYTES), 'x'.repeat(VALUE_BYTES), projectId, userId).one();
  }
  fence() { return this.ctx.storage.sql.exec('SELECT project_id, origin, object_name, generation, state, move_id FROM mapi_owner_fence LIMIT 2').toArray(); }
  syntheticBusinessState() {
    const sql = this.ctx.storage.sql;
    return { users: sql.exec('SELECT COUNT(*) AS count FROM users').one().count, events: sql.exec('SELECT COUNT(*) AS count FROM events').one().count };
  }
}

const encoder = new TextEncoder();
export default {
  async fetch(request, env) {
    const provided = encoder.encode(request.headers.get('authorization') ?? '');
    const expected = encoder.encode(`Bearer ${env.MAPI_STAGING_PROOF_TOKEN ?? ''}`);
    if (!env.MAPI_STAGING_PROOF_TOKEN || provided.length !== expected.length || !crypto.subtle.timingSafeEqual(provided, expected)) return new Response(null, { status: 404 });
    const registry = env.PROJECT_REGISTRY.getByName('projects');
    if (request.method === 'GET' && new URL(request.url).pathname === '/profile-hold') {
      const state = await registry.proofState();
      const which = new URL(request.url).searchParams.get('which');
      if (!state?.objectName || !['source', 'destination'].includes(which) || which === 'destination' && !state.destination) return new Response(null, { status: 404 });
      const objectName = which === 'source' ? state.objectName : state.destination;
      return Response.json(await env.NEXTGEN_APPLICATION.getByName(objectName).holdForSyntheticMemorySample());
    }
    if (request.method === 'GET' && new URL(request.url).pathname === '/profile-target') {
      const state = await registry.proofState();
      if (!state?.objectName) return new Response(null, { status: 404 });
      return Response.json({
        sourceObjectId: env.NEXTGEN_APPLICATION.idFromName(state.objectName).toString(),
        destinationObjectId: state.destination ? env.NEXTGEN_APPLICATION.idFromName(state.destination).toString() : null,
      });
    }
    if (request.method !== 'POST' || new URL(request.url).pathname !== '/verify') return new Response(null, { status: 404 });
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
        const { userId: nearUserId } = await owner.addUser('near-handler@example.test', 'Synthetic-password-123!', route);
        state = { stage: 'seed', origin, objectName, moveId, projectId, userId, nearUserId, seeded: 0, pages: 0, largePages: 0, maxOffset: 0 };
      } else {
        const { origin, objectName, moveId, projectId, userId } = state;
        const owner = env.NEXTGEN_APPLICATION.getByName(objectName);
        if (stage === 'seed') {
          state.seeded = await owner.seedBatch(projectId, userId, state.seeded);
          if (state.seeded === ROWS) state.stage = 'seed-large';
        } else if (stage === 'seed-large') {
          await owner.seedLarge(projectId, userId, state.nearUserId);
          const snapshot = await owner.snapshot(projectId, userId, state.nearUserId);
          check(snapshot.count === ROWS + 2 && snapshot.bytes === (ROWS + 1) * VALUE_BYTES + LARGE_BYTES && snapshot.large_matches === 1 && snapshot.bounded_key_matches === 1 && snapshot.small_matches === ROWS + 1, 'Synthetic seed differs');
          state.before = snapshot;
          const runtime = await owner.status(false, { projectId, origin, objectName, generation: 1 });
          check(runtime.wasmMemoryBytes > 0 && runtime.reactorInitializations > 0, 'Synthetic source Go reactor is not initialized');
          state.sourceRuntimeInitializations = runtime.reactorInitializations;
          state.sourceWasmBeforeFreeze = runtime.wasmMemoryBytes;
          const beforeStatus = await registry.relocationStatus(secret, projectId), beforeFence = await owner.fence();
          await rejectsWith(() => registry.beginRelocation(secret, origin, projectId, moveId), 'Relocation admission unavailable');
          check(JSON.stringify(beforeStatus) === JSON.stringify(await registry.relocationStatus(secret, projectId)) &&
            JSON.stringify(beforeFence) === JSON.stringify(await owner.fence()) &&
            JSON.stringify(snapshot) === JSON.stringify(await owner.snapshot(projectId, userId, state.nearUserId)), 'Rejected admission changed synthetic source');
          await registry.seedExistingIntentForTest(origin, projectId, moveId);
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
            const runtime = await owner.status(false, { projectId, origin, objectName, generation: 1 });
            check(runtime.wasmMemoryBytes === 0 && runtime.reactorInitializations === state.sourceRuntimeInitializations, 'Frozen source retained or restarted Go reactor');
            state.sourceRuntimeReleased = true;
            state.destination = move.destination_object;
            state.stage = 'manifest';
          }
        } else if (stage === 'manifest') {
          const manifest = await owner.relocationManifest(secret, projectId, moveId);
          check(manifest.projectId === projectId && manifest.moveId === moveId && manifest.tables.includes('user_attributes'), 'Frozen source manifest differs');
          const after = await owner.snapshot(projectId, userId, state.nearUserId);
          check(JSON.stringify(after) === JSON.stringify(state.before), 'Synthetic source data changed');
          state.legacyStep = 0;
          state.stage = 'legacy-frozen';
        } else if (stage === 'legacy-frozen') {
          const original = await registry.testCheckpoint(projectId, moveId);
          const cursor = JSON.parse(original.cursor);
          cursor.version = state.legacyStep < 2 ? 1 : 2;
          cursor.done = state.legacyStep % 2 === 1;
          delete cursor.cursorBytes;
          if (cursor.version === 1) delete cursor.rowBytes;
          const legacy = JSON.stringify(cursor), done = state.legacyStep % 2;
          const status = await registry.relocationStatus(secret, projectId), fence = await owner.fence();
          await registry.testSetCheckpoint(projectId, moveId, legacy, done);
          await rejectsWith(() => owner.relocationManifest(secret, projectId, moveId), 'Legacy TEXT preflight requires manual review');
          await rejectsWith(() => owner.beginRelocationExport(secret, projectId, moveId), 'Legacy TEXT preflight requires manual review');
          const after = await registry.testCheckpoint(projectId, moveId);
          check(after.cursor === legacy && after.done === done && after.revision === original.revision &&
            JSON.stringify(status) === JSON.stringify(await registry.relocationStatus(secret, projectId)) &&
            JSON.stringify(fence) === JSON.stringify(await owner.fence()) && JSON.stringify(state.before) === JSON.stringify(await owner.snapshot(projectId, userId, state.nearUserId)), 'Frozen legacy rejection changed state');
          await registry.testSetCheckpoint(projectId, moveId, original.cursor, original.done);
          state.legacyStep++;
          if (state.legacyStep === 4) { state.frozenLegacyRejected = true; state.stage = 'prepare'; }
        } else if (stage === 'prepare') {
          const target = env.NEXTGEN_APPLICATION.getByName(state.destination);
          const route = { projectId, origin, objectName: state.destination, generation: 2 };
          await target.reserveMoveDestination(secret, route, moveId);
          await target.prepareRelocation(secret, projectId, moveId);
          await owner.beginRelocationExport(secret, projectId, moveId);
          await target.beginRelocationImport(secret, projectId, moveId);
          state.stage = 'import';
        } else if (stage === 'import') {
          const target = env.NEXTGEN_APPLICATION.getByName(state.destination);
          const checkpoint = await target.relocationImportStatus(secret, projectId, moveId);
          if (!checkpoint.done) {
            check(checkpoint.next_chunk < 20000, 'Capacity transfer budget exceeded');
            await target.importRelocationChunk(secret, projectId, moveId, checkpoint.next_chunk);
          } else {
            await target.restoreRelocationMetadata(secret, projectId, moveId);
            const after = await target.snapshot(projectId, userId, state.nearUserId);
            check(JSON.stringify(after) === JSON.stringify(state.before), 'Synthetic destination data changed');
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
          state.stage = 'oversize-provision';
        } else if (stage === 'oversize-provision') {
          const run = crypto.randomUUID();
          const extraOrigin = `https://${run}.example.test`, extraName = `oversize-${run}`, extraMove = `oversize-${run}`;
          const extra = env.NEXTGEN_APPLICATION.getByName(extraName);
          await registry.reserve(extraOrigin, extraName);
          const { projectId: extraId } = await extra.provision('Synthetic oversize', extraOrigin, { projectId: null, origin: extraOrigin, objectName: extraName, generation: 1 });
          await registry.activate(extraOrigin, extraName, extraId);
          const route = { projectId: extraId, origin: extraOrigin, objectName: extraName, generation: 1 };
          const { userId: extraUser } = await extra.addUser('oversize@example.test', 'Synthetic-password-123!', route);
          state.oversize = { origin: extraOrigin, objectName: extraName, moveId: extraMove, projectId: extraId, userId: extraUser };
          state.stage = 'oversize-seed';
        } else if (stage === 'oversize-seed') {
          const item = state.oversize, extra = env.NEXTGEN_APPLICATION.getByName(item.objectName);
          try { await extra.seedOversized(item.projectId, item.userId); }
          catch (error) {
            if (!String(error).includes('SQLITE_TOOBIG') && !String(error).includes('string or blob too big')) throw error;
            check(await extra.oversizedAbsent(item.projectId, item.userId), 'Rejected oversized insert changed source data');
            state.oversizedRejected = true;
            state.oversizedUnavailable = true;
            state.stage = 'legacy-init';
          }
          if (state.oversizedUnavailable) {
            await registry.saveProofState(state);
            return Response.json({ stage: state.stage, done: false });
          }
          check(await extra.oversizedMatches(item.projectId, item.userId), 'Oversized fixture differs');
          state.oversize.fence = await extra.fence();
          await registry.seedExistingIntentForTest(item.origin, item.projectId, item.moveId);
          state.stage = 'oversize-preflight';
        } else if (stage === 'legacy-init') {
          const item = state.oversize;
          await registry.seedExistingIntentForTest(item.origin, item.projectId, item.moveId);
          const status = await registry.beginRelocation(secret, item.origin, item.projectId, item.moveId);
          check(status.phase === 'preflighting', 'Legacy fixture froze source');
          state.stage = 'legacy-checkpoint';
        } else if (stage === 'oversize-preflight') {
          const item = state.oversize, extra = env.NEXTGEN_APPLICATION.getByName(item.objectName);
          const prior = await registry.relocationTextPreflightStatus(secret, item.projectId, item.moveId).catch(() => null);
          const before = await registry.relocationStatus(secret, item.projectId);
          let rejected = false;
          try {
            const result = await registry.beginRelocation(secret, item.origin, item.projectId, item.moveId);
            check(result.phase === 'preflighting', 'Oversized source froze');
          } catch (error) {
            if (!['Row exceeds conservative SQLite size limit', 'TEXT preflight value exceeds SQLite limit', 'Row exceeds SQLite record size limit'].some(message => String(error).includes(message))) throw error;
            rejected = true;
          }
          if (rejected) {
            const after = await registry.relocationStatus(secret, item.projectId);
            check(after.route?.state === 'active' && !after.move && JSON.stringify(before) === JSON.stringify(after) &&
              JSON.stringify(prior) === JSON.stringify(await registry.relocationTextPreflightStatus(secret, item.projectId, item.moveId)) &&
              JSON.stringify(item.fence) === JSON.stringify(await extra.fence()) && await extra.oversizedMatches(item.projectId, item.userId), 'Oversized rejection changed state');
            state.oversizedRejected = true;
            state.stage = 'legacy-checkpoint';
          }
        } else if (stage === 'legacy-checkpoint') {
          const item = state.oversize, extra = env.NEXTGEN_APPLICATION.getByName(item.objectName);
          const status = await registry.relocationStatus(secret, item.projectId);
          const fence = await extra.fence();
          check(await registry.testLegacyCheckpoints(secret, item.origin, item.projectId, item.moveId), 'Legacy checkpoint test failed');
          check(JSON.stringify(status) === JSON.stringify(await registry.relocationStatus(secret, item.projectId)) &&
            JSON.stringify(fence) === JSON.stringify(await extra.fence()) && (state.oversizedUnavailable ? await extra.oversizedAbsent(item.projectId, item.userId) : await extra.oversizedMatches(item.projectId, item.userId)), 'Legacy rejection changed source or route');
          state.legacyRejected = true;
          state.stage = 'long-key-seed';
        } else if (stage === 'long-key-seed') {
          const item = state.oversize, extra = env.NEXTGEN_APPLICATION.getByName(item.objectName);
          await extra.replaceOversizedWithLongKey(item.projectId, item.userId);
          check(await extra.longKeyMatches(item.projectId, item.userId), 'Long key fixture differs');
          state.stage = 'long-key-preflight';
        } else if (stage === 'long-key-preflight' || stage === 'nonfinite-preflight') {
          const item = state.oversize, extra = env.NEXTGEN_APPLICATION.getByName(item.objectName);
          const prior = await registry.relocationTextPreflightStatus(secret, item.projectId, item.moveId);
          const before = await registry.relocationStatus(secret, item.projectId);
          const fence = await extra.fence();
          let rejected = false;
          try {
            const result = await registry.beginRelocation(secret, item.origin, item.projectId, item.moveId);
            check(result.phase === 'preflighting', 'Invalid fixture froze source');
          } catch (error) {
            const message = stage === 'long-key-preflight' ? 'Relocation primary key exceeds cursor limit' : 'Non-finite REAL is not supported by relocation';
            if (!String(error).includes(message)) throw error;
            rejected = true;
          }
          if (rejected) {
            const after = await registry.relocationStatus(secret, item.projectId);
            const preserved = stage === 'long-key-preflight' ? await extra.longKeyMatches(item.projectId, item.userId) : await extra.nonfiniteMatches(item.projectId, item.userId);
            check(after.route?.state === 'active' && !after.move && JSON.stringify(before) === JSON.stringify(after) &&
              JSON.stringify(prior) === JSON.stringify(await registry.relocationTextPreflightStatus(secret, item.projectId, item.moveId)) &&
              JSON.stringify(fence) === JSON.stringify(await extra.fence()) && preserved, 'Invalid fixture rejection changed state');
            if (stage === 'long-key-preflight') { state.longKeyRejected = true; state.stage = 'nonfinite-seed'; }
            else { state.nonfiniteRejected = true; state.stage = 'legacy-active-provision'; }
          }
        } else if (stage === 'nonfinite-seed') {
          const item = state.oversize, extra = env.NEXTGEN_APPLICATION.getByName(item.objectName);
          await extra.replaceLongKeyWithNonfinite(item.projectId, item.userId);
          check(await extra.nonfiniteMatches(item.projectId, item.userId), 'Non-finite fixture differs');
          state.stage = 'nonfinite-preflight';
        } else if (stage === 'legacy-active-provision') {
          const run = crypto.randomUUID();
          const legacyOrigin = `https://${run}.example.test`, legacyName = `legacy-${run}`, legacyMove = `legacy-${run}`;
          const legacyOwner = env.NEXTGEN_APPLICATION.getByName(legacyName);
          await registry.reserve(legacyOrigin, legacyName);
          const { projectId: legacyId } = await legacyOwner.provision('Synthetic legacy recovery', legacyOrigin, { projectId: null, origin: legacyOrigin, objectName: legacyName, generation: 1 });
          await registry.activate(legacyOrigin, legacyName, legacyId);
          const route = { projectId: legacyId, origin: legacyOrigin, objectName: legacyName, generation: 1 };
          await legacyOwner.addUser('legacy@example.test', 'Synthetic-password-123!', route);
          await registry.seedExistingIntentForTest(legacyOrigin, legacyId, legacyMove);
          state.legacyActive = { origin: legacyOrigin, objectName: legacyName, moveId: legacyMove, projectId: legacyId, step: 0, tableCount: await legacyOwner.textPreflightTableCount(route), fence: await legacyOwner.fence(), business: await legacyOwner.syntheticBusinessState() };
          state.stage = 'legacy-active-scan';
        } else if (stage === 'legacy-active-scan') {
          const item = state.legacyActive, legacyOwner = env.NEXTGEN_APPLICATION.getByName(item.objectName);
          const result = await registry.beginRelocation(secret, item.origin, item.projectId, item.moveId);
          check(result.phase === 'preflighting', 'Legacy test source did not remain active');
          const current = await registry.relocationTextPreflightStatus(secret, item.projectId, item.moveId);
          check(current && !current.done, 'Legacy test needs an intermediate checkpoint');
          if (item.step > 0) check(current.marker !== item.marker && current.cursor.version === RELOCATION_TEXT_PREFLIGHT_VERSION, 'Legacy recovery did not start a fresh scan');
          item.marker = current.marker;
          const version = item.step < 2 ? 1 : 2, done = item.step % 2 === 1;
          const cursor = { version, table: done ? item.tableCount : 0, after: null, row: null, column: 0, length: null, offset: 0, remaining: 0, minimum: 128, maximum: 191, done };
          // v2 is a synthetic reconstruction of the intermediate checkpoint.
          if (version === 2) cursor.rowBytes = 0;
          await registry.testSetCheckpoint(item.projectId, item.moveId, JSON.stringify(cursor), cursor.done ? 1 : 0);
          state.stage = 'legacy-active-reset';
        } else if (stage === 'legacy-active-reset') {
          const item = state.legacyActive, legacyOwner = env.NEXTGEN_APPLICATION.getByName(item.objectName);
          const result = await registry.beginRelocation(secret, item.origin, item.projectId, item.moveId);
          check(result.phase === 'preflighting' && await registry.relocationTextPreflightStatus(secret, item.projectId, item.moveId) === null, 'Legacy checkpoint was not reset');
          check(JSON.stringify(await legacyOwner.fence()) === JSON.stringify(item.fence) && JSON.stringify(await legacyOwner.syntheticBusinessState()) === JSON.stringify(item.business), 'Legacy reset changed source state');
          item.step++;
          if (item.step === 4) state.stage = 'legacy-active-finish';
          else state.stage = 'legacy-active-scan';
        } else if (stage === 'legacy-active-finish') {
          const item = state.legacyActive;
          const result = await registry.beginRelocation(secret, item.origin, item.projectId, item.moveId);
          const current = await registry.relocationTextPreflightStatus(secret, item.projectId, item.moveId);
          check(result.phase === 'preflighting' && current && current.cursor.version === RELOCATION_TEXT_PREFLIGHT_VERSION && current.marker !== item.marker, 'Final legacy reset did not start a fresh scan');
          state.legacyActiveRecovered = true;
          state.stage = 'complete';
        } else if (stage !== 'complete') throw Error('Unknown synthetic capacity stage');
      }
      await registry.saveProofState(state);
      return Response.json({ stage: state.stage, done: state.stage === 'complete', seeded: state.seeded, pages: state.pages, largePages: state.largePages, sourceWasmBeforeFreeze: state.sourceWasmBeforeFreeze ?? 0, sourceRuntimeReleased: state.sourceRuntimeReleased === true, oversizedRejected: state.oversizedRejected === true, legacyRejected: state.legacyRejected === true, frozenLegacyRejected: state.frozenLegacyRejected === true, legacyActiveRecovered: state.legacyActiveRecovered === true, longKeyRejected: state.longKeyRejected === true, nonfiniteRejected: state.nonfiniteRejected === true });
    } catch (error) {
      console.error('Synthetic capacity proof failed', stage, error?.message);
      return Response.json({ done: false, stage }, { status: 500 });
    }
  },
};
