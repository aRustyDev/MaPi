// Synthetic staging-only capacity proof. This wrapper leaves the real owner and
// relocation path unchanged while avoiding whole-value JavaScript allocation
// during fixture seeding and verification.
import capacityWorker, { CapacityOwner as OriginalCapacityOwner, CapacityRegistry } from './relocation-text-capacity-worker.mjs';
import { invalidateTextPreflightMarker } from '../worker/relocation-text-marker.js';
import { initializeOwnerFence } from '../worker/owner-fence.js';

export { CapacityRegistry };
const LARGE_BYTES = 8_300_000;
const BLOB_BYTES = 8_380_000;
const NEAR_TEXT_BYTES = 8_380_000;
const VALUE_BYTES = 1024;
const VERIFY_SLICE = 64 * 1024;
const boundedKey = 'capacity-' + 'k'.repeat(991);
const emoji = [0xf0, 0x9f, 0x98, 0x80];

function expectedByte(offset) {
  if (offset === 0) return 0x7a;
  if (offset >= LARGE_BYTES - 3) return [0x78, 0x79, 0x7a][offset - (LARGE_BYTES - 3)];
  return emoji[(offset - 1) % 4];
}

async function syntheticDigest(sql, query, projectId, userId, length) {
  const digests = new Uint8Array(Math.ceil(length / VERIFY_SLICE) * 32);
  for (let offset = 0; offset < length; offset += VERIFY_SLICE) {
    const size = Math.min(VERIFY_SLICE, length - offset);
    const data = sql.exec(query, offset + 1, size, projectId, userId).one().data;
    if (!(data instanceof ArrayBuffer) || data.byteLength !== size) throw Error('Synthetic value slice differs');
    digests.set(new Uint8Array(await crypto.subtle.digest('SHA-256', data)), offset / VERIFY_SLICE * 32);
  }
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', digests))].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

export class CapacityOwner extends OriginalCapacityOwner {
  constructor(ctx, env) { super(ctx, { ...env, MAPI_PHASE1_CONTROL_TOKEN: env.MAPI_STAGING_PROOF_TOKEN }); }
  #syntheticBoot = crypto.randomUUID();
  syntheticStorageStats(projectId) {
    const sql = this.ctx.storage.sql;
    const table = sql.exec("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'mapi_chunk_export_data'").toArray();
    const transfer = table.length ? sql.exec(`SELECT COUNT(*) AS chunks,
      COALESCE(SUM(length(CAST(content AS BLOB))), 0) AS bytes,
      COALESCE(MAX(length(CAST(content AS BLOB))), 0) AS max_chunk
      FROM mapi_chunk_export_data WHERE project_id = ?`, projectId).one() : null;
    return { databaseBytes: sql.databaseSize, transfer };
  }
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
  seedLarge(projectId, userId, nearUserId) {
    return this.ctx.storage.transactionSync(() => {
      invalidateTextPreflightMarker(this.ctx.storage);
      const sql = this.ctx.storage.sql;
      // Construct the exact synthetic value inside SQLite, not in JavaScript.
      // SQLite may still materialize the value and its intermediate expressions.
      sql.exec("INSERT INTO user_attributes (project_id, user_id, key, value) VALUES (?, ?, 'capacity-large', 'z' || replace(hex(zeroblob(2074999)), '00', '😀') || 'xyz')", projectId, userId);
      sql.exec('INSERT INTO user_attributes (project_id, user_id, key, value) VALUES (?, ?, ?, ?)', projectId, userId, boundedKey, 'x'.repeat(VALUE_BYTES));
      sql.exec(`INSERT INTO user_attributes (project_id, user_id, key, value) VALUES (?, ?, 'near_limit', '"z' || replace(hex(zeroblob(2094998)), '00', '😀') || 'xyzab"')`, projectId, nearUserId);
      sql.exec("INSERT INTO user_totp (project_id, id, user_id, secret, created_at, updated_at) VALUES (?, 'totp-synthetic-large', ?, CAST(X'0080FF' || zeroblob(?) AS BLOB), 1, 1)", projectId, userId, BLOB_BYTES - 3);
    });
  }

  async snapshot(projectId, userId, nearUserId) {
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
    const blob = sql.exec("SELECT typeof(secret) AS kind, length(secret) AS size FROM user_totp WHERE project_id = ? AND user_id = ? AND id = 'totp-synthetic-large'", projectId, userId).toArray();
    if (blob.length !== 1 || blob[0].kind !== 'blob' || blob[0].size !== BLOB_BYTES) throw Error('Synthetic BLOB differs');
    row.blob_digest = await syntheticDigest(sql, "SELECT substr(secret, ?, ?) AS data FROM user_totp WHERE project_id = ? AND user_id = ? AND id = 'totp-synthetic-large'", projectId, userId, BLOB_BYTES);
    const text = sql.exec("SELECT typeof(value) AS kind, length(CAST(value AS BLOB)) AS size FROM user_attributes WHERE project_id = ? AND user_id = ? AND key = 'near_limit'", projectId, nearUserId).toArray();
    if (text.length !== 1 || text[0].kind !== 'text' || text[0].size !== NEAR_TEXT_BYTES) throw Error('Synthetic near-limit TEXT differs');
    row.near_text_digest = await syntheticDigest(sql, "SELECT substr(CAST(value AS BLOB), ?, ?) AS data FROM user_attributes WHERE project_id = ? AND user_id = ? AND key = 'near_limit'", projectId, nearUserId, NEAR_TEXT_BYTES);
    return row;
  }
  async syntheticReadImportedHandler(route, userId) {
    const sql = this.ctx.storage.sql;
    const staged = sql.exec("SELECT project_id, object_name, generation, state FROM mapi_relocation_project WHERE project_id = ?", route.projectId).one();
    const reservation = sql.exec('SELECT project_id, object_name, generation FROM mapi_destination_reservation WHERE singleton = 1').one();
    if (staged.state !== 'staged' || staged.object_name !== route.objectName || staged.generation !== route.generation || reservation.project_id !== route.projectId || reservation.object_name !== route.objectName || reservation.generation !== route.generation) throw Error('Synthetic destination is not staged');
    initializeOwnerFence(this.ctx.storage, route);
    this.ctx.storage.transactionSync(() => {
      sql.exec('DELETE FROM mapi_relocation_project WHERE project_id = ?', route.projectId);
      sql.exec('DELETE FROM mapi_destination_reservation WHERE singleton = 1');
    });
    const token = this.phase1Control(route, this.env.MAPI_STAGING_PROOF_TOKEN, 'project-token');
    const response = this.handleRequest({ method: 'GET', url: `${route.origin}/users/${userId}`, headers: { authorization: [`Bearer ${token}`] }, body: '', peer: '127.0.0.1' }, route);
    if (response.status !== 200) return { status: response.status };
    const body = JSON.parse(new TextDecoder().decode(Uint8Array.fromBase64(response.body)));
    const value = body.attributes?.near_limit;
    if (typeof value !== 'string') throw Error('Imported near-limit attribute missing');
    const bytes = new TextEncoder().encode(value);
    const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(byte => byte.toString(16).padStart(2, '0')).join('');
    return { status: response.status, bytes: bytes.length, digest };
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
    if (state?.stage === 'oversize-provision' && !state.importedHandler) {
      const route = { projectId: state.projectId, origin: state.origin, objectName: state.destination, generation: 2 };
      state.importedHandler = await env.NEXTGEN_APPLICATION.getByName(state.destination).syntheticReadImportedHandler(route, state.nearUserId);
      await registry.saveProofState(state);
    }
    if (state?.stage === 'preflight' && !state.syntheticSourceBefore) {
      state.syntheticSourceBefore = await env.NEXTGEN_APPLICATION.getByName(state.objectName).syntheticStorageStats(state.projectId);
      await registry.saveProofState(state);
    }
    if (state?.stage === 'history' && !state.syntheticSourceAfter) {
      state.syntheticSourceAfter = await env.NEXTGEN_APPLICATION.getByName(state.objectName).syntheticStorageStats(state.projectId);
      state.syntheticDestinationAfter = await env.NEXTGEN_APPLICATION.getByName(state.destination).syntheticStorageStats(state.projectId);
      await registry.saveProofState(state);
    }
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
    result.storage = { sourceBefore: state?.syntheticSourceBefore ?? null, sourceAfter: state?.syntheticSourceAfter ?? null, destinationAfter: state?.syntheticDestinationAfter ?? null };
    result.syntheticEvictions = state?.syntheticEvictions ?? 0;
    result.blobDigest = state?.before?.blob_digest ?? null;
    result.nearTextDigest = state?.before?.near_text_digest ?? null;
    result.importedHandler = state?.importedHandler ?? null;
    return Response.json(result);
  },
};
