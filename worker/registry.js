import { DurableObject } from "cloudflare:workers";
import { beginRegistryMove, initializeMoveRegistry, validRelocationDigest } from "./registry-move.js";
import { initializeHistoryCheckpoint, readHistoryCheckpoint, advanceHistoryCheckpoint } from "./registry-history.js";
import { assertRecoveryEnvelope, readAnchoredRecoveryScopes, recoveryPageDigest, validRecoveryStamp, validateRecoveryScope, validateRecoveryScopePage } from "./recovery-scopes.js";
import { recoveryEpochConfiguration } from "./recovery-epochs.js";
import { RELOCATION_RECONCILIATION_VERSION } from "./relocation-values.js";
import { authorizeSchemaMigration } from "./schema-migration.js";
import { RELOCATION_TEXT_PREFLIGHT_VERSION } from "./relocation-text-preflight.js";
import { validReconciliationCursor } from "./relocation-reconcile-cursor.js";
import { initializeNewEvidenceJournal, assertEvidenceAppendAllowed, recordEvidencePage, advanceEvidencePaging, verifyEvidencePage } from "./registry-evidence.js";

function authorizeRelocation(env, secret) {
  if (env.MAPI_RELOCATION_ENABLED !== "1" || !env.MAPI_RELOCATION_CONTROL_TOKEN ||
      typeof secret !== "string" || secret.length !== env.MAPI_RELOCATION_CONTROL_TOKEN.length) throw new Error("Relocation control denied");
  let difference = 0;
  for (let index = 0; index < secret.length; index++) difference |= secret.charCodeAt(index) ^ env.MAPI_RELOCATION_CONTROL_TOKEN.charCodeAt(index);
  if (difference) throw new Error("Relocation control denied");
}

// Bound new durable identifiers before an intent is written or a source is
// frozen. Existing intents retain their original ID for interruption recovery.
export function validNewRelocationMoveId(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 128) return false;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      if (++i >= value.length) return false;
      const low = value.charCodeAt(i);
      if (low < 0xdc00 || low > 0xdfff) return false;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return new TextEncoder().encode(value).byteLength <= 128;
}

// Keep persisted reconciliation metadata bounded before it crosses the SQL
// bridge. Corruption must fail closed without replacing malformed UTF-8.
const RECONCILIATION_TABLES_BYTES = 128 * 1024;
const RECONCILIATION_CURSOR_BYTES = 12 * 1024;
function reconciliationText(value) {
  if (!(value instanceof ArrayBuffer)) throw Error('Invalid reconciliation checkpoint');
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(value); }
  catch { throw Error('Invalid reconciliation checkpoint'); }
}
function parseReconciliationCursor(value) {
  let cursor; try { cursor = JSON.parse(value); } catch { throw Error('Invalid reconciliation checkpoint'); }
  if (!validReconciliationCursor(cursor) || JSON.stringify(cursor) !== value) throw Error('Invalid reconciliation checkpoint');
  return cursor;
}
function readReconciliationCheckpoint(sql, projectId, moveId) {
  const rows = sql.exec(`SELECT journal_version, table_index,
    CASE WHEN move_id = ? COLLATE BINARY THEN 1 ELSE 0 END AS matches,
    CASE WHEN typeof(tables) = 'text' AND length(CAST(tables AS BLOB)) <= ? THEN CAST(tables AS BLOB) END AS tables,
    CASE WHEN cursor IS NULL THEN 1 WHEN typeof(cursor) = 'text' AND length(CAST(cursor AS BLOB)) <= ? THEN 1 ELSE 0 END AS cursor_valid,
    CASE WHEN typeof(cursor) = 'text' AND length(CAST(cursor AS BLOB)) <= ? THEN CAST(cursor AS BLOB) END AS cursor
    FROM mapi_move_reconciliation WHERE project_id = ? LIMIT 2`, moveId, RECONCILIATION_TABLES_BYTES, RECONCILIATION_CURSOR_BYTES, RECONCILIATION_CURSOR_BYTES, projectId).toArray();
  if (!rows.length) return null;
  if (rows.length !== 1 || rows[0].matches !== 1) throw Error('Reconciliation manifest mismatch');
  const row = rows[0];
  // Do not reinterpret prior journals or decode their possibly old cursors.
  if (row.journal_version !== RELOCATION_RECONCILIATION_VERSION) throw Error('Legacy reconciliation requires manual review');
  if (!Number.isSafeInteger(row.table_index) || row.table_index < 0 || row.cursor_valid !== 1) throw Error('Invalid reconciliation checkpoint');
  const tables = reconciliationText(row.tables);
  let parsedTables; try { parsedTables = JSON.parse(tables); } catch { throw Error('Invalid reconciliation checkpoint'); }
  if (!Array.isArray(parsedTables) || !parsedTables.length || parsedTables.length > 1000 || JSON.stringify(parsedTables) !== tables ||
      parsedTables.some(name => typeof name !== 'string' || !name || !name.isWellFormed() || new TextEncoder().encode(name).length > 1024) ||
      new Set(parsedTables).size !== parsedTables.length || row.table_index > parsedTables.length) throw Error('Invalid reconciliation checkpoint');
  const cursor = row.cursor === null ? null : reconciliationText(row.cursor);
  if (cursor !== null) parseReconciliationCursor(cursor);
  if (row.table_index === parsedTables.length && cursor !== null) throw Error('Invalid reconciliation checkpoint');
  return { move_id: moveId, tables, table_index: row.table_index, cursor, journal_version: row.journal_version };
}
function currentReconciliation(sql, projectId, moveId) {
  let row; try { row = readReconciliationCheckpoint(sql, projectId, moveId); } catch { return false; }
  if (!row || row.cursor !== null) return false;
  const tables = JSON.parse(row.tables);
  return row.table_index === tables.length && !!sql.exec('SELECT 1 FROM mapi_move_journals WHERE move_id = ? AND project_id = ? AND complete = 1', moveId, projectId).toArray().length;
}

function assertNoLegacyTransferEvidence(sql, projectId, moveId) {
  for (const name of ['mapi_move_reconciliation', 'mapi_move_journals', 'mapi_move_evidence', 'mapi_move_completion', 'mapi_move_history', 'mapi_move_history_verification']) {
    const objects = sql.exec('SELECT type FROM sqlite_schema WHERE lower(name) = ?', name).toArray();
    if (!objects.length && name === 'mapi_move_history_verification') continue;
    if (objects.length !== 1 || objects[0].type !== 'table') throw new Error('Legacy transfer state requires manual review');
    if (sql.exec(`SELECT 1 FROM ${name} WHERE project_id = ? AND move_id = ? LIMIT 1`, projectId, moveId).toArray().length) throw new Error('Legacy transfer state requires manual review');
  }
}

function validateRecoveryScopeCheckpoint(row, projectId, recoveryId, sql) {
  if (!row || row.project_id !== projectId || row.recovery_id !== recoveryId ||
      !Number.isSafeInteger(row.row_count) || row.row_count < 0 || ![0, 1].includes(row.done)) throw new Error('Invalid recovery scope checkpoint');
  if (row.row_count === 0) {
    if (row.cursor !== null || row.digest !== '' || row.done !== 0) throw new Error('Invalid recovery scope checkpoint');
  } else {
    if (typeof row.digest !== 'string' || !/^[0-9a-f]{64}$/.test(row.digest) || typeof row.cursor !== 'string') throw new Error('Invalid recovery scope checkpoint');
    validateRecoveryScope(row.cursor, projectId, sql);
  }
  return row;
}

// Matching responses are not sufficient: malformed owner pages must never
// advance the durable evidence journal, even if both owners return them.
export function validateReconciliationPage(page, cursor) {
  if (!page || typeof page !== 'object' || Array.isArray(page) ||
      page.guardVersion !== RELOCATION_RECONCILIATION_VERSION ||
      !Number.isSafeInteger(page.count) || page.count < 0 || page.count > 64 ||
      typeof page.done !== 'boolean' || typeof page.digest !== 'string' || page.digest.length !== 64 || !/^[0-9a-f]{64}$/.test(page.digest) ||
      !validReconciliationCursor(cursor) || !validReconciliationCursor(page.cursor)) throw Error('Invalid reconciliation page');
  const next = JSON.stringify(page.cursor), previous = JSON.stringify(cursor);
  if ((page.done && page.count === 0 && next !== previous) ||
      (!page.done && next === previous) ||
      (!page.done && page.count === 0 && (page.cursor === null || Array.isArray(page.cursor))) ||
      (page.done && page.cursor !== null && !Array.isArray(page.cursor)) ||
      (page.count > 0 && (page.cursor === null || next === previous)) ||
      (page.count > 0 && page.cursor !== null && !Array.isArray(page.cursor))) throw Error('Invalid reconciliation page');
  const wasSlice = cursor !== null && !Array.isArray(cursor);
  const isSlice = page.cursor !== null && !Array.isArray(page.cursor);
  if (isSlice) {
    const state = page.cursor;
    if (wasSlice) {
      if (JSON.stringify(state.after) !== JSON.stringify(cursor.after) || JSON.stringify(state.key) !== JSON.stringify(cursor.key) ||
          !(state.column === cursor.column && state.offset > cursor.offset && state.offset - cursor.offset <= 65536 ||
            state.column === cursor.column + 1 && state.offset === 0)) throw Error('Invalid reconciliation page');
    } else if (JSON.stringify(state.after) !== previous || !(state.column === 0 && state.offset > 0 && state.offset <= 65536 || state.column === 1 && state.offset === 0)) throw Error('Invalid reconciliation page');
  } else if (wasSlice && (!Array.isArray(page.cursor) || JSON.stringify(page.cursor) !== JSON.stringify(cursor.key) || page.count !== 1 || page.done)) throw Error('Invalid reconciliation page');
}

export function canonicalOrigin(value) {
  const url = new URL(value);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("Invalid project origin");
  }
  return url.origin;
}

export class ProjectRegistry extends DurableObject {
  moveDestinationCandidate() { return `project:${crypto.randomUUID()}`; }

  constructor(ctx, env) {
    super(ctx, env);
    ctx.storage.transactionSync(() => {
      ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS project_routes (
        origin TEXT PRIMARY KEY,
        object_name TEXT NOT NULL UNIQUE,
        project_id TEXT UNIQUE,
        state TEXT NOT NULL CHECK (state IN ('pending', 'active')),
        generation INTEGER NOT NULL DEFAULT 1 CHECK (generation > 0)
      )`);
      const columns = ctx.storage.sql.exec("PRAGMA table_info(project_routes)").toArray();
      if (!columns.some((column) => column.name === "generation")) {
        ctx.storage.sql.exec("ALTER TABLE project_routes ADD COLUMN generation INTEGER NOT NULL DEFAULT 1 CHECK (generation > 0)");
      }
      initializeMoveRegistry(ctx.storage);
      ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS mapi_move_intents (
        project_id TEXT PRIMARY KEY, move_id TEXT NOT NULL UNIQUE, origin TEXT NOT NULL,
        source_object TEXT NOT NULL, destination_object TEXT NOT NULL UNIQUE,
        generation INTEGER NOT NULL
      )`);
      ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS mapi_move_text_preflight (
        project_id TEXT PRIMARY KEY, move_id TEXT NOT NULL, marker TEXT NOT NULL,
        cursor TEXT NOT NULL, done INTEGER NOT NULL CHECK (done IN (0, 1)), revision INTEGER NOT NULL
      )`);
      ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS mapi_project_recoveries (
        project_id TEXT PRIMARY KEY,
        recovery_id TEXT NOT NULL UNIQUE,
        origin TEXT NOT NULL,
        object_name TEXT NOT NULL,
        object_id TEXT NOT NULL,
        generation INTEGER NOT NULL,
        epoch TEXT NOT NULL UNIQUE,
        phase TEXT NOT NULL CHECK (phase IN ('closing', 'anchored')),
        clock_highwater TEXT
      )`);
      ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS mapi_recovery_intents (
        project_id TEXT PRIMARY KEY, recovery_id TEXT NOT NULL UNIQUE, origin TEXT NOT NULL,
        object_name TEXT NOT NULL, object_id TEXT NOT NULL, generation INTEGER NOT NULL,
        epoch TEXT NOT NULL UNIQUE
      )`);
      ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS mapi_schema_migrations (
        project_id TEXT PRIMARY KEY, migration_id TEXT NOT NULL UNIQUE, origin TEXT NOT NULL,
        object_name TEXT NOT NULL, object_id TEXT NOT NULL, generation INTEGER NOT NULL,
        epoch TEXT NOT NULL, target_version INTEGER NOT NULL, phase TEXT NOT NULL CHECK (phase IN ('reserved', 'committed', 'complete'))
      )`);
      const recoveryColumns = ctx.storage.sql.exec("PRAGMA table_info(mapi_project_recoveries)").toArray();
      if (!recoveryColumns.some(column => column.name === "clock_kind")) ctx.storage.sql.exec("ALTER TABLE mapi_project_recoveries ADD COLUMN clock_kind TEXT");
      ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS mapi_recovery_scope_progress (project_id TEXT PRIMARY KEY, recovery_id TEXT NOT NULL UNIQUE, cursor TEXT, row_count INTEGER NOT NULL, digest TEXT NOT NULL, done INTEGER NOT NULL)");
      ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS mapi_recovery_scope_anchors (recovery_id TEXT NOT NULL, project_id TEXT NOT NULL, scope TEXT NOT NULL, stamp TEXT NOT NULL, PRIMARY KEY (recovery_id, scope))");
      ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS mapi_recovery_epoch_deployments (object_id TEXT PRIMARY KEY, epoch TEXT NOT NULL)");
      const epochs = recoveryEpochConfiguration(env);
      const deployed = ctx.storage.sql.exec('SELECT object_id FROM mapi_recovery_epoch_deployments').toArray();
      for (const item of deployed) if (!epochs || !Object.hasOwn(epochs, item.object_id)) throw new Error('Registry recovery epoch entry missing');
      if (epochs) {
        for (const [objectId, epoch] of Object.entries(epochs)) {
          const anchored = ctx.storage.sql.exec("SELECT clock_highwater, clock_kind FROM mapi_project_recoveries WHERE object_id = ? AND epoch = ? AND phase = 'anchored'", objectId, epoch).toArray();
          if (anchored.length !== 1 || !validRecoveryStamp(anchored[0].clock_highwater) || !['revision', 'timestamp'].includes(anchored[0].clock_kind)) throw new Error("Registry recovery anchor missing");
          ctx.storage.sql.exec('INSERT INTO mapi_recovery_epoch_deployments VALUES (?, ?) ON CONFLICT(object_id) DO UPDATE SET epoch = excluded.epoch', objectId, epoch);
        }
      }
    });
  }

  resolve(origin) {
    return this.ctx.storage.sql.exec("SELECT r.origin, r.object_name, r.project_id, CASE WHEN p.project_id IS NOT NULL THEN 'recovering' WHEN m.phase = 'moving' THEN 'moving' ELSE r.state END AS state, r.generation FROM project_routes AS r LEFT JOIN mapi_route_moves AS m ON m.project_id = r.project_id LEFT JOIN mapi_project_recoveries AS p ON p.project_id = r.project_id WHERE r.origin = ?", canonicalOrigin(origin)).toArray()[0] ?? null;
  }

  schemaMigrationStatus(secret, projectId) {
    authorizeSchemaMigration(this.env, secret);
    return this.ctx.storage.sql.exec('SELECT * FROM mapi_schema_migrations WHERE project_id = ?', projectId).toArray()[0] ?? null;
  }

  async advanceSchemaMigration(secret, origin, projectId, migrationId) {
    authorizeSchemaMigration(this.env, secret);
    origin = canonicalOrigin(origin);
    if (typeof projectId !== 'string' || !projectId || typeof migrationId !== 'string' || !migrationId || new TextEncoder().encode(migrationId).length > 128) throw new Error('Invalid schema migration identity');
    const sql = this.ctx.storage.sql, namespace = this.env.NEXTGEN_APPLICATION;
    let intent = this.schemaMigrationStatus(secret, projectId);
    if (!intent) {
      const route = this.resolve(origin);
      if (!route || route.state !== 'active' || route.project_id !== projectId || !Number.isSafeInteger(route.generation) || route.generation < 1 || route.generation === Number.MAX_SAFE_INTEGER) throw new Error('Schema migration route is not active');
      if (sql.exec('SELECT 1 FROM mapi_move_intents WHERE project_id = ?', projectId).toArray().length || sql.exec('SELECT 1 FROM mapi_recovery_intents WHERE project_id = ?', projectId).toArray().length) throw new Error('Project maintenance is pending');
      const move = sql.exec('SELECT move_id, phase FROM mapi_route_moves WHERE project_id = ?', projectId).toArray()[0];
      if (move?.phase === 'committed' && !sql.exec('SELECT 1 FROM mapi_move_completion WHERE project_id = ? AND move_id = ?', projectId, move.move_id).toArray().length) throw new Error('Previous move has not been finalized');
      const objectId = namespace.idFromName(route.object_name).toString();
      const epoch = sql.exec('SELECT epoch FROM mapi_recovery_epoch_deployments WHERE object_id = ?', objectId).toArray()[0]?.epoch ?? '0';
      const authority = { projectId, origin, objectName: route.object_name, generation: route.generation };
      const proof = await namespace.getByName(route.object_name).schemaMigrationReadiness(secret, authority, epoch);
      if (!proof || proof.projectId !== projectId || proof.origin !== origin || proof.objectName !== route.object_name || proof.generation !== route.generation || proof.objectId !== objectId || proof.epoch !== epoch || proof.version !== 1) throw new Error('Schema migration readiness mismatch');
      intent = this.ctx.storage.transactionSync(() => {
        const current = this.resolve(origin), prior = this.schemaMigrationStatus(secret, projectId);
        if (prior) return prior;
        if (!current || current.state !== 'active' || current.project_id !== projectId || current.object_name !== route.object_name || current.generation !== route.generation || sql.exec('SELECT 1 FROM mapi_move_intents WHERE project_id = ?', projectId).toArray().length || sql.exec('SELECT 1 FROM mapi_recovery_intents WHERE project_id = ?', projectId).toArray().length || (sql.exec('SELECT epoch FROM mapi_recovery_epoch_deployments WHERE object_id = ?', objectId).toArray()[0]?.epoch ?? '0') !== epoch) throw new Error('Schema route changed before intent');
        sql.exec("INSERT INTO mapi_schema_migrations VALUES (?, ?, ?, ?, ?, ?, ?, 2, 'reserved')", projectId, migrationId, origin, route.object_name, objectId, route.generation, epoch);
        return this.schemaMigrationStatus(secret, projectId);
      });
    }
    if (intent.migration_id !== migrationId || intent.origin !== origin || intent.target_version !== 2 || !Number.isSafeInteger(intent.generation) || intent.generation < 1 || intent.generation === Number.MAX_SAFE_INTEGER || intent.object_id !== namespace.idFromName(intent.object_name).toString()) throw new Error('Conflicting schema migration');
    const owner = namespace.getByName(intent.object_name);
    if (intent.phase === 'reserved') {
      const proof = await owner.applySchemaMigration(secret, projectId, migrationId);
      if (!proof || proof.state !== 'frozen' || proof.projectId !== projectId || proof.origin !== origin || proof.objectName !== intent.object_name || proof.generation !== intent.generation || proof.objectId !== intent.object_id || proof.epoch !== intent.epoch || proof.migrationId !== migrationId || proof.version !== 2) throw new Error('Schema migration result mismatch');
      intent = this.ctx.storage.transactionSync(() => {
        const current = this.schemaMigrationStatus(secret, projectId), route = this.resolve(origin);
        if (!current || current.phase !== 'reserved' || current.migration_id !== migrationId || current.object_id !== intent.object_id || current.generation !== intent.generation || !route || route.state !== 'active' || route.project_id !== projectId || route.object_name !== intent.object_name || route.generation !== intent.generation) throw new Error('Schema migration changed before commit');
        sql.exec('UPDATE project_routes SET generation = ? WHERE project_id = ? AND object_name = ? AND generation = ?', intent.generation + 1, projectId, intent.object_name, intent.generation);
        sql.exec("UPDATE mapi_schema_migrations SET phase = 'committed' WHERE project_id = ? AND migration_id = ?", projectId, migrationId);
        return this.schemaMigrationStatus(secret, projectId);
      });
    }
    if (intent.phase === 'committed') {
      const proof = await owner.activateSchemaMigration(secret, projectId, migrationId);
      if (!proof || proof.state !== 'active' || proof.projectId !== projectId || proof.origin !== origin || proof.objectName !== intent.object_name || proof.generation !== intent.generation + 1 || proof.objectId !== intent.object_id || proof.epoch !== intent.epoch || proof.migrationId !== migrationId || proof.version !== 2) throw new Error('Schema activation result mismatch');
      intent = this.ctx.storage.transactionSync(() => {
        const current = this.schemaMigrationStatus(secret, projectId), route = this.resolve(origin);
        if (!current || current.phase !== 'committed' || current.migration_id !== migrationId || current.object_id !== intent.object_id || current.generation !== intent.generation || !route || route.state !== 'active' || route.project_id !== projectId || route.object_name !== intent.object_name || route.generation !== intent.generation + 1) throw new Error('Schema migration changed before completion');
        sql.exec("UPDATE mapi_schema_migrations SET phase = 'complete' WHERE project_id = ? AND migration_id = ?", projectId, migrationId);
        return this.schemaMigrationStatus(secret, projectId);
      });
    }
    return intent;
  }

  relocationStatus(secret, projectId) {
    authorizeRelocation(this.env, secret);
    const sql = this.ctx.storage.sql;
    const route = sql.exec("SELECT origin, project_id, object_name, state, generation FROM project_routes WHERE project_id = ?", projectId).toArray()[0];
    const move = sql.exec("SELECT * FROM mapi_route_moves WHERE project_id = ?", projectId).toArray()[0] ?? null;
    if (move) {
      move.reconciliationReady = currentReconciliation(sql, projectId, move.move_id);
      move.finalized = !!sql.exec('SELECT 1 FROM mapi_move_completion WHERE project_id = ? AND move_id = ?', projectId, move.move_id).toArray().length;
    }
    const intent = sql.exec("SELECT * FROM mapi_move_intents WHERE project_id = ?", projectId).toArray()[0] ?? null;
    if (move?.phase === "moving" && (!route || !intent || intent.project_id !== projectId || intent.origin !== route.origin || intent.move_id !== move.move_id || intent.source_object !== move.source_object || intent.destination_object !== move.destination_object || intent.generation !== move.generation || route.object_name !== move.source_object || route.generation !== move.generation)) throw new Error("Legacy or inconsistent moving route requires manual reconciliation");
    return { route: route ?? null, move, intent };
  }

  #readRelocationTextPreflight(secret, projectId, moveId) {
    const { route, intent } = this.relocationStatus(secret, projectId);
    if (!route || !intent || intent.move_id !== moveId || intent.project_id !== projectId ||
        intent.origin !== route.origin || intent.source_object !== route.object_name ||
        intent.generation !== route.generation) throw new Error('Stale TEXT preflight');
    const row = this.ctx.storage.sql.exec('SELECT * FROM mapi_move_text_preflight WHERE project_id = ?', projectId).toArray()[0];
    if (!row) return null;
    if (row.move_id !== moveId || typeof row.marker !== 'string' || row.marker.length > 128 ||
        typeof row.cursor !== 'string' || row.cursor.length > 8192 || ![0, 1].includes(row.done) ||
        !Number.isSafeInteger(row.revision) || row.revision < 1) throw new Error('Invalid TEXT preflight checkpoint');
    if (row.marker === '' && row.cursor === 'null' && row.done === 0) return null;
    if (!row.marker) throw new Error('Invalid TEXT preflight checkpoint');
    let cursor;
    try { cursor = JSON.parse(row.cursor); } catch { throw new Error('Invalid TEXT preflight checkpoint'); }
    if (!cursor || typeof cursor !== 'object' || Array.isArray(cursor) || cursor.done !== Boolean(row.done)) throw new Error('Invalid TEXT preflight checkpoint');
    return { marker: row.marker, cursor, done: Boolean(row.done), revision: row.revision };
  }

  relocationTextPreflightStatus(secret, projectId, moveId) {
    const checkpoint = this.#readRelocationTextPreflight(secret, projectId, moveId);
    if (!checkpoint) return null;
    if (checkpoint.cursor.version !== RELOCATION_TEXT_PREFLIGHT_VERSION) throw new Error('Legacy TEXT preflight requires manual review');
    const { marker, cursor, done } = checkpoint;
    return { marker, cursor, done };
  }

  legacyRelocationTextPreflightStatus(secret, projectId, moveId) {
    const checkpoint = this.#readRelocationTextPreflight(secret, projectId, moveId);
    if (!checkpoint || checkpoint.cursor.version === RELOCATION_TEXT_PREFLIGHT_VERSION) return null;
    if (![1, 2, 3].includes(checkpoint.cursor.version) || !/^[0-9a-f]{32}$/.test(checkpoint.marker)) throw new Error('Invalid legacy TEXT preflight checkpoint');
    return { marker: checkpoint.marker, version: checkpoint.cursor.version, done: checkpoint.done, revision: checkpoint.revision };
  }

  recoveryStatus(secret, projectId) {
    authorizeRelocation(this.env, secret);
    return this.ctx.storage.sql.exec("SELECT * FROM mapi_project_recoveries WHERE project_id = ?", projectId).toArray()[0] ?? null;
  }

  recoveryIntentStatus(secret, projectId) {
    authorizeRelocation(this.env, secret);
    return this.ctx.storage.sql.exec("SELECT * FROM mapi_recovery_intents WHERE project_id = ?", projectId).toArray()[0] ?? null;
  }

  async beginProjectRecovery(secret, origin, projectId, recoveryId, epoch) {
    authorizeRelocation(this.env, secret);
    origin = canonicalOrigin(origin);
    if (typeof projectId !== 'string' || !projectId || new TextEncoder().encode(projectId).length > 128 || typeof recoveryId !== "string" || !recoveryId || new TextEncoder().encode(recoveryId).length > 128 || typeof epoch !== "string" || !epoch || epoch === "0" || new TextEncoder().encode(epoch).length > 128) throw new Error("Invalid recovery identity");
    const existing = this.recoveryStatus(secret, projectId);
    if (existing) {
      if (existing.recovery_id !== recoveryId || existing.epoch !== epoch || existing.origin !== origin) throw new Error("Conflicting recovery");
      return existing;
    }
    const before = this.resolve(origin);
    if (!before || before.state !== "active" || before.project_id !== projectId) throw new Error("Project route is not active");
    const sql = this.ctx.storage.sql;
    if (sql.exec("SELECT 1 FROM mapi_move_intents WHERE project_id = ?", projectId).toArray().length) throw new Error("Project relocation is pending");
    if (sql.exec("SELECT 1 FROM mapi_schema_migrations WHERE project_id = ? AND phase <> 'complete'", projectId).toArray().length) throw new Error('Project schema migration is pending');
    const previousMove = sql.exec("SELECT move_id, phase FROM mapi_route_moves WHERE project_id = ?", projectId).toArray()[0];
    if (previousMove?.phase === "committed" && !sql.exec("SELECT 1 FROM mapi_move_completion WHERE project_id = ? AND move_id = ?", projectId, previousMove.move_id).toArray().length) throw new Error("Previous move has not been finalized");
    const routeAuthority = { projectId, origin, objectName: before.object_name, generation: before.generation };
    const namespace = this.env.NEXTGEN_APPLICATION;
    let intent = this.recoveryIntentStatus(secret, projectId);
    if (!intent) {
      const proof = await namespace.getByName(before.object_name).activeRecoveryAttestation(secret, routeAuthority, epoch);
      if (!proof || !["active", "legacy"].includes(proof.state) || proof.projectId !== projectId || proof.origin !== origin || proof.objectName !== before.object_name || proof.generation !== before.generation || proof.proposedEpoch !== epoch || proof.objectId !== namespace.idFromName(before.object_name).toString()) throw new Error("Recovery owner attestation mismatch");
      intent = this.ctx.storage.transactionSync(() => {
        const current = this.resolve(origin);
        if (!current || current.state !== "active" || current.project_id !== projectId || current.object_name !== before.object_name || current.generation !== before.generation || sql.exec("SELECT 1 FROM mapi_move_intents WHERE project_id = ?", projectId).toArray().length || sql.exec("SELECT 1 FROM mapi_schema_migrations WHERE project_id = ? AND phase <> 'complete'", projectId).toArray().length) throw new Error("Recovery route changed before intent");
        const prior = this.recoveryIntentStatus(secret, projectId);
        if (prior) return prior;
        if (sql.exec("SELECT 1 FROM mapi_project_recoveries WHERE recovery_id = ? OR epoch = ?", recoveryId, epoch).toArray().length) throw new Error("Recovery ID or epoch already recorded");
        sql.exec("INSERT INTO mapi_recovery_intents VALUES (?, ?, ?, ?, ?, ?, ?)", projectId, recoveryId, origin, before.object_name, proof.objectId, before.generation, epoch);
        return this.recoveryIntentStatus(secret, projectId);
      });
    }
    if (intent.recovery_id !== recoveryId || intent.epoch !== epoch || intent.origin !== origin || intent.object_name !== before.object_name || intent.object_id !== namespace.idFromName(before.object_name).toString() || intent.generation !== before.generation) throw new Error("Conflicting recovery intent");
    if (sql.exec("SELECT 1 FROM mapi_project_recoveries WHERE project_id <> ? AND (recovery_id = ? OR epoch = ?)", projectId, recoveryId, epoch).toArray().length) throw new Error("Recovery ID or epoch already recorded");
    const frozen = await namespace.getByName(before.object_name).preFreezeRecovery(secret, routeAuthority, recoveryId, epoch);
    if (!frozen || frozen.state !== "frozen" || frozen.projectId !== projectId || frozen.origin !== origin || frozen.objectName !== before.object_name || frozen.generation !== before.generation || frozen.recoveryId !== recoveryId || frozen.epoch !== epoch || frozen.objectId !== intent.object_id) throw new Error("Recovery freeze attestation mismatch");
    return this.ctx.storage.transactionSync(() => {
      const sql = this.ctx.storage.sql;
      const current = sql.exec("SELECT * FROM mapi_project_recoveries WHERE project_id = ?", projectId).toArray()[0];
      if (current) {
        if (current.recovery_id !== recoveryId || current.epoch !== epoch || current.origin !== origin) throw new Error("Conflicting recovery");
        return current;
      }
      const route = this.resolve(origin);
      if (!route || route.state !== "active" || route.project_id !== projectId || route.object_name !== before.object_name || route.generation !== before.generation) throw new Error("Project route is not active");
      const durableIntent = this.recoveryIntentStatus(secret, projectId);
      if (!durableIntent || durableIntent.recovery_id !== recoveryId || durableIntent.epoch !== epoch || durableIntent.origin !== origin || durableIntent.object_name !== before.object_name || durableIntent.object_id !== intent.object_id || durableIntent.generation !== before.generation) throw new Error("Recovery intent changed during freeze");
      if (sql.exec("SELECT 1 FROM mapi_move_intents WHERE project_id = ?", projectId).toArray().length) throw new Error("Project relocation is pending");
      const move = sql.exec("SELECT move_id, phase FROM mapi_route_moves WHERE project_id = ?", projectId).toArray()[0];
      if (move?.phase === "committed" && !sql.exec("SELECT 1 FROM mapi_move_completion WHERE project_id = ? AND move_id = ?", projectId, move.move_id).toArray().length) throw new Error("Previous move has not been finalized");
      const objectId = this.env.NEXTGEN_APPLICATION.idFromName(route.object_name).toString();
      sql.exec("INSERT INTO mapi_project_recoveries (project_id, recovery_id, origin, object_name, object_id, generation, epoch, phase, clock_highwater, clock_kind) VALUES (?, ?, ?, ?, ?, ?, ?, 'closing', NULL, NULL)", projectId, recoveryId, origin, route.object_name, objectId, route.generation, epoch);
      return sql.exec("SELECT * FROM mapi_project_recoveries WHERE project_id = ?", projectId).one();
    });
  }

  async captureRecoveryClock(secret, projectId, recoveryId) {
    authorizeRelocation(this.env, secret);
    const pending = this.recoveryStatus(secret, projectId);
    if (!pending || pending.recovery_id !== recoveryId) throw new Error("Unknown recovery");
    if (pending.phase === "anchored") {
      if (!['revision', 'timestamp'].includes(pending.clock_kind) || typeof pending.clock_highwater !== 'string' || !/^(0|[1-9][0-9]*)$/.test(pending.clock_highwater) || BigInt(pending.clock_highwater) > 9223372036854775807n) throw new Error("Registry recovery anchor missing");
      return pending;
    }
    const owner = this.env.NEXTGEN_APPLICATION.getByName(pending.object_name);
    const proof = await owner.recoveryClockAttestation(secret, projectId, recoveryId);
    if (!proof || proof.objectId !== pending.object_id || proof.generation !== pending.generation || !['revision', 'timestamp'].includes(proof.clockKind) ||
        typeof proof.highwater !== "string" || !/^(0|[1-9][0-9]*)$/.test(proof.highwater) || BigInt(proof.highwater) > 9223372036854775807n) throw new Error("Invalid recovery clock proof");
    return this.ctx.storage.transactionSync(() => {
      const sql = this.ctx.storage.sql;
      const current = sql.exec("SELECT * FROM mapi_project_recoveries WHERE project_id = ?", projectId).toArray()[0];
      if (!current || current.recovery_id !== recoveryId || current.object_id !== proof.objectId || current.generation !== proof.generation) throw new Error("Recovery changed during clock capture");
      if (current.phase === "anchored") {
        if (current.clock_highwater !== proof.highwater || current.clock_kind !== proof.clockKind) throw new Error("Conflicting recovery clock proof");
        return current;
      }
      sql.exec("UPDATE mapi_project_recoveries SET phase = 'anchored', clock_highwater = ?, clock_kind = ? WHERE project_id = ?", proof.highwater, proof.clockKind, projectId);
      return sql.exec("SELECT * FROM mapi_project_recoveries WHERE project_id = ?", projectId).one();
    });
  }

  async captureRecoveryScopes(secret, projectId, recoveryId) {
    authorizeRelocation(this.env, secret);
    const recovery = this.recoveryStatus(secret, projectId);
    if (!recovery || recovery.recovery_id !== recoveryId || recovery.phase !== 'anchored' || recovery.clock_kind !== 'revision' || !validRecoveryStamp(recovery.clock_highwater)) throw new Error('Revision recovery anchor is not available');
    const checkpoint = this.ctx.storage.transactionSync(() => {
      const sql = this.ctx.storage.sql;
      const row = sql.exec('SELECT * FROM mapi_recovery_scope_progress WHERE project_id = ?', projectId).toArray()[0];
      if (row && row.recovery_id !== recoveryId) throw new Error('Conflicting scope capture');
      if (row) return validateRecoveryScopeCheckpoint(row, projectId, recoveryId, sql);
      sql.exec("INSERT INTO mapi_recovery_scope_progress VALUES (?, ?, NULL, 0, '', 0)", projectId, recoveryId);
      return validateRecoveryScopeCheckpoint(sql.exec('SELECT * FROM mapi_recovery_scope_progress WHERE project_id = ?', projectId).one(), projectId, recoveryId, sql);
    });
    if (checkpoint.done) return { done: true, count: checkpoint.row_count, digest: checkpoint.digest };
    const page = await this.env.NEXTGEN_APPLICATION.getByName(recovery.object_name).recoveryScopePage(secret, projectId, recoveryId, checkpoint.cursor);
    validateRecoveryScopePage(page, projectId, checkpoint.cursor, recovery.clock_highwater, this.ctx.storage.sql);
    const digest = await recoveryPageDigest(checkpoint.digest, projectId, recoveryId, page);
    return this.ctx.storage.transactionSync(() => {
      const sql = this.ctx.storage.sql;
      const currentRecovery = sql.exec('SELECT * FROM mapi_project_recoveries WHERE project_id = ?', projectId).toArray()[0];
      const current = sql.exec('SELECT * FROM mapi_recovery_scope_progress WHERE project_id = ?', projectId).toArray()[0];
      if (!currentRecovery || currentRecovery.recovery_id !== recoveryId || currentRecovery.phase !== 'anchored' || currentRecovery.clock_kind !== 'revision' || currentRecovery.clock_highwater !== recovery.clock_highwater ||
          ['project_id', 'origin', 'object_name', 'object_id', 'generation', 'epoch'].some(key => currentRecovery[key] !== recovery[key]) ||
          !current || current.recovery_id !== recoveryId || current.cursor !== checkpoint.cursor || current.row_count !== checkpoint.row_count || current.digest !== checkpoint.digest || current.done !== checkpoint.done) throw new Error('Recovery scope checkpoint changed; retry');
      validateRecoveryScopeCheckpoint(current, projectId, recoveryId, sql);
      const count = current.row_count + page.rows.length;
      if (!Number.isSafeInteger(count)) throw new Error('Recovery scope count exceeds safe range');
      for (const row of page.rows) sql.exec('INSERT INTO mapi_recovery_scope_anchors VALUES (?, ?, ?, ?)', recoveryId, projectId, row.scope, row.stamp);
      if (page.done && !count) throw new Error('Recovery scope anchor is empty');
      sql.exec('UPDATE mapi_recovery_scope_progress SET cursor = ?, row_count = ?, digest = ?, done = ? WHERE project_id = ?', page.cursor, count, digest, page.done ? 1 : 0, projectId);
      return { done: page.done, count, digest };
    });
  }

  recoveryScopeStatus(secret, projectId, recoveryId) {
    authorizeRelocation(this.env, secret);
    const recovery = this.recoveryStatus(secret, projectId);
    const progress = this.ctx.storage.sql.exec('SELECT * FROM mapi_recovery_scope_progress WHERE project_id = ?', projectId).toArray()[0];
    if (!recovery || recovery.recovery_id !== recoveryId || recovery.phase !== 'anchored' || recovery.clock_kind !== 'revision') throw new Error('Recovery scope anchor is incomplete');
    validateRecoveryScopeCheckpoint(progress, projectId, recoveryId, this.ctx.storage.sql);
    if (progress.done !== 1) throw new Error('Recovery scope anchor is incomplete');
    return assertRecoveryEnvelope({ recovery, count: progress.row_count, digest: progress.digest });
  }

  recoveryScopeSnapshot(secret, projectId, recoveryId, cursor = null) {
    authorizeRelocation(this.env, secret);
    const recovery = this.recoveryStatus(secret, projectId);
    const progress = this.ctx.storage.sql.exec('SELECT * FROM mapi_recovery_scope_progress WHERE project_id = ?', projectId).toArray()[0];
    if (!recovery || recovery.recovery_id !== recoveryId || recovery.phase !== 'anchored' || recovery.clock_kind !== 'revision') throw new Error('Recovery scope anchor is incomplete');
    validateRecoveryScopeCheckpoint(progress, projectId, recoveryId, this.ctx.storage.sql);
    if (progress.done !== 1) throw new Error('Recovery scope anchor is incomplete');
    return assertRecoveryEnvelope({ recovery: { object_id: recovery.object_id, epoch: recovery.epoch, generation: recovery.generation, clock_highwater: recovery.clock_highwater }, count: progress.row_count, digest: progress.digest, page: readAnchoredRecoveryScopes(this.ctx.storage.sql, recoveryId, projectId, cursor) });
  }

  async beginRelocation(secret, origin, projectId, moveId) {
    authorizeRelocation(this.env, secret);
    origin = canonicalOrigin(origin);
    const route = this.resolve(origin);
    if (!route || route.project_id !== projectId) throw new Error("Project route mismatch");
    const existing = this.ctx.storage.sql.exec("SELECT * FROM mapi_route_moves WHERE project_id = ?", projectId).toArray()[0];
    if (existing?.phase === "moving") {
      this.relocationStatus(secret, projectId);
      if (existing.move_id !== moveId || existing.source_object !== route.object_name || existing.generation !== route.generation) throw new Error("Conflicting move");
      // Moving sources may already have transfer or reconciliation state.
      // Never reset that evidence automatically.
      const checkpoint = this.relocationTextPreflightStatus(secret, projectId, moveId);
      if (!checkpoint?.done) throw new Error('Moving TEXT preflight requires manual review');
      return existing;
    }
    if (existing?.phase === "committed") {
      if (existing.move_id === moveId && route.object_name === existing.destination_object && route.generation === existing.generation + 1) return this.relocationStatus(secret, projectId).move;
      const complete = this.ctx.storage.sql.exec("SELECT 1 FROM mapi_move_completion WHERE project_id = ? AND move_id = ?", projectId, existing.move_id).toArray()[0];
      if (!complete) throw new Error("Previous move has not been finalized");
    }
    if (route.state !== "active") throw new Error("Project route is not active");
    // The destination needs the next exact generation. Reject exhaustion
    // before recording an intent or asking the current owner to freeze.
    if (!Number.isSafeInteger(route.generation) || route.generation < 1 || route.generation >= Number.MAX_SAFE_INTEGER) throw new Error("Project generation cannot advance");
    const intent = this.ctx.storage.transactionSync(() => {
      const sql = this.ctx.storage.sql;
      const current = this.resolve(origin);
      if (!current || current.state !== "active" || current.project_id !== projectId || current.object_name !== route.object_name || current.generation !== route.generation) throw new Error("Project route changed before relocation intent");
      if (sql.exec("SELECT 1 FROM mapi_recovery_intents WHERE project_id = ?", projectId).toArray().length) throw new Error("Project recovery is pending");
      if (sql.exec("SELECT 1 FROM mapi_schema_migrations WHERE project_id = ? AND phase <> 'complete'", projectId).toArray().length) throw new Error('Project schema migration is pending');
      const prior = sql.exec("SELECT * FROM mapi_move_intents WHERE project_id = ?", projectId).toArray()[0];
      if (prior) {
        if (prior.move_id !== moveId || prior.origin !== origin || prior.source_object !== route.object_name || prior.generation !== route.generation) throw new Error("Conflicting relocation intent");
        return prior;
      }
      if (!validNewRelocationMoveId(moveId)) throw new Error("Invalid move ID");
      if (sql.exec("SELECT 1 FROM mapi_route_move_ids WHERE move_id = ?", moveId).toArray().length) throw new Error("Move ID already used");
      // New cutovers cannot complete until an independent archive authority is
      // integrated. Refuse before recording an intent or freezing the source;
      // an existing matching intent must remain resumable after a lost reply.
      throw new Error("Relocation admission unavailable: independent archive proof is not configured");
    });
    const sourceRoute = { projectId, origin, objectName: route.object_name, generation: route.generation };
    const namespace = this.env.NEXTGEN_APPLICATION;
    const legacy = this.legacyRelocationTextPreflightStatus(secret, projectId, moveId);
    if (legacy) {
      assertNoLegacyTransferEvidence(this.ctx.storage.sql, projectId, moveId);
      const proof = await namespace.getByName(route.object_name).prepareLegacyTextPreflightRecovery(secret, sourceRoute, moveId, legacy);
      if (!proof || !['active', 'frozen'].includes(proof.state) || proof.projectId !== projectId || proof.origin !== origin || proof.objectName !== route.object_name || proof.generation !== route.generation || proof.moveId !== moveId || proof.objectId !== namespace.idFromName(route.object_name).toString()) throw new Error('Legacy TEXT preflight recovery proof mismatch');
      this.ctx.storage.transactionSync(() => {
        const status = this.relocationStatus(secret, projectId);
        const current = this.legacyRelocationTextPreflightStatus(secret, projectId, moveId);
        if (!current || JSON.stringify(current) !== JSON.stringify(legacy) || status.move?.phase === 'moving' || status.route?.state !== 'active' || status.route.project_id !== projectId || status.route.origin !== origin || status.route.object_name !== route.object_name || status.route.generation !== route.generation || status.intent?.move_id !== moveId || status.intent.destination_object !== intent.destination_object) return;
        assertNoLegacyTransferEvidence(this.ctx.storage.sql, projectId, moveId);
        const next = legacy.revision + 1;
        if (!Number.isSafeInteger(next)) throw new Error('TEXT preflight revision exhausted');
        this.ctx.storage.sql.exec("UPDATE mapi_move_text_preflight SET marker = '', cursor = 'null', done = 0, revision = ? WHERE project_id = ? AND move_id = ? AND revision = ?", next, projectId, moveId, legacy.revision);
      });
      return { ...intent, phase: 'preflighting' };
    }
    const saved = this.relocationTextPreflightStatus(secret, projectId, moveId);
    const savedRow = this.ctx.storage.sql.exec('SELECT revision FROM mapi_move_text_preflight WHERE project_id = ?', projectId).toArray()[0] ?? null;
    const preflighting = { ...intent, phase: 'preflighting' };
    const stillCurrent = () => {
      const status = this.relocationStatus(secret, projectId);
      const row = this.ctx.storage.sql.exec('SELECT revision FROM mapi_move_text_preflight WHERE project_id = ?', projectId).toArray()[0] ?? null;
      return status.move?.phase !== 'moving' && status.route?.state === 'active' && status.route.project_id === projectId && status.route.origin === origin &&
        status.route.object_name === route.object_name && status.route.generation === route.generation &&
        status.intent?.move_id === moveId && status.intent.destination_object === intent.destination_object &&
        (row?.revision ?? null) === (savedRow?.revision ?? null);
    };
    if (!saved?.done) {
      const page = await namespace.getByName(route.object_name).advanceRelocationTextPreflight(secret, sourceRoute, moveId, saved);
      if (!page || typeof page.marker !== 'string' || !page.marker || page.marker.length > 128 ||
          !page.checkpoint || typeof page.checkpoint !== 'object' || Array.isArray(page.checkpoint) ||
          typeof page.done !== 'boolean' || page.checkpoint.done !== page.done) throw new Error('Invalid TEXT preflight page');
      const cursor = JSON.stringify(page.checkpoint);
      if (cursor.length > 8192) throw new Error('TEXT preflight checkpoint exceeds bounds');
      this.ctx.storage.transactionSync(() => {
        if (!stillCurrent()) return;
        const next = (savedRow?.revision ?? 0) + 1;
        if (!Number.isSafeInteger(next)) throw new Error('TEXT preflight revision exhausted');
        this.ctx.storage.sql.exec(`INSERT INTO mapi_move_text_preflight VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(project_id) DO UPDATE SET move_id=excluded.move_id, marker=excluded.marker,
          cursor=excluded.cursor, done=excluded.done, revision=excluded.revision`,
          projectId, moveId, page.marker, cursor, page.done ? 1 : 0, next);
      });
      return preflighting;
    }
    const proof = await namespace.getByName(route.object_name).preFreezeRelocation(secret, sourceRoute, moveId, saved.marker);
    if (proof?.state === 'stale') {
      this.ctx.storage.transactionSync(() => {
        if (!stillCurrent()) return;
        const next = savedRow.revision + 1;
        if (!Number.isSafeInteger(next)) throw new Error('TEXT preflight revision exhausted');
        this.ctx.storage.sql.exec("UPDATE mapi_move_text_preflight SET marker = '', cursor = 'null', done = 0, revision = ? WHERE project_id = ? AND move_id = ?", next, projectId, moveId);
      });
      return preflighting;
    }
    if (proof?.state !== "frozen" || proof.projectId !== projectId || proof.origin !== origin || proof.objectName !== route.object_name || proof.generation !== route.generation || proof.moveId !== moveId || proof.objectId !== namespace.idFromName(route.object_name).toString()) throw new Error("Source freeze attestation mismatch");
    const latest = this.relocationStatus(secret, projectId);
    if (latest.move?.phase === "moving" && latest.move.move_id === moveId && latest.move.source_object === route.object_name && latest.move.generation === route.generation && latest.move.destination_object === intent.destination_object) return latest.move;
    if (!stillCurrent()) throw new Error('TEXT preflight changed during source freeze');
    const current = this.resolve(origin);
    if (!current || current.state !== "active" || current.project_id !== projectId || current.object_name !== route.object_name || current.generation !== route.generation) throw new Error("Project route changed during source freeze");
    if (!latest.intent || latest.intent.move_id !== moveId || latest.intent.destination_object !== intent.destination_object) throw new Error("Relocation intent changed during source freeze");
    return beginRegistryMove(this.ctx.storage, projectId, route.object_name, intent.destination_object, route.generation, moveId);
  }

  async relocationProofs(secret, projectId, moveId) {
    authorizeRelocation(this.env, secret);
    const { route, move } = this.relocationStatus(secret, projectId);
    if (!route || move?.phase !== "moving" || move.move_id !== moveId ||
        move.source_object !== route.object_name || move.generation !== route.generation) throw new Error("Stale relocation");
    const namespace = this.env.NEXTGEN_APPLICATION;
    const [source, destination] = await Promise.all([
      namespace.getByName(move.source_object).relocationAttestation(secret, projectId),
      namespace.getByName(move.destination_object).relocationAttestation(secret, projectId),
    ]);
    const current = this.relocationStatus(secret, projectId);
    if (current.move?.phase !== "moving" || current.move.move_id !== moveId ||
        current.route?.object_name !== move.source_object || current.route.generation !== move.generation ||
        source?.project_id !== projectId || source.object_name !== move.source_object || source.generation !== move.generation || source.state !== "frozen" || source.move_id !== moveId || !validRelocationDigest(source.digest) ||
        destination?.project_id !== projectId || destination.object_name !== move.destination_object || destination.generation !== move.generation + 1 || destination.state !== "staged" || destination.move_id !== moveId || destination.digest !== source.digest) throw new Error("Relocation attestations do not match");
    return { source, destination };
  }

  // Advance one bounded source payload and destination receipt per call.
  async verifyRelocationHistory(secret, projectId, moveId) {
    authorizeRelocation(this.env, secret);
    const initial = this.relocationStatus(secret, projectId);
    const move = initial.move;
    const assertCurrent = () => {
      const current = this.relocationStatus(secret, projectId);
      if (current.move?.phase !== 'moving' || current.move.move_id !== moveId || current.move.source_object !== move.source_object || current.move.destination_object !== move.destination_object || current.move.generation !== move.generation || current.route?.object_name !== move.source_object || current.route.generation !== move.generation || current.route.project_id !== projectId) throw new Error('Stale relocation');
    };
    if (!move || move.phase !== 'moving' || move.move_id !== moveId || !initial.route || initial.route.object_name !== move.source_object || initial.route.generation !== move.generation) throw new Error('Stale relocation');
    const identity = { projectId, moveId, sourceObject: move.source_object, destinationObject: move.destination_object, generation: move.generation };
    const proofs = await this.relocationProofs(secret, projectId, moveId);
    const digest = proofs.source.digest;
    const namespace = this.env.NEXTGEN_APPLICATION;
    const source = namespace.getByName(move.source_object), destination = namespace.getByName(move.destination_object);
    const [a, b] = await Promise.all([source.relocationSourceHistoryStatus(secret, projectId, moveId, digest), destination.relocationDestinationHistoryStatus(secret, projectId, moveId, digest)]);
    if (!Number.isSafeInteger(a?.total) || a.total < 1 || b?.total !== a.total || a.digest !== digest || b.digest !== digest) throw new Error('Transfer history status mismatch');
    const checkpoint = this.ctx.storage.transactionSync(() => {
      assertCurrent();
      return initializeHistoryCheckpoint(this.ctx.storage.sql, identity, a.total, digest);
    });
    if (checkpoint.complete) return { done: true, nextIndex: checkpoint.next, total: a.total };
    const [s, d] = await Promise.all([source.relocationSourceHistory(secret, projectId, moveId, digest, checkpoint.next), destination.relocationDestinationHistory(secret, projectId, moveId, digest, checkpoint.next)]);
    const last = checkpoint.next === a.total - 1;
    if (s?.total !== a.total || d?.total !== a.total || s.digest !== digest || d.digest !== digest || s.index !== checkpoint.next || d.index !== checkpoint.next || s.previous !== checkpoint.chain || s.done !== last || !validRelocationDigest(s.chunkDigest) || d.chunkDigest !== s.chunkDigest || (last && s.chunkDigest !== digest)) throw new Error('Transfer history page mismatch');
    const currentProofs = await this.relocationProofs(secret, projectId, moveId);
    if (currentProofs.source.digest !== digest || currentProofs.destination.digest !== digest) throw new Error('Transfer history owner proof changed');
    return this.ctx.storage.transactionSync(() => {
      assertCurrent();
      const current = readHistoryCheckpoint(this.ctx.storage.sql, identity, a.total, digest);
      if (!current || current.next !== checkpoint.next || current.chain !== checkpoint.chain || current.complete !== checkpoint.complete) throw new Error('Transfer history checkpoint changed; retry');
      const updated = advanceHistoryCheckpoint(this.ctx.storage.sql, identity, a.total, digest, checkpoint, s.chunkDigest);
      return { done: !!updated.complete, nextIndex: updated.next, total: a.total };
    });
  }

  // The registry chooses both owners, the table and cursor, and durably
  // checkpoints each bounded comparison. Callers cannot supply evidence.
  async reconcileRelocation(secret, projectId, moveId) {
    authorizeRelocation(this.env, secret);
    const { route, move } = this.relocationStatus(secret, projectId);
    if (!route || move?.phase !== "moving" || move.move_id !== moveId || route.object_name !== move.source_object || route.generation !== move.generation) throw new Error("Stale relocation");
    const namespace = this.env.NEXTGEN_APPLICATION;
    const source = namespace.getByName(move.source_object), destination = namespace.getByName(move.destination_object);
    const manifest = await source.relocationManifest(secret, projectId, moveId);
    const tables = JSON.stringify(manifest.tables);
    const checkpoint = this.ctx.storage.transactionSync(() => {
      const current = this.relocationStatus(secret, projectId);
      if (current.move?.phase !== "moving" || current.move.move_id !== moveId || current.route?.object_name !== move.source_object || current.route.generation !== move.generation) throw new Error("Stale relocation");
      const sql = this.ctx.storage.sql;
      const row = readReconciliationCheckpoint(sql, projectId, moveId);
      if (row && (row.move_id !== moveId || row.tables !== tables)) throw new Error("Reconciliation manifest mismatch");
      if (row && row.journal_version !== RELOCATION_RECONCILIATION_VERSION) throw new Error("Legacy reconciliation requires manual review");
      if (!row) {
        sql.exec("INSERT INTO mapi_move_reconciliation (project_id, move_id, tables, table_index, cursor, journal_version) VALUES (?, ?, ?, 0, NULL, ?)", projectId, moveId, tables, RELOCATION_RECONCILIATION_VERSION);
        sql.exec("INSERT INTO mapi_move_journals VALUES (?, ?, 0)", moveId, projectId);
        initializeNewEvidenceJournal(sql, projectId, moveId);
      }
      return row ?? { table_index: 0, cursor: null, journal_version: RELOCATION_RECONCILIATION_VERSION };
    });
    if (checkpoint.table_index === manifest.tables.length) {
      if (!currentReconciliation(this.ctx.storage.sql, projectId, moveId)) throw new Error("Reconciliation is incomplete");
      return { done: true, tableIndex: checkpoint.table_index };
    }
    if (checkpoint.table_index > manifest.tables.length) throw new Error("Invalid reconciliation checkpoint");
    const table = manifest.tables[checkpoint.table_index], cursor = checkpoint.cursor === null ? null : parseReconciliationCursor(checkpoint.cursor);
    const [a, b] = await Promise.all([source.relocationReconcile(secret, projectId, moveId, table, cursor), destination.relocationReconcile(secret, projectId, moveId, table, cursor)]);
    if (a?.guardVersion !== RELOCATION_RECONCILIATION_VERSION || b?.guardVersion !== RELOCATION_RECONCILIATION_VERSION) throw new Error("Relocation owner guard version mismatch");
    validateReconciliationPage(a, cursor);
    validateReconciliationPage(b, cursor);
    if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`Reconciliation failed for ${table}`);
    return this.ctx.storage.transactionSync(() => {
      const current = this.relocationStatus(secret, projectId);
      if (current.move?.phase !== "moving" || current.move.move_id !== moveId || current.route?.object_name !== move.source_object || current.route.generation !== move.generation) throw new Error("Stale relocation");
      const sql = this.ctx.storage.sql;
      const row = readReconciliationCheckpoint(sql, projectId, moveId);
      if (!row || row.move_id !== moveId || row.tables !== tables || row.table_index !== checkpoint.table_index || row.cursor !== checkpoint.cursor || row.journal_version !== RELOCATION_RECONCILIATION_VERSION) throw new Error("Reconciliation checkpoint changed; retry");
      const next = row.table_index + (a.done ? 1 : 0), nextCursor = a.done ? null : JSON.stringify(a.cursor);
      if (!a.done && nextCursor === row.cursor) throw new Error("Reconciliation did not advance");
      assertEvidenceAppendAllowed(sql, projectId, moveId);
      sql.exec("INSERT INTO mapi_move_evidence (move_id, project_id, table_index, table_name, cursor_in, cursor_out, row_count, digest, table_done) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", moveId, projectId, row.table_index, table, JSON.stringify(cursor), JSON.stringify(a.cursor), a.count, a.digest, a.done ? 1 : 0);
      recordEvidencePage(sql, projectId, moveId);
      sql.exec("UPDATE mapi_move_reconciliation SET table_index = ?, cursor = ? WHERE project_id = ?", next, nextCursor, projectId);
      if (next === manifest.tables.length) sql.exec("UPDATE mapi_move_journals SET complete = 1 WHERE move_id = ? AND project_id = ?", moveId, projectId);
      return { done: next === manifest.tables.length, tableIndex: next, evidence: { table, cursor, nextCursor: a.cursor, count: a.count, digest: a.digest, tableDone: a.done } };
    });
  }

  relocationEvidence(secret, projectId, moveId, after = 0) {
    authorizeRelocation(this.env, secret);
    if (!Number.isSafeInteger(after) || after < 0) throw new Error("Invalid evidence cursor");
    const sql = this.ctx.storage.sql;
    const journal = sql.exec("SELECT complete FROM mapi_move_journals WHERE move_id = ? AND project_id = ?", moveId, projectId).toArray()[0];
    if (!journal) throw new Error("Move evidence not available");
    // Commit bounded backfill progress before asking a legacy caller to retry.
    if (!advanceEvidencePaging(this.ctx.storage, projectId, moveId)) throw new Error("Evidence index preparation in progress; retry");
    // Evidence remains readable after a completed historical move; validate
    // each returned page without reinterpreting its checkpoint version.
    const rows = sql.exec(`SELECT page.sequence AS sequence, page.previous AS previous, page.following AS following,
      CASE WHEN e.move_id = ? COLLATE BINARY AND e.project_id = ? COLLATE BINARY THEN 1 ELSE 0 END AS owner,
      CASE WHEN typeof(e.table_name) = 'text' AND length(CAST(e.table_name AS BLOB)) BETWEEN 1 AND 1024 THEN CAST(e.table_name AS BLOB) END AS table_name,
      CASE WHEN typeof(e.cursor_in) = 'text' AND length(CAST(e.cursor_in AS BLOB)) <= ? THEN CAST(e.cursor_in AS BLOB) END AS cursor_in,
      CASE WHEN e.cursor_out IS NULL THEN 1 WHEN typeof(e.cursor_out) = 'text' AND length(CAST(e.cursor_out AS BLOB)) <= ? THEN 1 ELSE 0 END AS cursor_out_valid,
      CASE WHEN typeof(e.cursor_out) = 'text' AND length(CAST(e.cursor_out AS BLOB)) <= ? THEN CAST(e.cursor_out AS BLOB) END AS cursor_out,
      e.row_count, CASE WHEN typeof(e.digest) = 'text' AND length(CAST(e.digest AS BLOB)) = 64 THEN CAST(e.digest AS BLOB) END AS digest, e.table_done
      FROM mapi_move_evidence_pages page LEFT JOIN mapi_move_evidence e ON e.rowid = page.sequence
      WHERE page.move_id = ? AND page.project_id = ? AND page.sequence > ? ORDER BY page.sequence LIMIT 33`, moveId, projectId, RECONCILIATION_CURSOR_BYTES, RECONCILIATION_CURSOR_BYTES, RECONCILIATION_CURSOR_BYTES, moveId, projectId, after).toArray();
    verifyEvidencePage(sql, projectId, moveId, after, rows);
    const page = rows.slice(0, 32).map(row => {
      if (!Number.isSafeInteger(row.sequence) || row.sequence <= after || row.owner !== 1 || !Number.isSafeInteger(row.row_count) || row.row_count < 0 || row.row_count > 64 || row.cursor_out_valid !== 1 || ![0, 1].includes(row.table_done)) throw Error('Invalid relocation evidence');
      const table = reconciliationText(row.table_name), digest = reconciliationText(row.digest);
      if (!/^[0-9a-f]{64}$/.test(digest)) throw Error('Invalid relocation evidence');
      return { sequence: row.sequence, table, cursor: parseReconciliationCursor(reconciliationText(row.cursor_in)), nextCursor: row.cursor_out === null ? null : parseReconciliationCursor(reconciliationText(row.cursor_out)), count: row.row_count, digest, tableDone: !!row.table_done };
    });
    return { complete: !!journal.complete, done: rows.length <= 32, next: page.length ? page[page.length - 1].sequence : after, pages: page };
  }

  async commitRelocation(secret, projectId, moveId) {
    authorizeRelocation(this.env, secret);
    const existing = this.relocationStatus(secret, projectId);
    if (existing.move?.phase === "committed" && existing.move.move_id === moveId) {
      if (!existing.move.reconciliationReady && !existing.move.finalized) throw new Error("Legacy committed relocation requires manual review");
      return existing.route;
    }
    if (!currentReconciliation(this.ctx.storage.sql, projectId, moveId)) throw new Error("Reconciliation is incomplete");
    // No independently administered archive authority is integrated yet.
    // Deny every new cutover at the registry boundary, including direct RPCs;
    // owner attestations and the control secret do not establish recoverability.
    // Already-committed moves above must remain recoverable after a lost reply.
    throw new Error("Relocation cutover unavailable: independent archive proof is not configured");
  }

  async finalizeRelocation(secret, projectId, moveId) {
    authorizeRelocation(this.env, secret);
    const { route, move } = this.relocationStatus(secret, projectId);
    if (!route || move?.phase !== "committed" || move.move_id !== moveId || route.object_name !== move.destination_object || route.generation !== move.generation + 1) throw new Error("Relocation is not committed");
    if (!move.reconciliationReady) {
      if (move.finalized) return { done: true };
      throw new Error("Legacy committed relocation requires manual review");
    }
    const namespace = this.env.NEXTGEN_APPLICATION;
    const [source, destination] = await Promise.all([namespace.getByName(move.source_object).relocationAttestation(secret, projectId), namespace.getByName(move.destination_object).relocationAttestation(secret, projectId)]);
    if (source?.state !== "retired" || source.project_id !== projectId || source.object_name !== move.source_object || source.generation !== move.generation || source.move_id !== moveId || source.digest !== move.digest || destination?.state !== "active" || destination.project_id !== projectId || destination.object_name !== move.destination_object || destination.generation !== route.generation || destination.move_id !== moveId || destination.digest !== move.digest) throw new Error("Relocation is not finalized by owners");
    return this.ctx.storage.transactionSync(() => {
      const current = this.relocationStatus(secret, projectId);
      if (current.move?.phase !== "committed" || current.move.move_id !== moveId || !current.move.reconciliationReady || current.route?.object_name !== move.destination_object || current.route.generation !== route.generation) throw new Error("Stale relocation");
      this.ctx.storage.sql.exec("INSERT OR IGNORE INTO mapi_move_history VALUES (?, ?, ?, ?, ?, ?)", moveId, projectId, move.source_object, move.destination_object, move.generation, move.digest);
      this.ctx.storage.sql.exec("INSERT OR IGNORE INTO mapi_move_completion VALUES (?, ?)", projectId, moveId);
      this.ctx.storage.sql.exec("DELETE FROM mapi_move_intents WHERE project_id = ? AND move_id = ?", projectId, moveId);
      this.ctx.storage.sql.exec("DELETE FROM mapi_move_text_preflight WHERE project_id = ? AND move_id = ?", projectId, moveId);
      return { done: true };
    });
  }

  reserve(origin, objectName) {
    origin = canonicalOrigin(origin);
    if (typeof objectName !== "string" || !objectName) throw new Error("Invalid object name");
    return this.ctx.storage.transactionSync(() => {
      const sql = this.ctx.storage.sql;
      const existing = this.resolve(origin);
      if (existing) return existing;
      if (sql.exec("SELECT 1 FROM mapi_move_intents WHERE destination_object = ?", objectName).toArray().length || sql.exec("SELECT 1 FROM mapi_route_move_objects WHERE object_name = ?", objectName).toArray().length) throw new Error("Object name is reserved for relocation");
      sql.exec("INSERT INTO project_routes (origin, object_name, state) VALUES (?, ?, 'pending')", origin, objectName);
      return { origin, object_name: objectName, project_id: null, state: "pending", generation: 1 };
    });
  }

  async activate(origin, objectName, projectId) {
    origin = canonicalOrigin(origin);
    if (typeof projectId !== "string" || !/^proj_[a-zA-Z0-9_-]+$/.test(projectId)) throw new Error("Invalid project ID");
    const before = this.resolve(origin);
    if (!before || before.object_name !== objectName || (before.project_id && before.project_id !== projectId)) throw new Error("Project route conflict");
    if (before.state === "active") {
      await this.env.NEXTGEN_APPLICATION.getByName(objectName).activateProvisioning({ projectId, origin, objectName, generation: before.generation });
      return before;
    }
    if (before.state !== "pending") throw new Error("Project route is not pending");
    const namespace = this.env.NEXTGEN_APPLICATION;
    const proof = await namespace.getByName(objectName).provisioningAttestation(origin, objectName, before.generation);
    if (!proof || proof.projectId !== projectId || proof.origin !== origin || proof.objectName !== objectName || proof.generation !== before.generation || proof.objectId !== namespace.idFromName(objectName).toString()) throw new Error("Provisioning attestation mismatch");
    const activated = this.ctx.storage.transactionSync(() => {
      const sql = this.ctx.storage.sql;
      const existing = sql.exec("SELECT origin, object_name, project_id, state, generation FROM project_routes WHERE origin = ?", origin).toArray()[0];
      if (!existing || existing.object_name !== objectName || existing.generation !== before.generation || (existing.project_id && existing.project_id !== projectId)) throw new Error("Project route conflict");
      if (sql.exec("SELECT 1 FROM mapi_route_moves WHERE project_id = ? AND phase = 'moving'", projectId).toArray().length) throw new Error("Project route is moving");
      if (sql.exec("SELECT 1 FROM mapi_project_recoveries WHERE project_id = ?", projectId).toArray().length) throw new Error("Project route is recovering");
      sql.exec("UPDATE project_routes SET project_id = ?, state = 'active' WHERE origin = ?", projectId, origin);
      return { origin, object_name: objectName, project_id: projectId, state: "active", generation: existing.generation };
    });
    await namespace.getByName(objectName).activateProvisioning({ projectId, origin, objectName, generation: activated.generation });
    return activated;
  }
}
