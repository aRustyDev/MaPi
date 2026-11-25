// Synthetic staging-only capacity proof. This wrapper leaves the real owner and
// relocation path unchanged while avoiding whole-value JavaScript allocation
// during fixture seeding and verification.
import capacityWorker, { CapacityOwner as OriginalCapacityOwner, CapacityRegistry } from './relocation-text-capacity-worker.mjs';
import { invalidateTextPreflightMarker } from '../worker/relocation-text-marker.js';

export { CapacityRegistry };
const LARGE_BYTES = 8_300_000;
const VALUE_BYTES = 1024;
const VERIFY_SLICE = 64 * 1024;
const boundedKey = 'capacity-' + 'k'.repeat(991);
const emoji = [0xf0, 0x9f, 0x98, 0x80];

function expectedByte(offset) {
  if (offset === 0) return 0x7a;
  if (offset >= LARGE_BYTES - 3) return [0x78, 0x79, 0x7a][offset - (LARGE_BYTES - 3)];
  return emoji[(offset - 1) % 4];
}

export class CapacityOwner extends OriginalCapacityOwner {
  #syntheticBoot = crypto.randomUUID();
  syntheticBoot() { return this.#syntheticBoot; }
  syntheticEvict() { this.ctx.abort('Synthetic eviction'); }
  syntheticStreamProgress(projectId, userId) {
    const sql = this.ctx.storage.sql;
    if (!sql.exec("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'mapi_chunk_import_stream'").toArray().length) return null;
    const state = sql.exec('SELECT table_name, column_index, next_offset, last_chunk, types FROM mapi_chunk_import_stream WHERE project_id = ?', projectId).toArray()[0];
    if (!state) return null;
    const types = JSON.parse(state.types);
    if (state.table_name !== 'user_attributes' || types[state.column_index]?.kind !== 'text' || types[state.column_index]?.length !== LARGE_BYTES) return null;
    const visible = sql.exec("SELECT COUNT(*) AS n FROM user_attributes WHERE project_id = ? AND user_id = ? AND key = 'capacity-large'", projectId, userId).one().n;
    return { column: state.column_index, offset: state.next_offset, chunk: state.last_chunk, visible };
  }
  seedLarge(projectId, userId) {
    return this.ctx.storage.transactionSync(() => {
      invalidateTextPreflightMarker(this.ctx.storage);
      const sql = this.ctx.storage.sql;
      // Construct the exact synthetic value inside SQLite, not in JavaScript.
      // SQLite may still materialize the value and its intermediate expressions.
      sql.exec("INSERT INTO user_attributes (project_id, user_id, key, value) VALUES (?, ?, 'capacity-large', 'z' || replace(hex(zeroblob(2074999)), '00', '😀') || 'xyz')", projectId, userId);
      sql.exec('INSERT INTO user_attributes (project_id, user_id, key, value) VALUES (?, ?, ?, ?)', projectId, userId, boundedKey, 'x'.repeat(VALUE_BYTES));
    });
  }

  snapshot(projectId, userId) {
    const sql = this.ctx.storage.sql;
    const row = sql.exec(`SELECT COUNT(*) AS count,
      COALESCE(SUM(length(CAST(value AS BLOB))),0) AS bytes,
      COALESCE(SUM(CASE WHEN key = 'capacity-large' AND typeof(value) = 'text' AND length(CAST(value AS BLOB)) = ? THEN 1 ELSE 0 END),0) AS large_matches,
      COALESCE(SUM(CASE WHEN key = ? AND value = ? THEN 1 ELSE 0 END),0) AS bounded_key_matches,
      COALESCE(SUM(CASE WHEN key <> 'capacity-large' AND typeof(value) = 'text' AND value = ? THEN 1 ELSE 0 END),0) AS small_matches
      FROM user_attributes WHERE project_id = ? AND user_id = ? AND key GLOB 'capacity-*'`,
      LARGE_BYTES, boundedKey, 'x'.repeat(VALUE_BYTES), 'x'.repeat(VALUE_BYTES), projectId, userId).one();
    if (row.large_matches !== 1) return row;
    for (let offset = 0; offset < LARGE_BYTES; offset += VERIFY_SLICE) {
      const size = Math.min(VERIFY_SLICE, LARGE_BYTES - offset);
      const data = sql.exec("SELECT substr(CAST(value AS BLOB), ?, ?) AS data FROM user_attributes WHERE project_id = ? AND user_id = ? AND key = 'capacity-large'", offset + 1, size, projectId, userId).one().data;
      if (!(data instanceof ArrayBuffer) || data.byteLength !== size) throw Error('Synthetic value slice differs');
      const bytes = new Uint8Array(data);
      for (let index = 0; index < bytes.length; index++) if (bytes[index] !== expectedByte(offset + index)) throw Error('Synthetic value bytes differ');
    }
    return row;
  }
}

async function evictAndVerify(namespace, objectName) {
  const before = await namespace.getByName(objectName).syntheticBoot();
  try { await namespace.getByName(objectName).syntheticEvict(); throw Error('Synthetic eviction did not abort'); }
  catch (error) { if (String(error).includes('Synthetic eviction did not abort')) throw error; }
  const after = await namespace.getByName(objectName).syntheticBoot();
  if (before === after) throw Error('Synthetic owner did not restart');
}

export default {
  async fetch(request, env) {
    const response = await capacityWorker.fetch(request, env);
    if (!response.ok || request.method !== 'POST' || new URL(request.url).pathname !== '/verify') return response;
    const result = await response.json();
    const registry = env.PROJECT_REGISTRY.getByName('projects');
    const state = await registry.proofState();
    if (state?.stage === 'import' && state.destination) {
      const target = env.NEXTGEN_APPLICATION.getByName(state.destination);
      const before = await target.syntheticStreamProgress(state.projectId, state.userId);
      if (before) result.streamProgress = { offset: before.offset, chunk: before.chunk };
      const done = state.syntheticEvictions ?? 0;
      const thresholds = [0.25, 0.50, 0.75];
      if (before && done < thresholds.length && before.offset >= Math.floor(LARGE_BYTES * thresholds[done])) {
        if (before.visible !== 0) throw Error('Partial synthetic row became visible');
        await evictAndVerify(env.NEXTGEN_APPLICATION, state.objectName);
        await evictAndVerify(env.NEXTGEN_APPLICATION, state.destination);
        const after = await env.NEXTGEN_APPLICATION.getByName(state.destination).syntheticStreamProgress(state.projectId, state.userId);
        if (JSON.stringify(before) !== JSON.stringify(after)) throw Error('Synthetic stream progress changed after eviction');
        state.syntheticEvictions = done + 1;
        await registry.saveProofState(state);
      }
    }
    result.syntheticEvictions = state?.syntheticEvictions ?? 0;
    return Response.json(result);
  },
};
