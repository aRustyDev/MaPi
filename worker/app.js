import { DurableObject } from "cloudflare:workers";
import baseline from "./generated/baseline.json";
import wasm from "./wasm-module.js";
import { instantiateReactor } from "./wasi.js";
import { execute, sqliteError } from "./sql.js";
import { canonicalOrigin, ProjectRegistry } from "./registry.js";
import { renderLogin } from "./login-ui.js";
import { handleFlowProxy } from "./flow-proxy.js";
import { handleOAuthIngress, isOAuthRoute } from "./oauth-ingress.js";
import { logOverload, logReactorLifecycle, observeWasmHighWater } from "./runtime-diagnostics.js";
import { classifyFlowSubmission } from "./flow-diagnostics.js";
import { assertOwnerFence, createOwnerFenceTable, freezeOwnerFence, initializeOwnerFence, reserveMoveDestination, retireOwnerFence, withOwnerFence } from "./owner-fence.js";
import { sourceIdentityMatches } from "./relocation-source-identity.js";
import { digestRelocationPage, inspectRelocationDestination, inspectRelocationSource, prepareRelocationDestination, restoreRelocationMetadata, validateRelocationSourceSchema, validateSourceRecoveryEpoch } from "./relocation-manifest.js";
import { beginChunkExport, beginChunkImport, chunkExportStatus, chunkImportStatus, exportChunk, importChunk } from "./relocation-chunks.js";
import { destinationTransferHistory, sourceTransferHistory, transferHistoryStatus } from "./relocation-history.js";
import { assertRelocationTextGuard, RELOCATION_TEXT_GUARD_VERSION } from "./relocation-values.js";
import { assertNoTextPreflightMarkerAccess, invalidateTextPreflightMarker, hasTextPreflightMarker, readTextPreflightMarker, createTextPreflightMarker, writeTextPreflightSeal, assertTextPreflightSeal } from "./relocation-text-marker.js";
import { advanceRelocationTextPreflight } from "./relocation-text-preflight.js";
import { assertRecoveryEnvelope, readOwnerRecoveryScopes, recoveryPageDigest, validRecoveryStamp, validateRecoveryScope } from "./recovery-scopes.js";
import { recoveryEpochConfiguration } from "./recovery-epochs.js";
import { authorizeSchemaMigration } from "./schema-migration.js";
import { admitLogin } from "./login-throttle.js";
import { readBoundedText as readLimited } from "./request-body.js";

export { ProjectRegistry };
export { RelocationCoordinator } from "./relocation-coordinator.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const rejected = Symbol("transaction rejected");
const noStore = { "cache-control": "no-store" };

// Different upstream stages depend on whether the identifier exists. Keep
// their failures indistinguishable until an equal-work admission design is
// available; the separate IP/global admission check still returns 429.
function legacyLoginFailure() { return { status: 401 }; }

function successfulUpstreamStatus(status) {
  return Number.isInteger(status) && status >= 200 && status < 300;
}

// A mutation can fail after its first status check because the owner froze or
// the route moved. Consult both authoritative objects before choosing a
// client-error response; inability to verify availability is retryable.
async function ownerRouteStillAvailable(registry, object, route, ownerRoute) {
  try {
    const current = await registry.resolve(route.origin);
    if (!current || current.state !== "active" || current.origin !== route.origin || current.project_id !== route.project_id || current.object_name !== route.object_name || current.generation !== route.generation) return false;
    const state = await object.status(false, ownerRoute);
    return state.fenceReady === true && state.recoveryReady === true && state.maintenance !== true;
  } catch { return false; }
}

function sessionTTLVariables(env) {
  for (const name of ["MAPI_SESSION_DEFAULT_TTL", "MAPI_SESSION_MAX_TTL"]) {
    if (env[name] !== undefined && typeof env[name] !== "string") throw new Error("Invalid session duration configuration");
  }
  return { sessionDefaultTTL: env.MAPI_SESSION_DEFAULT_TTL, sessionMaxTTL: env.MAPI_SESSION_MAX_TTL };
}

function page(body, status = 200) {
  return new Response(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>MaPi</title><body>${body}</body></html>`, {
    status, headers: { ...noStore, "content-type": "text/html; charset=utf-8", "content-security-policy": "default-src 'none'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'" },
  });
}

function sameKey(left, right) {
  if (!left || !right || left.length !== right.length) return false;
  let difference = 0;
  for (let i = 0; i < left.length; i++) difference |= left.charCodeAt(i) ^ right.charCodeAt(i);
  return difference === 0;
}

// An independently deployed, object-specific epoch remains outside SQLite
// point-in-time recovery. A targeted recovery must supply a matching map entry.
function recoveryObjectEpoch(env, objectId) {
  const epochs = recoveryEpochConfiguration(env);
  return epochs && Object.hasOwn(epochs, objectId) ? epochs[objectId] : null;
}

// One object is the authoritative database for an application deployment.
export class NextgenApplication extends DurableObject {
  #reactor;
  #memory;
  #bootId = crypto.randomUUID();
  #wasmHighWaterBytes = 0;
  #reactorInitializations = 0;
  #reactorAttempts = 0;
  #failAudit = 0;
  #wasmDiagnostic = "";
  #fenceArmed = false;
  #relocationManifestCache;
  #relocationValidatedDestination;
  #authority;
  #insideTransaction = false;
  #recoveryObjectEpoch;
  #recoveryAuthority;
  #pendingAuthority;
  constructor(ctx, env) {
    super(ctx, env);
    // Match the pinned SQLite dialect on every object session, including
    // existing, frozen and importing objects that skip schema initialization.
    ctx.storage.sql.exec("PRAGMA case_sensitive_like = ON");
    this.#recoveryObjectEpoch = recoveryObjectEpoch(env, ctx.id.toString());
    if (this.#recoveryObjectEpoch !== null) {
      const epochTable = ctx.storage.sql.exec("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'mapi_recovery_epoch'").toArray().length;
      if (!epochTable) return;
      let epoch;
      try { epoch = validateSourceRecoveryEpoch(ctx.storage); } catch { return; }
      if (epoch !== this.#recoveryObjectEpoch) return;
    }
    if (env.MAPI_RUNTIME_DIAGNOSTICS === "1") console.log(JSON.stringify({ event: "mapi.owner.boot", bootId: this.#bootId, objectId: ctx.id.toString() }));
    const hasReservation = ctx.storage.sql.exec("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'mapi_destination_reservation'").toArray().length > 0;
    if (hasReservation && ctx.storage.sql.exec("SELECT 1 FROM mapi_destination_reservation WHERE singleton = 1").toArray().length) return;
    const hasImportMetadata = ctx.storage.sql.exec("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'mapi_relocation_project'").toArray().length > 0;
    if (hasImportMetadata && ctx.storage.sql.exec("SELECT 1 FROM mapi_relocation_project WHERE state IN ('importing', 'staged')").toArray().length) return;
    const hasFence = ctx.storage.sql.exec("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'mapi_owner_fence'").toArray().length > 0;
    if (hasFence) {
      const fence = ctx.storage.sql.exec("SELECT state FROM mapi_owner_fence WHERE singleton = 1").toArray()[0];
      if (!fence || !["pending", "active", "frozen", "retired"].includes(fence.state)) throw new Error("Invalid owner fence");
      this.#fenceArmed = true;
      const version = ctx.storage.sql.exec("SELECT version FROM mapi_schema_version").toArray();
      if (version.length !== 1 || ![baseline.version, 2].includes(version[0].version)) {
        throw new Error("Owner schema requires an authorized migration");
      }
      return;
    }
    // Empty and interrupted pending owners must not create schema in a
    // constructor, which has no registry reservation authority.
    const hasSchema = ctx.storage.sql.exec("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'mapi_schema_version'").toArray().length;
    const hasPending = ctx.storage.sql.exec("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'mapi_pending_owner'").toArray().length;
    if (!hasSchema || hasPending) return;
    // A legacy owner has no route authority during construction. Check its
    // existing schema without applying missing setup or a target migration.
    const required = ["mapi_project", "mapi_project_origin", "mapi_login_limits", "mapi_recovery_epoch"];
    const tables = new Set(ctx.storage.sql.exec("SELECT name FROM sqlite_schema WHERE type = 'table'").toArray().map(row => row.name));
    if (required.some(name => !tables.has(name))) throw new Error("Legacy owner schema requires authorized adoption");
    const version = ctx.storage.sql.exec("SELECT version FROM mapi_schema_version").toArray();
    if (version.length !== 1 || ![baseline.version, 2].includes(version[0].version)) throw new Error("Legacy owner schema requires authorized migration");
  }

  #initializeSchema(baselineOnly = false) {
    const { ctx, env } = this;
    ctx.storage.transactionSync(() => {
      invalidateTextPreflightMarker(ctx.storage);
      if (this.#pendingAuthority) this.#assertPendingAuthority();
      ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS mapi_schema_version (version INTEGER PRIMARY KEY)");
      ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS mapi_project (project_id TEXT PRIMARY KEY, schema_url TEXT NOT NULL)");
      ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS mapi_project_origin (origin TEXT NOT NULL)");
      ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS mapi_login_limits (key TEXT PRIMARY KEY, window INTEGER NOT NULL, count INTEGER NOT NULL)");
      ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS mapi_recovery_epoch (epoch TEXT NOT NULL)");
      if (!ctx.storage.sql.exec("SELECT epoch FROM mapi_recovery_epoch").toArray().length) ctx.storage.sql.exec("INSERT INTO mapi_recovery_epoch VALUES ('0')");
      const current = ctx.storage.sql.exec("SELECT version FROM mapi_schema_version").toArray();
      if (current.length === 0) {
        for (const statement of baseline.statements) ctx.storage.sql.exec(statement);
        ctx.storage.sql.exec("INSERT INTO mapi_schema_version (version) VALUES (?)", baseline.version);
      } else if (current.length !== 1 || ![baseline.version, 2].includes(current[0].version)) {
        throw new Error("Unsupported application database schema version");
      }
      if (!baselineOnly && env.MAPI_SCHEMA_TARGET === "2" && ctx.storage.sql.exec("SELECT version FROM mapi_schema_version").one().version === 1) {
        ctx.storage.sql.exec("CREATE TABLE mapi_schema_history (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)");
        ctx.storage.sql.exec("INSERT INTO mapi_schema_history VALUES (2, ?)", Date.now());
        ctx.storage.sql.exec("UPDATE mapi_schema_version SET version = 2");
      }
    });
  }

  #detectFence() {
    this.#assertRecoveryObjectEpoch();
    const sql = this.ctx.storage.sql;
    const pending = sql.exec("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'mapi_pending_owner'").toArray().length;
    const schema = sql.exec("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'mapi_schema_version'").toArray().length;
    if ((!schema || pending) && !this.#pendingAuthority) throw new Error("Owner provisioning is not active");
    if (this.#pendingAuthority) this.#assertPendingAuthority();
    const metadata = this.ctx.storage.sql.exec("SELECT name FROM sqlite_schema WHERE type = 'table' AND name IN ('mapi_owner_fence', 'mapi_relocation_project', 'mapi_destination_reservation')").toArray().map((row) => row.name);
    if (metadata.includes("mapi_destination_reservation") && this.ctx.storage.sql.exec("SELECT 1 FROM mapi_destination_reservation WHERE singleton = 1").toArray().length) {
      throw new Error("Owner import is not active");
    }
    if (metadata.includes("mapi_relocation_project") && this.ctx.storage.sql.exec("SELECT 1 FROM mapi_relocation_project WHERE state IN ('importing', 'staged')").toArray().length) {
      throw new Error("Owner import is not active");
    }
    if (metadata.includes("mapi_owner_fence")) this.#fenceArmed = true;
  }

  #assertPendingAuthority() {
    const expected = this.#pendingAuthority;
    if (!expected) throw new Error("Pending authority missing");
    const row = this.ctx.storage.sql.exec("SELECT origin, object_name, generation FROM mapi_pending_owner WHERE singleton = 1").toArray()[0];
    if (!row || row.origin !== expected.origin || row.object_name !== expected.objectName || row.generation !== expected.generation || this.ctx.id.toString() !== this.env.NEXTGEN_APPLICATION.idFromName(expected.objectName).toString()) throw new Error("Pending authority mismatch");
  }

  #assertRecoveryObjectEpoch() {
    if (this.#recoveryObjectEpoch === null) return;
    const sql = this.ctx.storage.sql;
    if (!sql.exec("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'mapi_recovery_epoch'").toArray().length) throw new Error("Project recovery is not reconciled");
    let epoch;
    try { epoch = validateSourceRecoveryEpoch(this.ctx.storage); }
    catch { throw new Error("Project recovery is not reconciled"); }
    if (epoch !== this.#recoveryObjectEpoch) throw new Error("Project recovery is not reconciled");
  }

  async reserveMoveDestination(secret, route, moveId) {
    this.#assertRecoveryObjectEpoch();
    if (this.env.MAPI_RELOCATION_ENABLED !== "1" || !this.env.MAPI_RELOCATION_CONTROL_TOKEN ||
        !sameKey(secret, this.env.MAPI_RELOCATION_CONTROL_TOKEN)) throw new Error("Relocation control denied");
    if (canonicalOrigin(route?.origin) !== route.origin) throw new Error("Invalid destination origin");
    const registry = this.env.PROJECT_REGISTRY.getByName("projects");
    const { route: current, move } = await registry.relocationStatus(secret, route.projectId);
    if (!current || current.origin !== route.origin || current.project_id !== route.projectId || current.generation + 1 !== route.generation ||
        move?.phase !== "moving" || move.move_id !== moveId || move.destination_object !== route.objectName ||
        move.source_object !== current.object_name || move.generation !== current.generation) throw new Error("Destination is not reserved by registry");
    if (this.ctx.id.toString() !== this.env.NEXTGEN_APPLICATION.idFromName(route.objectName).toString()) throw new Error("Destination object identity mismatch");
    const result = reserveMoveDestination(this.ctx.storage, route, moveId);
    if (!this.ctx.storage.sql.exec("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'mapi_schema_version'").toArray().length) this.#initializeSchema(true);
    return result;
  }

  async armRelocation(secret, projectId, moveId) {
    if (this.env.MAPI_RELOCATION_ENABLED !== "1" || this.env.MAPI_FENCE_WRITERS_DRAINED !== "1" || !this.env.MAPI_RELOCATION_CONTROL_TOKEN || !sameKey(secret, this.env.MAPI_RELOCATION_CONTROL_TOKEN)) throw new Error("Fence adoption is not enabled");
    const { route, move } = await this.env.PROJECT_REGISTRY.getByName("projects").relocationStatus(secret, projectId);
    if (!route || move?.phase !== "moving" || move.move_id !== moveId || route.project_id !== projectId || route.object_name !== move.source_object || route.generation !== move.generation || this.ctx.id.toString() !== this.env.NEXTGEN_APPLICATION.idFromName(move.source_object).toString()) throw new Error("Source move is not reserved by registry");
    this.#assertRecoveryObjectEpoch();
    const sql = this.ctx.storage.sql;
    const projects = sql.exec("SELECT project_id FROM mapi_project LIMIT 2").toArray();
    const origins = sql.exec("SELECT origin FROM mapi_project_origin LIMIT 2").toArray();
    if (projects.length !== 1 || projects[0].project_id !== projectId || origins.length !== 1 || origins[0].origin !== route.origin) throw new Error("Source identity mismatch");
    if (sql.exec("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'mapi_owner_fence'").toArray().length) {
      const existing = sql.exec("SELECT * FROM mapi_owner_fence WHERE singleton = 1").toArray()[0];
      if (existing?.state === "frozen" && existing.project_id === projectId && existing.origin === route.origin && existing.object_name === route.object_name && existing.generation === route.generation && existing.move_id === moveId) { this.#fenceArmed = true; return; }
    }
    initializeOwnerFence(this.ctx.storage, { projectId, origin: route.origin, objectName: route.object_name, generation: route.generation }, true);
    this.#fenceArmed = true;
  }

  // Revoke an old active-source marker before the registry resets its cursor.
  // A source already frozen for this intent keeps its matching seal, allowing
  // a read-only rescan after a lost freeze acknowledgement.
  async prepareLegacyTextPreflightRecovery(secret, route, moveId, expected) {
    if (this.env.MAPI_RELOCATION_ENABLED !== "1" || this.env.MAPI_FENCE_WRITERS_DRAINED !== "1" || !this.env.MAPI_RELOCATION_CONTROL_TOKEN || !sameKey(secret, this.env.MAPI_RELOCATION_CONTROL_TOKEN)) throw new Error("Fence adoption is not enabled");
    if (!route || canonicalOrigin(route.origin) !== route.origin || this.ctx.id.toString() !== this.env.NEXTGEN_APPLICATION.idFromName(route.objectName).toString()) throw new Error("Invalid source route");
    const registry = this.env.PROJECT_REGISTRY.getByName("projects");
    const status = await registry.relocationStatus(secret, route.projectId);
    const legacy = await registry.legacyRelocationTextPreflightStatus(secret, route.projectId, moveId);
    if (!legacy || JSON.stringify(legacy) !== JSON.stringify(expected) || !status.route || status.route.state !== 'active' || status.route.project_id !== route.projectId || status.route.origin !== route.origin || status.route.object_name !== route.objectName || status.route.generation !== route.generation || status.intent?.move_id !== moveId || status.move?.phase === 'moving') throw new Error('Stale legacy TEXT preflight');
    const state = this.ctx.storage.transactionSync(() => {
      this.#assertRecoveryObjectEpoch();
      const sql = this.ctx.storage.sql;
      const objects = sql.exec("SELECT name, type FROM sqlite_schema WHERE lower(name) IN ('mapi_owner_fence', 'mapi_relocation_text_preflight_seal', 'mapi_chunk_export', 'mapi_chunk_export_data', 'mapi_chunk_import', 'mapi_chunk_import_data', 'mapi_chunk_import_fragment', 'mapi_chunk_import_fragment_data', 'mapi_chunk_import_stream', 'mapi_chunk_import_stream_data', 'mapi_relocation_project', 'mapi_destination_reservation', 'mapi_relocation_prepared')").toArray();
      for (const object of objects) {
        if (object.name.toLowerCase() === 'mapi_owner_fence' || object.name.toLowerCase() === 'mapi_relocation_text_preflight_seal') {
          if (object.type !== 'table') throw new Error('Invalid legacy source control state');
          continue;
        }
        if (object.type !== 'table' || sql.exec(`SELECT 1 FROM "${object.name}" LIMIT 1`).toArray().length) throw new Error('Legacy transfer state requires manual review');
      }
      const fence = objects.some(object => object.name.toLowerCase() === 'mapi_owner_fence') ? sql.exec('SELECT * FROM mapi_owner_fence LIMIT 2').toArray() : [];
      if (fence.length > 1) throw new Error('Invalid owner fence');
      const frozen = fence.length === 1 && fence[0].state === 'frozen' && fence[0].project_id === route.projectId && fence[0].origin === route.origin && fence[0].object_name === route.objectName && fence[0].generation === route.generation && fence[0].move_id === moveId;
      if (fence.length === 1 && !frozen && (fence[0].state !== 'active' || fence[0].project_id !== route.projectId || fence[0].origin !== route.origin || fence[0].object_name !== route.objectName || fence[0].generation !== route.generation)) throw new Error('Legacy source requires manual review');
      const marker = readTextPreflightMarker(this.ctx.storage);
      if (frozen) {
        if (marker !== legacy.marker || assertTextPreflightSeal(this.ctx.storage, route, moveId) !== marker) throw new Error('Legacy frozen source requires manual review');
      } else {
        if (objects.some(object => object.name.toLowerCase() === 'mapi_relocation_text_preflight_seal') || (marker && marker !== legacy.marker)) throw new Error('Legacy source marker differs');
        if (marker) invalidateTextPreflightMarker(this.ctx.storage);
      }
      validateRelocationSourceSchema(this.ctx.storage, route, { textGuard: true });
      return frozen ? 'frozen' : 'active';
    });
    return { projectId: route.projectId, origin: route.origin, objectName: route.objectName, generation: route.generation, moveId, objectId: this.ctx.id.toString(), state };
  }

  // Scan either an active source or a matching source frozen before an older
  // preflight acknowledgement reached the registry.
  async advanceRelocationTextPreflight(secret, route, moveId, checkpoint) {
    if (this.env.MAPI_RELOCATION_ENABLED !== "1" || this.env.MAPI_FENCE_WRITERS_DRAINED !== "1" || !this.env.MAPI_RELOCATION_CONTROL_TOKEN || !sameKey(secret, this.env.MAPI_RELOCATION_CONTROL_TOKEN)) throw new Error("Fence adoption is not enabled");
    if (!route || canonicalOrigin(route.origin) !== route.origin || this.ctx.id.toString() !== this.env.NEXTGEN_APPLICATION.idFromName(route.objectName).toString()) throw new Error("Invalid source route");
    const registry = this.env.PROJECT_REGISTRY.getByName("projects");
    const status = await registry.relocationStatus(secret, route.projectId);
    const saved = await registry.relocationTextPreflightStatus(secret, route.projectId, moveId);
    if (JSON.stringify(saved) !== JSON.stringify(checkpoint) || !status.route || status.route.state !== "active" || status.route.project_id !== route.projectId || status.route.origin !== route.origin || status.route.object_name !== route.objectName || status.route.generation !== route.generation || status.intent?.move_id !== moveId) throw new Error("Stale TEXT preflight");
    return this.ctx.storage.transactionSync(() => {
      this.#assertRecoveryObjectEpoch();
      const sql = this.ctx.storage.sql;
      const fence = sql.exec("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'mapi_owner_fence'").toArray().length ? sql.exec("SELECT * FROM mapi_owner_fence LIMIT 2").toArray() : [];
      const frozen = fence.length === 1 && fence[0].state === 'frozen' && fence[0].project_id === route.projectId && fence[0].origin === route.origin && fence[0].object_name === route.objectName && fence[0].generation === route.generation && fence[0].move_id === moveId;
      if (fence.length > 1 || fence.length === 1 && !frozen && (fence[0].state !== 'active' || fence[0].project_id !== route.projectId || fence[0].origin !== route.origin || fence[0].object_name !== route.objectName || fence[0].generation !== route.generation)) throw new Error("Source is not active");
      const hasSeal = sql.exec("SELECT 1 FROM sqlite_schema WHERE name = 'mapi_relocation_text_preflight_seal' COLLATE NOCASE LIMIT 1").toArray().length;
      if (frozen) assertTextPreflightSeal(this.ctx.storage, route, moveId);
      else if (hasSeal) throw new Error("Unexpected TEXT preflight seal");
      const tables = validateRelocationSourceSchema(this.ctx.storage, route, { textGuard: true });
      let marker = readTextPreflightMarker(this.ctx.storage);
      let cursor = checkpoint?.cursor ?? null;
      if (frozen && (!marker || checkpoint && marker !== checkpoint.marker)) throw new Error('Frozen TEXT preflight marker differs');
      if (!frozen && (!checkpoint || marker !== checkpoint.marker)) {
        if (marker) invalidateTextPreflightMarker(this.ctx.storage);
        marker = crypto.randomUUID().replaceAll('-', '');
        createTextPreflightMarker(this.ctx.storage, marker);
        cursor = null;
      }
      const result = advanceRelocationTextPreflight(this.ctx.storage, tables, cursor, { projectId: route.projectId, generation: route.generation, moveId });
      return { marker, checkpoint: result.checkpoint, done: result.done };
    });
  }

  async preFreezeRelocation(secret, route, moveId, marker) {
    if (this.env.MAPI_RELOCATION_ENABLED !== "1" || this.env.MAPI_FENCE_WRITERS_DRAINED !== "1" || !this.env.MAPI_RELOCATION_CONTROL_TOKEN || !sameKey(secret, this.env.MAPI_RELOCATION_CONTROL_TOKEN)) throw new Error("Fence adoption is not enabled");
    if (!route || canonicalOrigin(route.origin) !== route.origin || typeof moveId !== "string" || !moveId) throw new Error("Invalid source route");
    const registry = this.env.PROJECT_REGISTRY.getByName("projects");
    const { route: current, move, intent } = await registry.relocationStatus(secret, route.projectId);
    const checkpoint = await registry.relocationTextPreflightStatus(secret, route.projectId, moveId);
    if (!current || current.state !== "active" || current.project_id !== route.projectId || current.origin !== route.origin || current.object_name !== route.objectName || current.generation !== route.generation ||
        !intent || intent.project_id !== route.projectId || intent.origin !== route.origin || intent.source_object !== route.objectName || intent.generation !== route.generation || intent.move_id !== moveId ||
        (move?.phase === "moving" && (move.move_id !== moveId || move.source_object !== route.objectName || move.generation !== route.generation)) ||
        this.ctx.id.toString() !== this.env.NEXTGEN_APPLICATION.idFromName(route.objectName).toString()) throw new Error("Source route is not active");
    if (!checkpoint?.done || checkpoint.marker !== marker) throw new Error("TEXT preflight is incomplete");
    const outcome = this.ctx.storage.transactionSync(() => {
      this.#assertRecoveryObjectEpoch();
      const sql = this.ctx.storage.sql;
      const hasFence = sql.exec("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'mapi_owner_fence'").toArray().length;
      const existing = hasFence ? sql.exec("SELECT * FROM mapi_owner_fence WHERE singleton = 1").toArray()[0] : null;
      if (existing?.state === "frozen" && existing.project_id === route.projectId && existing.origin === route.origin && existing.object_name === route.objectName && existing.generation === route.generation && existing.move_id === moveId) {
        if (assertTextPreflightSeal(this.ctx.storage, route, moveId) !== marker) throw new Error('TEXT preflight seal mismatch');
        return 'frozen';
      }
      if (readTextPreflightMarker(this.ctx.storage) !== marker) return 'stale';
      validateRelocationSourceSchema(this.ctx.storage, route, { textGuard: true });
      initializeOwnerFence(this.ctx.storage, route);
      writeTextPreflightSeal(this.ctx.storage, route, moveId, marker);
      freezeOwnerFence(this.ctx.storage, route, moveId);
      return 'frozen';
    });
    if (outcome === 'stale') return { state: 'stale' };
    this.#fenceArmed = true;
    return { projectId: route.projectId, origin: route.origin, objectName: route.objectName, generation: route.generation, moveId, state: "frozen", objectId: this.ctx.id.toString() };
  }

  async freezeRelocation(secret, route, moveId) {
    this.#assertRecoveryObjectEpoch();
    if (this.env.MAPI_RELOCATION_ENABLED !== "1" || !this.env.MAPI_RELOCATION_CONTROL_TOKEN ||
        !sameKey(secret, this.env.MAPI_RELOCATION_CONTROL_TOKEN)) throw new Error("Relocation control denied");
    if (canonicalOrigin(route?.origin) !== route.origin) throw new Error("Invalid source origin");
    const registry = this.env.PROJECT_REGISTRY.getByName("projects");
    const { route: current, move } = await registry.relocationStatus(secret, route.projectId);
    if (!current || current.origin !== route.origin || current.project_id !== route.projectId || current.object_name !== route.objectName ||
        current.generation !== route.generation || move?.phase !== "moving" || move.move_id !== moveId ||
        move.source_object !== route.objectName || move.generation !== route.generation) throw new Error("Source move is not reserved by registry");
    if (this.ctx.id.toString() !== this.env.NEXTGEN_APPLICATION.idFromName(route.objectName).toString()) throw new Error("Source object identity mismatch");
    this.#assertRecoveryObjectEpoch();
    return freezeOwnerFence(this.ctx.storage, route, moveId, true);
  }

  async armRecovery(secret, projectId, recoveryId) {
    if (this.env.MAPI_RELOCATION_ENABLED !== "1" || this.env.MAPI_FENCE_WRITERS_DRAINED !== "1" || !this.env.MAPI_RELOCATION_CONTROL_TOKEN || !sameKey(secret, this.env.MAPI_RELOCATION_CONTROL_TOKEN)) throw new Error("Recovery fence adoption is not enabled");
    const registry = this.env.PROJECT_REGISTRY.getByName("projects");
    const recovery = await registry.recoveryStatus(secret, projectId);
    if (!recovery || recovery.phase !== "closing" || recovery.recovery_id !== recoveryId || recovery.object_id !== this.ctx.id.toString()) throw new Error("Recovery is not reserved by registry");
    const { route } = await registry.relocationStatus(secret, projectId);
    if (!route || route.project_id !== projectId || route.origin !== recovery.origin || route.object_name !== recovery.object_name || route.generation !== recovery.generation || this.env.NEXTGEN_APPLICATION.idFromName(recovery.object_name).toString() !== this.ctx.id.toString()) throw new Error("Recovery route mismatch");
    this.#assertRecoveryObjectEpoch();
    const sql = this.ctx.storage.sql;
    const projects = sql.exec("SELECT project_id FROM mapi_project").toArray();
    const origins = sql.exec("SELECT origin FROM mapi_project_origin").toArray();
    if (projects.length !== 1 || projects[0].project_id !== projectId || origins.length !== 1 || origins[0].origin !== recovery.origin) throw new Error("Recovery source identity mismatch");
    const epochs = sql.exec('SELECT epoch FROM mapi_recovery_epoch').toArray();
    if (epochs.length !== 1 || epochs[0].epoch === recovery.epoch) throw new Error('Recovery epoch is not fresh');
    if (sql.exec("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'mapi_owner_fence'").toArray().length) {
      const fence = sql.exec("SELECT * FROM mapi_owner_fence WHERE singleton = 1").toArray()[0];
      if (fence?.state === "frozen" && fence.project_id === projectId && fence.origin === recovery.origin && fence.object_name === recovery.object_name && fence.generation === recovery.generation && fence.move_id === `recovery:${recoveryId}`) { this.#fenceArmed = true; return; }
    }
    initializeOwnerFence(this.ctx.storage, { projectId, origin: recovery.origin, objectName: recovery.object_name, generation: recovery.generation }, true);
    this.#fenceArmed = true;
  }

  async freezeRecovery(secret, projectId, recoveryId) {
    if (this.env.MAPI_RELOCATION_ENABLED !== "1" || this.env.MAPI_FENCE_WRITERS_DRAINED !== "1" || !this.env.MAPI_RELOCATION_CONTROL_TOKEN ||
        !sameKey(secret, this.env.MAPI_RELOCATION_CONTROL_TOKEN)) throw new Error("Recovery control denied");
    const recovery = await this.env.PROJECT_REGISTRY.getByName("projects").recoveryStatus(secret, projectId);
    if (!recovery || recovery.phase !== "closing" || recovery.recovery_id !== recoveryId || recovery.object_id !== this.ctx.id.toString()) throw new Error("Recovery is not reserved by registry");
    this.#assertRecoveryObjectEpoch();
    const epochs = this.ctx.storage.sql.exec('SELECT epoch FROM mapi_recovery_epoch').toArray();
    if (epochs.length !== 1 || epochs[0].epoch === recovery.epoch) throw new Error('Recovery epoch is not fresh');
    return freezeOwnerFence(this.ctx.storage, { projectId, origin: recovery.origin, objectName: recovery.object_name, generation: recovery.generation }, `recovery:${recoveryId}`, true);
  }

  async recoveryClockAttestation(secret, projectId, recoveryId) {
    if (this.env.MAPI_RELOCATION_ENABLED !== "1" || !this.env.MAPI_RELOCATION_CONTROL_TOKEN ||
        !sameKey(secret, this.env.MAPI_RELOCATION_CONTROL_TOKEN)) throw new Error("Recovery control denied");
    const recovery = await this.env.PROJECT_REGISTRY.getByName("projects").recoveryStatus(secret, projectId);
    if (!recovery || recovery.phase !== "closing" || recovery.recovery_id !== recoveryId || recovery.object_id !== this.ctx.id.toString()) throw new Error("Recovery is not reserved by registry");
    return this.ctx.storage.transactionSync(() => {
      const sql = this.ctx.storage.sql;
      const fence = sql.exec("SELECT project_id, object_name, generation, state, move_id FROM mapi_owner_fence WHERE singleton = 1").toArray()[0];
      if (!fence || fence.project_id !== projectId || fence.object_name !== recovery.object_name || fence.generation !== recovery.generation ||
          fence.state !== "frozen" || fence.move_id !== `recovery:${recoveryId}`) throw new Error("Recovery owner is not frozen");
      const clocks = sql.exec("SELECT name FROM sqlite_schema WHERE type = 'table' AND name IN ('mapi_timestamp_clock', 'mapi_revision_clock')").toArray();
      if (clocks.length !== 1) throw new Error("Recovery clock is not initialized or is ambiguous");
      const clockKind = clocks[0].name === 'mapi_revision_clock' ? 'revision' : 'timestamp';
      const clock = sql.exec(`SELECT id, typeof(stamp) AS stamp_type, printf('%lld', stamp) AS highwater FROM ${clocks[0].name}`).toArray();
      if (clock.length !== 1 || clock[0].id !== 1 || clock[0].stamp_type !== 'integer') throw new Error("Recovery clock is not initialized");
      if (clockKind === 'revision') {
        const schema = sql.exec("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'mapi_revision_scopes'").toArray()[0];
        if (schema?.sql !== 'CREATE TABLE mapi_revision_scopes (scope TEXT PRIMARY KEY, stamp INTEGER NOT NULL)' || !sql.exec('SELECT 1 FROM mapi_revision_scopes LIMIT 1').toArray().length) throw new Error("Recovery revision scopes are invalid");
      }
      return { objectId: this.ctx.id.toString(), generation: fence.generation, clockKind, highwater: clock[0].highwater };
    });
  }

  async recoveryScopePage(secret, projectId, recoveryId, cursor = null) {
    if (this.env.MAPI_RELOCATION_ENABLED !== "1" || !this.env.MAPI_RELOCATION_CONTROL_TOKEN || !sameKey(secret, this.env.MAPI_RELOCATION_CONTROL_TOKEN)) throw new Error("Recovery control denied");
    const recovery = await this.env.PROJECT_REGISTRY.getByName("projects").recoveryStatus(secret, projectId);
    if (!recovery || recovery.phase !== 'anchored' || recovery.clock_kind !== 'revision' || recovery.recovery_id !== recoveryId || recovery.object_id !== this.ctx.id.toString()) throw new Error('Recovery is not anchored by registry');
    this.#assertRecoveryObjectEpoch();
    return this.ctx.storage.transactionSync(() => {
      const sql = this.ctx.storage.sql;
      const fence = sql.exec('SELECT project_id, object_name, generation, state, move_id FROM mapi_owner_fence WHERE singleton = 1').toArray()[0];
      const clock = sql.exec("SELECT printf('%lld', stamp) AS stamp FROM mapi_revision_clock WHERE id = 1 AND typeof(stamp) = 'integer'").toArray();
      if (!fence || fence.project_id !== projectId || fence.object_name !== recovery.object_name || fence.generation !== recovery.generation || fence.state !== 'frozen' || fence.move_id !== `recovery:${recoveryId}` || clock.length !== 1 || clock[0].stamp !== recovery.clock_highwater) throw new Error('Recovery owner is not frozen at anchored clock');
      return assertRecoveryEnvelope(readOwnerRecoveryScopes(sql, projectId, cursor));
    });
  }

  // Rehydrates only clock metadata. It never updates the recovery epoch or
  // reopens the route; a separate coordinated recovery protocol is required.
  async stageRecoveryScopes(secret, projectId, recoveryId) {
    if (this.env.MAPI_RELOCATION_ENABLED !== '1' || this.env.MAPI_RECOVERY_STAGING_ENABLED !== '1' || this.env.MAPI_FENCE_WRITERS_DRAINED !== '1' || !this.env.MAPI_RELOCATION_CONTROL_TOKEN || !sameKey(secret, this.env.MAPI_RELOCATION_CONTROL_TOKEN)) throw new Error('Recovery staging is not enabled');
    const registry = this.env.PROJECT_REGISTRY.getByName('projects');
    const recovery = await registry.recoveryStatus(secret, projectId);
    if (!recovery || recovery.recovery_id !== recoveryId || recovery.phase !== 'anchored' || recovery.clock_kind !== 'revision' || recovery.object_id !== this.ctx.id.toString() || this.#recoveryObjectEpoch !== recovery.epoch || !Number.isSafeInteger(recovery.generation) || recovery.generation < 1 || recovery.generation === Number.MAX_SAFE_INTEGER) throw new Error('Recovery staging authority mismatch');
    const sql = this.ctx.storage.sql;
    const hasStage = sql.exec("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'mapi_recovery_scope_stage'").toArray().length;
    const prior = hasStage ? sql.exec('SELECT * FROM mapi_recovery_scope_stage WHERE singleton = 1').toArray()[0] : null;
    if (hasStage && !prior) throw new Error('Recovery staging marker is invalid');
    const snapshot = await registry.recoveryScopeSnapshot(secret, projectId, recoveryId, prior?.cursor ?? null);
    if (snapshot.recovery.object_id !== recovery.object_id || snapshot.recovery.epoch !== recovery.epoch || snapshot.recovery.generation !== recovery.generation || snapshot.recovery.clock_highwater !== recovery.clock_highwater || !validRecoveryStamp(recovery.clock_highwater)) throw new Error('Recovery anchor changed');
    const nextDigest = prior?.done ? prior.running_digest : await recoveryPageDigest(prior?.running_digest ?? '', projectId, recoveryId, snapshot.page);
    const result = this.ctx.storage.transactionSync(() => {
      invalidateTextPreflightMarker(this.ctx.storage);
      const project = sql.exec('SELECT project_id FROM mapi_project').toArray();
      const origins = sql.exec('SELECT origin FROM mapi_project_origin').toArray();
      const epochs = sql.exec('SELECT epoch FROM mapi_recovery_epoch').toArray();
      if (project.length !== 1 || project[0].project_id !== projectId || origins.length !== 1 || origins[0].origin !== recovery.origin || epochs.length !== 1 || epochs[0].epoch === recovery.epoch) throw new Error('Restored project identity or epoch mismatch');
      const versions = sql.exec('SELECT version FROM mapi_schema_version').toArray();
      if (versions.length !== 1 || ![baseline.version, 2].includes(versions[0].version)) throw new Error('Restored application schema is unsupported');
      const definitions = sql.exec("SELECT name, sql FROM sqlite_schema WHERE type = 'table' AND name IN ('mapi_revision_clock', 'mapi_revision_scopes')").toArray();
      const clockDDL = 'CREATE TABLE mapi_revision_clock (id INTEGER PRIMARY KEY CHECK (id = 1), stamp INTEGER NOT NULL)';
      const scopesDDL = 'CREATE TABLE mapi_revision_scopes (scope TEXT PRIMARY KEY, stamp INTEGER NOT NULL)';
      if (definitions.length !== 2 || !definitions.some(row => row.name === 'mapi_revision_clock' && row.sql === clockDDL) || !definitions.some(row => row.name === 'mapi_revision_scopes' && row.sql === scopesDDL)) throw new Error('Restored revision clock schema is unsupported');
      const clock = sql.exec("SELECT id, typeof(stamp) AS kind, printf('%lld', stamp) AS stamp FROM mapi_revision_clock").toArray();
      if (clock.length !== 1 || clock[0].id !== 1 || clock[0].kind !== 'integer' || !validRecoveryStamp(clock[0].stamp)) throw new Error('Restored revision clock is invalid');
      const existing = sql.exec("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'mapi_recovery_scope_stage'").toArray().length;
      if (!existing) {
        const hasFence = sql.exec("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'mapi_owner_fence'").toArray().length;
        if (hasFence) {
          const fence = sql.exec('SELECT * FROM mapi_owner_fence WHERE singleton = 1').toArray()[0];
          if (!fence || fence.project_id !== projectId || fence.origin !== recovery.origin || fence.object_name !== recovery.object_name || fence.generation !== recovery.generation || !['active', 'frozen'].includes(fence.state) || (fence.state === 'frozen' && fence.move_id !== `recovery:${recoveryId}`)) throw new Error('Restored owner fence mismatch');
        } else createOwnerFenceTable(this.ctx.storage);
        if (hasFence) sql.exec("UPDATE mapi_owner_fence SET generation = ?, state = 'frozen', move_id = ?, digest = NULL WHERE singleton = 1", recovery.generation + 1, `recovery:${recoveryId}`);
        else sql.exec("INSERT INTO mapi_owner_fence VALUES (1, ?, ?, ?, ?, 'frozen', ?, NULL)", projectId, recovery.origin, recovery.object_name, recovery.generation + 1, `recovery:${recoveryId}`);
        sql.exec('CREATE TABLE mapi_recovery_scope_stage (singleton INTEGER PRIMARY KEY, project_id TEXT NOT NULL, recovery_id TEXT NOT NULL, generation INTEGER NOT NULL, epoch TEXT NOT NULL, digest TEXT NOT NULL, cursor TEXT, row_count INTEGER NOT NULL, done INTEGER NOT NULL, running_digest TEXT NOT NULL, restored_cursor TEXT, restored_count INTEGER NOT NULL, restored_done INTEGER NOT NULL)');
        sql.exec("INSERT INTO mapi_recovery_scope_stage VALUES (1, ?, ?, ?, ?, ?, NULL, 0, 0, '', NULL, 0, 0)", projectId, recoveryId, recovery.generation + 1, recovery.epoch, snapshot.digest);
      }
      const stage = sql.exec('SELECT * FROM mapi_recovery_scope_stage WHERE singleton = 1').toArray()[0];
      const fence = sql.exec('SELECT * FROM mapi_owner_fence WHERE singleton = 1').toArray()[0];
      if (!stage || stage.project_id !== projectId || stage.recovery_id !== recoveryId || stage.generation !== recovery.generation + 1 || stage.epoch !== recovery.epoch || stage.digest !== snapshot.digest || stage.cursor !== (prior?.cursor ?? null) || stage.running_digest !== (prior?.running_digest ?? '') || !fence || fence.state !== 'frozen' || fence.project_id !== projectId || fence.origin !== recovery.origin || fence.object_name !== recovery.object_name || fence.generation !== stage.generation || fence.move_id !== `recovery:${recoveryId}`) throw new Error('Recovery staging checkpoint mismatch');
      if (!stage.restored_done) {
        const restored = readOwnerRecoveryScopes(sql, projectId, stage.restored_cursor);
        for (const row of restored.rows) if (BigInt(row.stamp) > BigInt(clock[0].stamp)) throw new Error('Restored revision clock is below a scope');
        const restoredCount = stage.restored_count + restored.rows.length;
        if (restored.done && !restoredCount) throw new Error('Restored revision scopes are empty');
        sql.exec('UPDATE mapi_recovery_scope_stage SET restored_cursor = ?, restored_count = ?, restored_done = ? WHERE singleton = 1', restored.cursor, restoredCount, restored.done ? 1 : 0);
        return { done: false, phase: 'validating', count: stage.row_count, digest: stage.digest };
      }
      if (stage.done) return { done: true, count: stage.row_count, digest: stage.digest };
      if (!snapshot.page || !Array.isArray(snapshot.page.rows) || !snapshot.page.rows.length && !snapshot.page.done) throw new Error('Invalid anchored recovery page');
      for (const row of snapshot.page.rows) {
        validateRecoveryScope(row.scope, projectId, sql);
        if (!validRecoveryStamp(row.stamp) || BigInt(row.stamp) > BigInt(recovery.clock_highwater)) throw new Error('Invalid anchored recovery scope');
        sql.exec('INSERT INTO mapi_revision_scopes VALUES (?, CAST(? AS INTEGER)) ON CONFLICT(scope) DO UPDATE SET stamp = max(stamp, excluded.stamp)', row.scope, row.stamp);
      }
      sql.exec('UPDATE mapi_revision_clock SET stamp = max(stamp, CAST(? AS INTEGER)) WHERE id = 1', recovery.clock_highwater);
      const count = stage.row_count + snapshot.page.rows.length;
      if (snapshot.page.done && (count !== snapshot.count || nextDigest !== snapshot.digest)) throw new Error('Recovery scope count or digest mismatch');
      sql.exec('UPDATE mapi_recovery_scope_stage SET cursor = ?, row_count = ?, done = ?, running_digest = ? WHERE singleton = 1', snapshot.page.cursor, count, snapshot.page.done ? 1 : 0, nextDigest);
      return { done: snapshot.page.done, count, digest: stage.digest };
    });
    this.#fenceArmed = true;
    return result;
  }

  relocationAttestation(secret, projectId) {
    if (this.env.MAPI_RELOCATION_ENABLED !== "1" || !this.env.MAPI_RELOCATION_CONTROL_TOKEN ||
        !sameKey(secret, this.env.MAPI_RELOCATION_CONTROL_TOKEN)) throw new Error("Relocation control denied");
    const sql = this.ctx.storage.sql;
    const names = sql.exec("SELECT name FROM sqlite_schema WHERE type = 'table' AND name IN ('mapi_owner_fence', 'mapi_relocation_project', 'mapi_destination_reservation')").toArray().map(row => row.name);
    const source = names.includes("mapi_owner_fence") ? sql.exec("SELECT project_id, object_name, generation, state, move_id, digest FROM mapi_owner_fence WHERE singleton = 1 AND project_id = ?", projectId).toArray()[0] : null;
    const destination = names.includes("mapi_relocation_project") ? sql.exec("SELECT project_id, object_name, generation, state, move_id, digest FROM mapi_relocation_project WHERE project_id = ?", projectId).toArray()[0] : null;
    if (source && destination) throw new Error("Conflicting owner state");
    if (destination) {
      const reservation = names.includes("mapi_destination_reservation") ? sql.exec("SELECT project_id, object_name, generation, move_id FROM mapi_destination_reservation WHERE singleton = 1").toArray()[0] : null;
      if (!reservation || reservation.project_id !== projectId || reservation.object_name !== destination.object_name ||
          reservation.generation !== destination.generation || reservation.move_id !== destination.move_id) throw new Error("Destination reservation mismatch");
    }
    return source ?? destination ?? null;
  }

  async relocationManifest(secret, projectId, moveId) {
    this.#assertRecoveryObjectEpoch();
    if (this.env.MAPI_RELOCATION_ENABLED !== "1" || !this.env.MAPI_RELOCATION_CONTROL_TOKEN ||
        !sameKey(secret, this.env.MAPI_RELOCATION_CONTROL_TOKEN)) throw new Error("Relocation control denied");
    const registry = this.env.PROJECT_REGISTRY.getByName("projects");
    const { route, move } = await registry.relocationStatus(secret, projectId);
    if (!route || move?.phase !== "moving" || move.move_id !== moveId || move.source_object !== route.object_name ||
        move.generation !== route.generation) throw new Error("Stale relocation");
    if (this.ctx.id.toString() !== this.env.NEXTGEN_APPLICATION.idFromName(move.source_object).toString()) throw new Error("Source object identity mismatch");
    const preflight = await registry.relocationTextPreflightStatus(secret, projectId, moveId);
    if (!preflight?.done) throw new Error("TEXT preflight is incomplete");
    this.#assertRecoveryObjectEpoch();
    const source = this.relocationAttestation(secret, projectId);
    if (source?.state !== "frozen" || source.move_id !== moveId || source.generation !== move.generation || source.object_name !== move.source_object) throw new Error("Source is not frozen for this move");
    const sourceRoute = { projectId, origin: route.origin, objectName: move.source_object, generation: move.generation };
    const manifest = this.ctx.storage.transactionSync(() => {
      if (assertTextPreflightSeal(this.ctx.storage, sourceRoute, moveId) !== preflight.marker) throw new Error('TEXT preflight seal mismatch');
      const cached = this.#relocationManifestCache;
      if (cached && cached.projectId === projectId && cached.origin === route.origin && cached.objectName === move.source_object && cached.generation === move.generation && cached.moveId === moveId) return cached;
      return inspectRelocationSource(this.ctx.storage, sourceRoute, moveId, { textGuard: true });
    });
    this.#relocationManifestCache = manifest;
    return manifest;
  }

  async relocationReconcile(secret, projectId, moveId, table, cursor = null) {
    if (this.env.MAPI_RELOCATION_ENABLED !== "1" || !this.env.MAPI_RELOCATION_CONTROL_TOKEN ||
        !sameKey(secret, this.env.MAPI_RELOCATION_CONTROL_TOKEN)) throw new Error("Relocation control denied");
    const { route, move } = await this.env.PROJECT_REGISTRY.getByName("projects").relocationStatus(secret, projectId);
    if (!route || move?.phase !== "moving" || move.move_id !== moveId || move.source_object !== route.object_name ||
        move.generation !== route.generation) throw new Error("Stale relocation");
    const namespace = this.env.NEXTGEN_APPLICATION;
    const sourceId = namespace.idFromName(move.source_object).toString();
    const destinationId = namespace.idFromName(move.destination_object).toString();
    const objectId = this.ctx.id.toString();
    if (objectId !== sourceId && objectId !== destinationId) throw new Error("Owner object identity mismatch");
    const manifest = objectId === sourceId
      ? await this.relocationManifest(secret, projectId, moveId)
      : await namespace.getByName(move.source_object).relocationManifest(secret, projectId, moveId);
    const checkpoint = objectId === sourceId ? chunkExportStatus(this.ctx.storage, projectId) : chunkImportStatus(this.ctx.storage, projectId);
    if (checkpoint?.move_id !== moveId || !checkpoint.done) throw new Error("Relocation transfer is incomplete");
    assertRelocationTextGuard(checkpoint);
    if (objectId === destinationId) {
      const destination = this.relocationAttestation(secret, projectId);
      if (destination?.state !== "staged" || destination.move_id !== moveId || destination.generation !== move.generation + 1 || destination.object_name !== move.destination_object) throw new Error("Destination is not staged for this move");
      if (this.#relocationValidatedDestination !== moveId) {
        inspectRelocationDestination(this.ctx.storage, manifest);
        this.#relocationValidatedDestination = moveId;
      }
    }
    return digestRelocationPage(this.ctx.storage, manifest, objectId === sourceId ? "source" : "destination", table, cursor);
  }

  async #relocationDestination(secret, projectId, moveId) {
    this.#assertRecoveryObjectEpoch();
    if (this.env.MAPI_RELOCATION_ENABLED !== "1" || !this.env.MAPI_RELOCATION_CONTROL_TOKEN ||
        !sameKey(secret, this.env.MAPI_RELOCATION_CONTROL_TOKEN)) throw new Error("Relocation control denied");
    const { route, move } = await this.env.PROJECT_REGISTRY.getByName("projects").relocationStatus(secret, projectId);
    if (!route || move?.phase !== "moving" || move.move_id !== moveId || move.source_object !== route.object_name ||
        move.generation !== route.generation || this.ctx.id.toString() !== this.env.NEXTGEN_APPLICATION.idFromName(move.destination_object).toString()) throw new Error("Destination move is not reserved by registry");
    const manifest = await this.env.NEXTGEN_APPLICATION.getByName(move.source_object).relocationManifest(secret, projectId, moveId);
    this.#assertRecoveryObjectEpoch();
    return { route, move, manifest };
  }

  async prepareRelocation(secret, projectId, moveId) {
    const { route, move, manifest } = await this.#relocationDestination(secret, projectId, moveId);
    return prepareRelocationDestination(this.ctx.storage, manifest, { projectId, origin: route.origin, objectName: move.destination_object, generation: move.generation + 1 });
  }

  async beginRelocationExport(secret, projectId, moveId) {
    const manifest = await this.relocationManifest(secret, projectId, moveId);
    return beginChunkExport(this.ctx.storage, projectId, manifest.generation, moveId, manifest.tables);
  }

  async exportRelocationChunk(secret, projectId, moveId, index) {
    const manifest = await this.relocationManifest(secret, projectId, moveId);
    const chunk = await exportChunk(this.ctx.storage, projectId, manifest.generation, moveId, index);
    return { ...chunk, text_guard: RELOCATION_TEXT_GUARD_VERSION };
  }

  async relocationSourceHistoryStatus(secret, projectId, moveId, digest) {
    const manifest = await this.relocationManifest(secret, projectId, moveId);
    return transferHistoryStatus(this.ctx.storage, 'source', { projectId, origin: manifest.origin, objectName: manifest.objectName, generation: manifest.generation }, moveId, digest);
  }

  async relocationSourceHistory(secret, projectId, moveId, digest, index) {
    const manifest = await this.relocationManifest(secret, projectId, moveId);
    const result = await sourceTransferHistory(this.ctx.storage, { projectId, origin: manifest.origin, objectName: manifest.objectName, generation: manifest.generation }, moveId, digest, index);
    this.#assertRecoveryObjectEpoch();
    return result;
  }

  async relocationDestinationHistoryStatus(secret, projectId, moveId, digest) {
    const { route, move } = await this.#relocationDestination(secret, projectId, moveId);
    return transferHistoryStatus(this.ctx.storage, 'destination', { projectId, origin: route.origin, objectName: move.destination_object, generation: move.generation }, moveId, digest);
  }

  async relocationDestinationHistory(secret, projectId, moveId, digest, index) {
    const { route, move } = await this.#relocationDestination(secret, projectId, moveId);
    return destinationTransferHistory(this.ctx.storage, { projectId, origin: route.origin, objectName: move.destination_object, generation: move.generation }, moveId, digest, index);
  }

  async beginRelocationImport(secret, projectId, moveId) {
    const { move, manifest } = await this.#relocationDestination(secret, projectId, moveId);
    const prepared = this.ctx.storage.sql.exec("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'mapi_relocation_prepared'").toArray().length;
    if (!prepared) throw new Error("Destination has not been prepared");
    return beginChunkImport(this.ctx.storage, projectId, manifest.generation, moveId, move.destination_object, manifest.tables);
  }

  async relocationImportStatus(secret, projectId, moveId) {
    await this.#relocationDestination(secret, projectId, moveId);
    const status = chunkImportStatus(this.ctx.storage, projectId);
    if (!status || status.move_id !== moveId) throw new Error("Relocation import is not initialized");
    assertRelocationTextGuard(status);
    return status;
  }

  async importRelocationChunk(secret, projectId, moveId, index) {
    const { move } = await this.#relocationDestination(secret, projectId, moveId);
    const chunk = await this.env.NEXTGEN_APPLICATION.getByName(move.source_object).exportRelocationChunk(secret, projectId, moveId, index);
    assertRelocationTextGuard(chunk);
    return importChunk(this.ctx.storage, projectId, chunk);
  }

  async restoreRelocationMetadata(secret, projectId, moveId) {
    const { manifest } = await this.#relocationDestination(secret, projectId, moveId);
    return restoreRelocationMetadata(this.ctx.storage, manifest);
  }

  async activateRelocation(secret, projectId, moveId) {
    if (this.env.MAPI_RELOCATION_ENABLED !== "1" || !this.env.MAPI_RELOCATION_CONTROL_TOKEN || !sameKey(secret, this.env.MAPI_RELOCATION_CONTROL_TOKEN)) throw new Error("Relocation control denied");
    const { route, move } = await this.env.PROJECT_REGISTRY.getByName("projects").relocationStatus(secret, projectId);
    if (!route || move?.phase !== "committed" || move.move_id !== moveId || route.object_name !== move.destination_object || route.generation !== move.generation + 1 || this.ctx.id.toString() !== this.env.NEXTGEN_APPLICATION.idFromName(move.destination_object).toString()) throw new Error("Destination is not committed");
    if (!move.reconciliationReady && !move.finalized) throw new Error("Legacy committed relocation requires manual review");
    this.#assertRecoveryObjectEpoch();
    this.ctx.storage.transactionSync(() => {
      const sql = this.ctx.storage.sql;
      const exists = sql.exec("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'mapi_owner_fence'").toArray().length;
      if (exists) {
        const fence = sql.exec("SELECT * FROM mapi_owner_fence WHERE singleton = 1").toArray()[0];
        if (!fence || fence.state !== "active" || fence.project_id !== projectId || fence.origin !== route.origin || fence.object_name !== route.object_name || fence.generation !== route.generation || fence.move_id !== moveId || fence.digest !== move.digest) throw new Error("Conflicting destination activation");
        return;
      }
      if (!move.reconciliationReady) throw new Error("Legacy committed relocation requires manual review");
      const staged = sql.exec("SELECT * FROM mapi_relocation_project WHERE project_id = ?", projectId).toArray()[0];
      const reservation = sql.exec("SELECT * FROM mapi_destination_reservation WHERE singleton = 1").toArray()[0];
      if (!staged || staged.state !== "staged" || staged.move_id !== moveId || staged.generation !== route.generation || staged.object_name !== route.object_name || staged.digest !== move.digest || !reservation || reservation.project_id !== projectId || reservation.origin !== route.origin || reservation.object_name !== route.object_name || reservation.generation !== route.generation || reservation.move_id !== moveId) throw new Error("Destination stage mismatch");
      createOwnerFenceTable(this.ctx.storage);
      sql.exec("INSERT INTO mapi_owner_fence VALUES (1, ?, ?, ?, ?, 'active', ?, ?)", projectId, route.origin, route.object_name, route.generation, moveId, move.digest);
      sql.exec("DELETE FROM mapi_relocation_project WHERE project_id = ?", projectId);
      sql.exec("DELETE FROM mapi_destination_reservation WHERE singleton = 1");
    });
    this.#fenceArmed = true;
  }

  async retireRelocation(secret, projectId, moveId) {
    if (this.env.MAPI_RELOCATION_ENABLED !== "1" || !this.env.MAPI_RELOCATION_CONTROL_TOKEN || !sameKey(secret, this.env.MAPI_RELOCATION_CONTROL_TOKEN)) throw new Error("Relocation control denied");
    const { route, move } = await this.env.PROJECT_REGISTRY.getByName("projects").relocationStatus(secret, projectId);
    if (!route || move?.phase !== "committed" || move.move_id !== moveId || route.object_name !== move.destination_object || route.generation !== move.generation + 1 || this.ctx.id.toString() !== this.env.NEXTGEN_APPLICATION.idFromName(move.source_object).toString()) throw new Error("Source retirement is not committed");
    if (!move.reconciliationReady && !move.finalized) throw new Error("Legacy committed relocation requires manual review");
    this.#assertRecoveryObjectEpoch();
    retireOwnerFence(this.ctx.storage, { projectId, origin: route.origin, objectName: move.source_object, generation: move.generation }, moveId, move.digest, move.reconciliationReady);
  }

  #assertRecoveryInvalidation() {
    const auth = this.#recoveryAuthority;
    if (!auth || this.#recoveryObjectEpoch !== auth.epoch) throw new Error('Recovery invalidation authority missing');
    const sql = this.ctx.storage.sql;
    const fence = sql.exec('SELECT * FROM mapi_owner_fence WHERE singleton = 1').toArray()[0];
    const stage = sql.exec('SELECT * FROM mapi_recovery_scope_stage WHERE singleton = 1').toArray()[0];
    const epochs = sql.exec('SELECT epoch FROM mapi_recovery_epoch').toArray();
    if (!fence || fence.project_id !== auth.projectId || fence.origin !== auth.origin || fence.object_name !== auth.objectName || fence.generation !== auth.generation || fence.state !== 'frozen' || fence.move_id !== `recovery:${auth.recoveryId}` || !stage || stage.project_id !== auth.projectId || stage.recovery_id !== auth.recoveryId || stage.epoch !== auth.epoch || stage.generation !== auth.generation || !stage.restored_done || !stage.done || stage.digest !== auth.digest || stage.running_digest !== auth.digest || stage.row_count !== auth.count || epochs.length !== 1 || epochs[0].epoch === auth.epoch) throw new Error('Recovery invalidation fence mismatch');
  }

  async advanceRecoveryInvalidation(secret, projectId, recoveryId) {
    if (this.env.MAPI_LOCAL_TEST !== '1' || this.env.MAPI_RELOCATION_ENABLED !== '1' || this.env.MAPI_RECOVERY_INVALIDATION_ENABLED !== '1' || this.env.MAPI_FENCE_WRITERS_DRAINED !== '1' || !this.env.MAPI_RELOCATION_CONTROL_TOKEN || !sameKey(secret, this.env.MAPI_RELOCATION_CONTROL_TOKEN)) throw new Error('Recovery invalidation is not enabled');
    const registry = this.env.PROJECT_REGISTRY.getByName('projects');
    const status = await registry.recoveryScopeStatus(secret, projectId, recoveryId);
    const rec = status.recovery;
    if (rec.object_id !== this.ctx.id.toString() || this.#recoveryObjectEpoch !== rec.epoch || !Number.isSafeInteger(rec.generation) || rec.generation === Number.MAX_SAFE_INTEGER) throw new Error('Recovery invalidation authority mismatch');
    this.#recoveryAuthority = { projectId, recoveryId, origin: rec.origin, objectName: rec.object_name, generation: rec.generation + 1, epoch: rec.epoch, digest: status.digest, count: status.count };
    try { this.#initialize(); return this.#call('mapi_recover_batch', { projectId, recoveryId }); }
    finally { this.#recoveryAuthority = undefined; }
  }

  #withRoute(route, callback) {
    this.#detectFence();
    if (!this.#fenceArmed) return callback();
    const previous = this.#authority;
    this.#authority = route;
    try { return callback(); } finally { this.#authority = previous; }
  }

  #initialize() {
    if (this.#reactor) return;
    const attempt = ++this.#reactorAttempts;
    const diagnostics = this.env.MAPI_RUNTIME_DIAGNOSTICS === "1";
    const logLifecycle = (phase) => {
      // Even metadata acquisition is best effort and must not affect the
      // initialization result if diagnostics or its sink are unavailable.
      try { logReactorLifecycle(diagnostics, phase, this.#bootId, diagnostics ? this.ctx.id.toString() : undefined, attempt, this.#reactorInitializations, this.#wasmHighWaterBytes); } catch {}
    };
    logLifecycle("start");
    let output;
    try {
      this.#reactor = instantiateReactor(wasm, (memory) => {
        this.#memory = memory;
        return {
          sql: (ptr, size) => {
            const query = JSON.parse(decoder.decode(new Uint8Array(memory(), ptr, size)));
            let result;
            try {
              if (this.#failAudit > 0 && /\bINSERT INTO events\b/i.test(query.statement)) {
                this.#failAudit--;
                if (this.#failAudit === 0) throw new Error("Injected mutation audit write failure");
              }
              assertNoTextPreflightMarkerAccess(query.statement);
              // Query-mode SELECTs are constrained to a single statement by
              // the bridge. Treat all other SQL as potentially mutating.
              const readOnly = query.query === true && /^\s*SELECT\b/i.test(query.statement);
              const run = () => {
                if (!readOnly) invalidateTextPreflightMarker(this.ctx.storage);
                return execute(this.ctx.storage, query);
              };
              if (this.#recoveryAuthority && this.#insideTransaction) { this.#assertRecoveryInvalidation(); result = run(); }
              else if (this.#recoveryAuthority) result = this.ctx.storage.transactionSync(() => { this.#assertRecoveryInvalidation(); return run(); });
              else if (this.#pendingAuthority && this.#insideTransaction) { this.#assertPendingAuthority(); result = run(); }
              else if (this.#pendingAuthority) result = this.ctx.storage.transactionSync(() => { this.#assertPendingAuthority(); return run(); });
              else if (!this.#fenceArmed && this.#recoveryObjectEpoch === null) {
                if (this.#insideTransaction || readOnly || !hasTextPreflightMarker(this.ctx.storage)) result = run();
                else result = this.ctx.storage.transactionSync(run);
              }
              else if (!this.#fenceArmed) result = this.ctx.storage.transactionSync(() => { this.#assertRecoveryObjectEpoch(); return run(); });
              else if (this.#insideTransaction) {
                this.#assertRecoveryObjectEpoch();
                assertOwnerFence(this.ctx.storage, this.#authority);
                result = run();
              } else {
                result = withOwnerFence(this.ctx.storage, this.#authority, () => { this.#assertRecoveryObjectEpoch(); return run(); });
              }
            } catch (error) {
              if (this.env.MAPI_LOCAL_TEST === "1") console.error("SQLite bridge:", query.statement, String(error));
              result = { error: sqliteError(error) };
            }
            output = encoder.encode(JSON.stringify(result));
            return output.length;
          },
          result: (ptr, size) => {
            new Uint8Array(memory(), ptr, size).set(output);
            output.fill(0);
            output = undefined;
          },
          transaction: () => {
            try {
              this.ctx.storage.transactionSync(() => {
                if (this.#recoveryAuthority) this.#assertRecoveryInvalidation();
                else { this.#assertRecoveryObjectEpoch(); if (this.#pendingAuthority) this.#assertPendingAuthority(); else if (this.#fenceArmed) assertOwnerFence(this.ctx.storage, this.#authority); }
                this.#insideTransaction = true;
                try {
                  if (this.#reactor.mapi_transaction_body() !== 0) throw rejected;
                } finally { this.#insideTransaction = false; }
              });
              return 0;
            } catch (error) {
              if (error === rejected) return 1;
              if (this.env.MAPI_LOCAL_TEST === "1") console.error("SQLite commit:", String(error));
              return 2;
            }
          },
        };
      }, (bytes) => {
        const remaining = 2048 - this.#wasmDiagnostic.length;
        if (remaining > 0) {
          // Decode a bounded prefix before allocating a JavaScript string.
          // Four UTF-8 bytes cover at least one UTF-16 code unit; slicing the
          // result handles ASCII and malformed input that expand faster.
          this.#wasmDiagnostic += decoder.decode(bytes.subarray(0, remaining * 4)).slice(0, remaining);
        }
      });
      let key;
      try { key = JSON.parse(decoder.decode(Uint8Array.fromBase64(this.env.MAPI_MASTER_KEY))); }
      catch { throw new Error("Invalid master key configuration"); }
      if (this.#call("mapi_init", { ...key, projectId: this.projectId(), ...sessionTTLVariables(this.env) }) !== true) {
        throw new Error("Go reactor initialization failed");
      }
      this.#reactorInitializations++;
      logLifecycle("ready");
    } catch (error) {
      logLifecycle("failure");
      this.#reactor = undefined;
      this.#memory = undefined;
      throw error;
    }
  }

  #call(name, input) {
    this.#wasmDiagnostic = "";
    try {
      if (this.#recoveryAuthority) {
        if (!["mapi_init", "mapi_recover_batch"].includes(name)) throw new Error("Invalid recovery export");
        this.ctx.storage.transactionSync(() => this.#assertRecoveryInvalidation());
      } else { this.#detectFence(); if (this.#pendingAuthority) { if (!["mapi_init", "mapi_provision"].includes(name)) throw new Error("Invalid pending export"); this.ctx.storage.transactionSync(() => this.#assertPendingAuthority()); } else if (this.#fenceArmed) withOwnerFence(this.ctx.storage, this.#authority, () => {}); }
      if (input !== undefined) {
        const encoded = encoder.encode(JSON.stringify(input));
        const ptr = this.#reactor.mapi_alloc(encoded.length);
        new Uint8Array(this.#memory(), ptr, encoded.length).set(encoded);
        encoded.fill(0);
      }
      const result = this.#reactor[name]();
      this.#sampleWasmMemory();
      const offset = Number(result >> 32n);
      const size = Number(result & 0xffffffffn);
      const value = JSON.parse(decoder.decode(new Uint8Array(this.#memory(), offset, size)));
      this.#reactor.mapi_release();
      this.#sampleWasmMemory();
      if (value?.error) {
        const error = new Error(value.error);
        error.code = value.code;
        throw error;
      }
      return value;
    } catch (error) {
      this.#sampleWasmMemory();
      const fatal = this.#wasmDiagnostic.match(/(?:^|\n)fatal error: ([^\n]+)/)?.[1];
      if (fatal) console.error("Go/Wasm runtime:", fatal);
      if (this.env.MAPI_LOCAL_TEST === "1" && this.#wasmDiagnostic) {
        console.error("Go/Wasm diagnostic:", this.#wasmDiagnostic.slice(0, 1400));
      }
      this.#reactor = undefined;
      this.#memory = undefined;
      throw error;
    }
  }

  #sampleWasmMemory() {
    // Memory observations and their correlation metadata are best effort:
    // failure must neither fail a successful Go call nor mask its error. If
    // an identity cannot be obtained, retain the sampled high-water value
    // but omit the uncorrelatable log record.
    try {
      const bytes = this.#memory?.().byteLength ?? 0;
      let enabled = this.env.MAPI_RUNTIME_DIAGNOSTICS === "1", objectId;
      if (enabled) {
        try { objectId = this.ctx.id.toString(); }
        catch { enabled = false; }
      }
      this.#wasmHighWaterBytes = observeWasmHighWater(this.#wasmHighWaterBytes, bytes, enabled, this.#bootId, objectId);
    } catch { /* Missing samples leave memory evidence incomplete. */ }
  }

  handleRequest(request) {
    // Preserve the build scripts' insertion anchor while accepting owner authority.
    const route = arguments[1];
    return this.#withRoute(route, () => this.#handleRequest(request));
  }

  #handleRequest(request) {
    try {
      this.#initialize();
      return this.#call("mapi_request", request);
    } catch (error) {
      this.#reactor = undefined;
      if (this.env.MAPI_LOCAL_TEST === "1") console.error("Go reactor:", String(error));
      return { status: 503, headers: {}, body: null };
    }
  }

  // Check registry routing and recovery state in the same synchronous owner
  // turn as the operation, so no state change can interleave after admission.
  #configurationReady(verifyRuntime = false) {
    if (!verifyRuntime && this.env.MAPI_SESSION_DEFAULT_TTL === undefined && this.env.MAPI_SESSION_MAX_TTL === undefined) return true;
    try { this.#initialize(); return true; } catch { return false; }
  }

  #recoveryReady() {
    try { return validateSourceRecoveryEpoch(this.ctx.storage) === (this.env.MAPI_RECOVERY_EPOCH ?? "0"); }
    catch { return false; }
  }

  #admitRoute(route) {
    return Boolean(route?.projectId && route.origin && this.env.MAPI_MAINTENANCE !== "1" &&
      this.projectId() === route.projectId && this.projectOrigin() === route.origin &&
      this.#recoveryReady() &&
      this.#configurationReady());
  }

  admitLogin(route) {
    return this.#withRoute(route, () => {
      if (this.#fenceArmed) {
        try { withOwnerFence(this.ctx.storage, route, () => {}); } catch { return false; }
      }
      return this.#admitRoute(route);
    });
  }

  flowRequest(request, route) {
    return this.#withRoute(route, () => this.#flowRequest(request, route));
  }

  #flowRequest(request, route) {
    if (this.#fenceArmed) {
      try { withOwnerFence(this.ctx.storage, route, () => {}); } catch { return { status: 503, headers: {}, body: null }; }
    }
    if (!this.#admitRoute(route)) return { status: 503, headers: {}, body: null };
    const url = new URL(request.url);
    if (url.origin !== route.origin) return { status: 403, headers: {}, body: null };
    if (request.method === "POST" && /^\/api\/v1\/flows\/flow_[A-Za-z0-9_-]+\/submit$/.test(url.pathname) && !this.allowLogin(request.peer ?? "127.0.0.1")) return { status: 429, headers: {}, body: null };
    this.#initialize();
    const projectId = route.projectId;
    if (url.pathname === "/api/v1/sessions/exchange") {
      const { token } = this.#call("mapi_project_token", { projectId });
      request.headers.authorization = [`Bearer ${token}`];
    }
    if (this.env.MAPI_RUNTIME_DIAGNOSTICS === "1" && request.method === "POST" && /^\/api\/v1\/flows\/flow_[A-Za-z0-9_-]+\/submit$/.test(url.pathname)) {
      let kind = "other";
      try { kind = classifyFlowSubmission(url.pathname, decoder.decode(Uint8Array.fromBase64(request.body))) ?? "other"; } catch {}
      console.log(JSON.stringify({ event: "mapi.flow.submit", kind, bootId: this.#bootId }));
    }
    return this.#call("mapi_request", request);
  }

  oauthRequest(request, route) {
    return this.#withRoute(route, () => this.#oauthRequest(request, route));
  }

  #oauthRequest(request, route) {
    if (this.#fenceArmed) {
      try { withOwnerFence(this.ctx.storage, route, () => {}); } catch { return { status: 503, headers: {}, body: null }; }
    }
    if (this.env.MAPI_OIDC_EXPERIMENTAL !== "1") throw new Error("Experimental issuer is disabled");
    if (!this.#admitRoute(route)) return { status: 503, headers: {}, body: null };
    const url = new URL(request.url);
    if (url.origin !== route.origin || !isOAuthRoute(request.method, url.pathname, route.projectId)) return { status: 403, headers: {}, body: null };
    if (!this.allowLogin(request.peer ?? "127.0.0.1", "oauth")) return { status: 429, headers: {}, body: null };
    this.#initialize();
    return this.#call("mapi_oauth_request", { projectId: route.projectId, origin: route.origin, request });
  }

  oauthAdmin(action, options = {}, route) {
    return this.#withRoute(route, () => this.#oauthAdmin(action, options));
  }

  #oauthAdmin(action, options) {
    if (this.env.MAPI_OIDC_EXPERIMENTAL !== "1") throw new Error("Experimental issuer is disabled");
    if (!["initialize", "register", "rotate", "register_logout", "rotate_client_secret", "revoke_client_secrets"].includes(action)) throw new Error("Unsupported issuer action");
    this.#initialize();
    return this.#call("mapi_oauth_admin", { projectId: this.projectId(), origin: this.projectOrigin(), action, ...options });
  }

  flowRelease(action, options = {}, route) {
    return this.#withRoute(route, () => this.#flowRelease(action, options));
  }

  #flowRelease(action, options) {
    if (this.env.MAPI_OIDC_EXPERIMENTAL !== "1") throw new Error("Experimental flow release is disabled");
    if (!["status", "publish", "rollback"].includes(action)) throw new Error("Unsupported flow release action");
    const allowed = action === "publish" ? ["document", "expectedDeploymentId"] : action === "rollback" ? ["targetDeploymentId", "expectedDeploymentId"] : [];
    if (!options || typeof options !== "object" || Array.isArray(options) || Object.keys(options).some(key => !allowed.includes(key))) throw new Error("Invalid flow release options");
    this.#initialize();
    return this.#call("mapi_flow_release", { ...options, projectId: this.projectId(), origin: this.projectOrigin(), action });
  }

  projectId() {
    if (!this.ctx.storage.sql.exec("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'mapi_project'").toArray().length) return "";
    return this.ctx.storage.sql.exec("SELECT project_id FROM mapi_project").toArray()[0]?.project_id ?? "";
  }

  identity() {
    // A Go commit can precede the durable owner-fence transition. Until that
    // transition completes, ingress must retry provision rather than attempt
    // registry activation using the partially provisioned identity.
    if (this.ctx.storage.sql.exec("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'mapi_pending_owner'").toArray().length) return "";
    return this.projectId();
  }

  projectOrigin() {
    return this.ctx.storage.sql.exec("SELECT origin FROM mapi_project_origin").toArray()[0]?.origin ?? this.env.MAPI_APP_ORIGIN;
  }

  async provision(name, origin, route) {
    origin = canonicalOrigin(origin);
    if (!route || route.origin !== origin || !route.objectName || !Number.isSafeInteger(route.generation) || route.generation < 1 || this.ctx.id.toString() !== this.env.NEXTGEN_APPLICATION.idFromName(route.objectName).toString()) throw new Error("Invalid provisioning route");
    const current = await this.env.PROJECT_REGISTRY.getByName("projects").resolve(origin);
    if (!current || current.origin !== origin || current.object_name !== route.objectName || current.generation !== route.generation || current.project_id !== route.projectId || !["pending", "active"].includes(current.state)) throw new Error("Provisioning route is stale");
    if (current.state === "active") return this.#withRoute(route, () => this.#provision(name, origin));
    if (route.projectId !== null) throw new Error("Invalid pending route");
    // A completed provisioning call may be retried after a lost response.
    const hasFence = this.ctx.storage.sql.exec("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'mapi_owner_fence'").toArray().length;
    if (hasFence) {
      const fence = this.ctx.storage.sql.exec("SELECT * FROM mapi_owner_fence WHERE singleton = 1").toArray()[0];
      if (!fence || !["pending", "active"].includes(fence.state) || fence.origin !== origin || fence.object_name !== route.objectName || fence.generation !== route.generation || fence.project_id !== this.projectId()) throw new Error("Pending owner already belongs to a different route");
      return { projectId: fence.project_id };
    }
    this.ctx.storage.transactionSync(() => {
      const sql = this.ctx.storage.sql;
      const relocation = sql.exec("SELECT name FROM sqlite_schema WHERE type = 'table' AND name IN ('mapi_destination_reservation', 'mapi_relocation_project')").toArray().map(row => row.name);
      if ((relocation.includes("mapi_destination_reservation") && sql.exec("SELECT 1 FROM mapi_destination_reservation WHERE singleton = 1").toArray().length) ||
          (relocation.includes("mapi_relocation_project") && sql.exec("SELECT 1 FROM mapi_relocation_project WHERE state IN ('importing', 'staged')").toArray().length)) throw new Error("Owner is reserved for relocation");
      const schema = sql.exec("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'mapi_schema_version'").toArray().length;
      const pending = sql.exec("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'mapi_pending_owner'").toArray().length;
      if (schema && !pending) throw new Error("Existing owner requires separate adoption");
      sql.exec("CREATE TABLE IF NOT EXISTS mapi_pending_owner (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), origin TEXT NOT NULL, object_name TEXT NOT NULL, generation INTEGER NOT NULL)");
      const existing = sql.exec("SELECT * FROM mapi_pending_owner WHERE singleton = 1").toArray()[0];
      if (existing && (existing.origin !== origin || existing.object_name !== route.objectName || existing.generation !== route.generation)) throw new Error("Conflicting pending owner");
      if (!existing) sql.exec("INSERT INTO mapi_pending_owner VALUES (1, ?, ?, ?)", origin, route.objectName, route.generation);
    });
    this.#pendingAuthority = route;
    try {
      this.#initializeSchema();
      const result = this.#provision(name, origin);
      this.ctx.storage.transactionSync(() => {
        this.#assertPendingAuthority();
        if (!result.projectId || result.projectId !== this.projectId() || this.projectOrigin() !== origin) throw new Error("Provisioned identity mismatch");
        createOwnerFenceTable(this.ctx.storage);
        this.ctx.storage.sql.exec("INSERT INTO mapi_owner_fence VALUES (1, ?, ?, ?, ?, 'pending', NULL, NULL)", result.projectId, origin, route.objectName, route.generation);
        this.ctx.storage.sql.exec("DROP TABLE mapi_pending_owner");
      });
      this.#fenceArmed = true;
      return result;
    } finally { this.#pendingAuthority = undefined; }
  }

  provisioningAttestation(origin, objectName, generation) {
    if (this.ctx.id.toString() !== this.env.NEXTGEN_APPLICATION.idFromName(objectName).toString()) throw new Error("Provisioning object mismatch");
    const sql = this.ctx.storage.sql;
    if (sql.exec("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'mapi_pending_owner'").toArray().length) throw new Error("Provisioning is incomplete");
    const projectId = this.projectId();
    if (!projectId || this.projectOrigin() !== origin) throw new Error("Provisioning identity mismatch");
    const hasFence = sql.exec("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'mapi_owner_fence'").toArray().length;
    if (hasFence) {
      const fence = sql.exec("SELECT * FROM mapi_owner_fence WHERE singleton = 1").toArray()[0];
      if (!fence || !["pending", "active"].includes(fence.state) || fence.project_id !== projectId || fence.origin !== origin || fence.object_name !== objectName || fence.generation !== generation) throw new Error("Provisioning fence mismatch");
    } else if (objectName !== "application" || generation !== 1) throw new Error("Existing owner requires adoption");
    return { projectId, origin, objectName, generation, objectId: this.ctx.id.toString() };
  }

  async activateProvisioning(route) {
    if (!route || this.ctx.id.toString() !== this.env.NEXTGEN_APPLICATION.idFromName(route.objectName).toString()) throw new Error("Provisioning object mismatch");
    const current = await this.env.PROJECT_REGISTRY.getByName("projects").resolve(route.origin);
    if (!current || current.state !== "active" || current.project_id !== route.projectId || current.origin !== route.origin || current.object_name !== route.objectName || current.generation !== route.generation) throw new Error("Provisioning route is not active");
    return this.ctx.storage.transactionSync(() => {
      const sql = this.ctx.storage.sql;
      const hasFence = sql.exec("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'mapi_owner_fence'").toArray().length;
      if (!hasFence) {
        if (route.objectName !== "application" || route.generation !== 1 || this.projectId() !== route.projectId || this.projectOrigin() !== route.origin) throw new Error("Existing owner requires adoption");
        return;
      }
      const fence = sql.exec("SELECT * FROM mapi_owner_fence WHERE singleton = 1").toArray()[0];
      if (!fence || !["pending", "active"].includes(fence.state) || fence.project_id !== route.projectId || fence.origin !== route.origin || fence.object_name !== route.objectName || fence.generation !== route.generation) throw new Error("Provisioning fence mismatch");
      if (fence.state === "pending") {
        invalidateTextPreflightMarker(this.ctx.storage);
        sql.exec("UPDATE mapi_owner_fence SET state = 'active' WHERE singleton = 1");
      }
      this.#fenceArmed = true;
    });
  }

  #schemaMigrationSource(route, epoch) {
    if (!route || this.ctx.id.toString() !== this.env.NEXTGEN_APPLICATION.idFromName(route.objectName).toString() || typeof epoch !== 'string' || !epoch || (this.#recoveryObjectEpoch ?? '0') !== epoch || (this.env.MAPI_RECOVERY_EPOCH ?? '0') !== epoch) throw new Error('Schema migration epoch or object mismatch');
    const sql = this.ctx.storage.sql;
    const metadata = sql.exec("SELECT name FROM sqlite_schema WHERE type = 'table' AND name IN ('mapi_pending_owner', 'mapi_destination_reservation', 'mapi_relocation_project', 'mapi_owner_fence')").toArray().map(row => row.name);
    if (metadata.includes('mapi_pending_owner') || (metadata.includes('mapi_destination_reservation') && sql.exec('SELECT 1 FROM mapi_destination_reservation WHERE singleton = 1').toArray().length) || (metadata.includes('mapi_relocation_project') && sql.exec("SELECT 1 FROM mapi_relocation_project WHERE state IN ('importing', 'staged')").toArray().length)) throw new Error('Schema migration owner is not active');
    const projects = sql.exec('SELECT project_id FROM mapi_project').toArray(), origins = sql.exec('SELECT origin FROM mapi_project_origin').toArray(), epochs = sql.exec('SELECT epoch FROM mapi_recovery_epoch').toArray(), versions = sql.exec('SELECT version FROM mapi_schema_version').toArray();
    if (projects.length !== 1 || projects[0].project_id !== route.projectId || origins.length !== 1 || origins[0].origin !== route.origin || epochs.length !== 1 || epochs[0].epoch !== epoch || versions.length !== 1 || ![1, 2].includes(versions[0].version)) throw new Error('Schema migration source mismatch');
    const fence = metadata.includes('mapi_owner_fence') ? sql.exec('SELECT * FROM mapi_owner_fence WHERE singleton = 1').toArray()[0] : null;
    return { version: versions[0].version, fence, hasFence: metadata.includes('mapi_owner_fence') };
  }

  async schemaMigrationReadiness(secret, route, epoch) {
    authorizeSchemaMigration(this.env, secret);
    if (this.env.MAPI_SCHEMA_TARGET !== '2') throw new Error('Schema target is not enabled');
    const current = await this.env.PROJECT_REGISTRY.getByName('projects').resolve(route?.origin);
    if (!current || current.state !== 'active' || current.project_id !== route.projectId || current.origin !== route.origin || current.object_name !== route.objectName || current.generation !== route.generation) throw new Error('Schema migration route mismatch');
    return this.ctx.storage.transactionSync(() => {
      const source = this.#schemaMigrationSource(route, epoch);
      if (source.version !== 1 || (source.hasFence && (!source.fence || source.fence.state !== 'active'))) throw new Error('Schema migration source is not ready');
      if (source.hasFence) assertOwnerFence(this.ctx.storage, route);
      if (this.ctx.storage.sql.exec("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'mapi_schema_history'").toArray().length) throw new Error('Schema migration history already exists');
      return { ...route, epoch, version: 1, objectId: this.ctx.id.toString() };
    });
  }

  async applySchemaMigration(secret, projectId, migrationId) {
    authorizeSchemaMigration(this.env, secret);
    if (this.env.MAPI_SCHEMA_TARGET !== '2') throw new Error('Schema target is not enabled');
    const intent = await this.env.PROJECT_REGISTRY.getByName('projects').schemaMigrationStatus(secret, projectId);
    if (!intent || intent.phase !== 'reserved' || intent.project_id !== projectId || intent.migration_id !== migrationId || intent.target_version !== 2 || intent.object_id !== this.ctx.id.toString()) throw new Error('Schema migration intent mismatch');
    const route = { projectId, origin: intent.origin, objectName: intent.object_name, generation: intent.generation };
    this.ctx.storage.transactionSync(() => {
      const sql = this.ctx.storage.sql;
      const source = this.#schemaMigrationSource(route, intent.epoch);
      const matching = source.fence && source.fence.project_id === projectId && source.fence.origin === route.origin && source.fence.object_name === route.objectName && source.fence.generation === route.generation && source.fence.state === 'frozen' && source.fence.move_id === `schema:${migrationId}`;
      if (source.version === 2) {
        const history = sql.exec('SELECT version, applied_at FROM mapi_schema_history').toArray();
        if (!matching || history.length !== 1 || history[0].version !== 2) throw new Error('Schema migration checkpoint mismatch');
        return;
      }
      invalidateTextPreflightMarker(this.ctx.storage);
      if (source.hasFence) assertOwnerFence(this.ctx.storage, route);
      else { createOwnerFenceTable(this.ctx.storage); sql.exec("INSERT INTO mapi_owner_fence VALUES (1, ?, ?, ?, ?, 'active', NULL, NULL)", projectId, route.origin, route.objectName, route.generation); }
      if (sql.exec("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'mapi_schema_history'").toArray().length) throw new Error('Schema migration history already exists');
      sql.exec("UPDATE mapi_owner_fence SET state = 'frozen', move_id = ?, digest = NULL WHERE singleton = 1", `schema:${migrationId}`);
      sql.exec('CREATE TABLE mapi_schema_history (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)');
      sql.exec('INSERT INTO mapi_schema_history VALUES (2, ?)', Date.now());
      sql.exec('UPDATE mapi_schema_version SET version = 2 WHERE version = 1');
    });
    this.#fenceArmed = true;
    return { ...route, epoch: intent.epoch, objectId: this.ctx.id.toString(), migrationId, version: 2, state: 'frozen' };
  }

  async activateSchemaMigration(secret, projectId, migrationId) {
    authorizeSchemaMigration(this.env, secret);
    const registry = this.env.PROJECT_REGISTRY.getByName('projects');
    const intent = await registry.schemaMigrationStatus(secret, projectId);
    if (!intent || !['committed', 'complete'].includes(intent.phase) || intent.migration_id !== migrationId || !Number.isSafeInteger(intent.generation) || intent.generation < 1 || intent.generation === Number.MAX_SAFE_INTEGER || intent.object_id !== this.ctx.id.toString()) throw new Error('Schema migration is not committed');
    const current = await registry.resolve(intent.origin);
    if (!current || current.state !== 'active' || current.project_id !== projectId || current.origin !== intent.origin || current.object_name !== intent.object_name || current.generation !== intent.generation + 1) throw new Error('Schema migration route is not committed');
    const route = { projectId, origin: intent.origin, objectName: intent.object_name, generation: intent.generation };
    this.ctx.storage.transactionSync(() => {
      const sql = this.ctx.storage.sql, source = this.#schemaMigrationSource(route, intent.epoch), fence = source.fence;
      const history = sql.exec('SELECT version, applied_at FROM mapi_schema_history').toArray();
      if (source.version !== 2 || history.length !== 1 || history[0].version !== 2 || !fence || fence.project_id !== projectId || fence.origin !== route.origin || fence.object_name !== route.objectName || fence.move_id !== `schema:${migrationId}` || !((fence.state === 'frozen' && fence.generation === route.generation) || (fence.state === 'active' && fence.generation === route.generation + 1))) throw new Error('Schema activation checkpoint mismatch');
      if (fence.state === 'frozen') {
        invalidateTextPreflightMarker(this.ctx.storage);
        sql.exec("UPDATE mapi_owner_fence SET state = 'active', generation = ? WHERE singleton = 1", route.generation + 1);
      }
    });
    this.#fenceArmed = true;
    return { ...route, generation: route.generation + 1, epoch: intent.epoch, objectId: this.ctx.id.toString(), migrationId, version: 2, state: 'active' };
  }

  activeRecoveryAttestation(secret, route, proposedEpoch) {
    if (this.env.MAPI_RELOCATION_ENABLED !== "1" || this.env.MAPI_FENCE_WRITERS_DRAINED !== "1" || !this.env.MAPI_RELOCATION_CONTROL_TOKEN || !sameKey(secret, this.env.MAPI_RELOCATION_CONTROL_TOKEN)) throw new Error("Recovery control denied");
    if (!route || typeof proposedEpoch !== "string" || !proposedEpoch || proposedEpoch === "0" || this.ctx.id.toString() !== this.env.NEXTGEN_APPLICATION.idFromName(route.objectName).toString()) throw new Error("Recovery owner identity mismatch");
    this.#assertRecoveryObjectEpoch();
    return this.ctx.storage.transactionSync(() => {
      const sql = this.ctx.storage.sql;
      const metadata = sql.exec("SELECT name FROM sqlite_schema WHERE type = 'table' AND name IN ('mapi_pending_owner', 'mapi_destination_reservation', 'mapi_relocation_project', 'mapi_owner_fence')").toArray().map(row => row.name);
      if (metadata.includes("mapi_pending_owner") || (metadata.includes("mapi_destination_reservation") && sql.exec("SELECT 1 FROM mapi_destination_reservation WHERE singleton = 1").toArray().length) || (metadata.includes("mapi_relocation_project") && sql.exec("SELECT 1 FROM mapi_relocation_project WHERE state IN ('importing', 'staged')").toArray().length)) throw new Error("Recovery owner is not active");
      const projects = sql.exec("SELECT project_id FROM mapi_project").toArray(), origins = sql.exec("SELECT origin FROM mapi_project_origin").toArray();
      if (projects.length !== 1 || projects[0].project_id !== route.projectId || origins.length !== 1 || origins[0].origin !== route.origin) throw new Error("Recovery project identity mismatch");
      const epochs = sql.exec("SELECT epoch FROM mapi_recovery_epoch").toArray();
      if (epochs.length !== 1 || typeof epochs[0].epoch !== "string" || !epochs[0].epoch || epochs[0].epoch === proposedEpoch) throw new Error("Recovery epoch is not fresh");
      if (metadata.includes("mapi_owner_fence")) assertOwnerFence(this.ctx.storage, route);
      return { ...route, proposedEpoch, objectId: this.ctx.id.toString(), state: metadata.includes("mapi_owner_fence") ? "active" : "legacy" };
    });
  }

  async preFreezeRecovery(secret, route, recoveryId, epoch) {
    if (this.env.MAPI_RELOCATION_ENABLED !== "1" || this.env.MAPI_FENCE_WRITERS_DRAINED !== "1" || !this.env.MAPI_RELOCATION_CONTROL_TOKEN || !sameKey(secret, this.env.MAPI_RELOCATION_CONTROL_TOKEN)) throw new Error("Recovery fence adoption is not enabled");
    if (!route || this.ctx.id.toString() !== this.env.NEXTGEN_APPLICATION.idFromName(route.objectName).toString()) throw new Error("Recovery owner identity mismatch");
    const registry = this.env.PROJECT_REGISTRY.getByName("projects");
    const intent = await registry.recoveryIntentStatus(secret, route.projectId);
    const { route: current } = await registry.relocationStatus(secret, route.projectId);
    if (!intent || intent.project_id !== route.projectId || intent.recovery_id !== recoveryId || intent.epoch !== epoch || intent.origin !== route.origin || intent.object_name !== route.objectName || intent.object_id !== this.ctx.id.toString() || intent.generation !== route.generation || !current || current.project_id !== route.projectId || current.origin !== route.origin || current.object_name !== route.objectName || current.generation !== route.generation) throw new Error("Recovery intent mismatch");
    this.#assertRecoveryObjectEpoch();
    const sql = this.ctx.storage.sql;
    const projects = sql.exec("SELECT project_id FROM mapi_project").toArray(), origins = sql.exec("SELECT origin FROM mapi_project_origin").toArray(), epochs = sql.exec("SELECT epoch FROM mapi_recovery_epoch").toArray();
    if (projects.length !== 1 || projects[0].project_id !== route.projectId || origins.length !== 1 || origins[0].origin !== route.origin || epochs.length !== 1 || epochs[0].epoch === epoch) throw new Error("Recovery source identity mismatch");
    const hasFence = sql.exec("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'mapi_owner_fence'").toArray().length;
    const fence = hasFence ? sql.exec("SELECT * FROM mapi_owner_fence WHERE singleton = 1").toArray()[0] : null;
    if (!(fence?.state === "frozen" && fence.project_id === route.projectId && fence.origin === route.origin && fence.object_name === route.objectName && fence.generation === route.generation && fence.move_id === `recovery:${recoveryId}`)) {
      initializeOwnerFence(this.ctx.storage, route, true);
      this.#fenceArmed = true;
      freezeOwnerFence(this.ctx.storage, route, `recovery:${recoveryId}`, true);
    }
    this.#fenceArmed = true;
    return { ...route, recoveryId, epoch, objectId: this.ctx.id.toString(), state: "frozen" };
  }

  #provision(name, origin) {
    origin = canonicalOrigin(origin);
    if (this.#fenceArmed) withOwnerFence(this.ctx.storage, this.#authority, () => {});
    const savedOrigin = this.ctx.storage.sql.exec("SELECT origin FROM mapi_project_origin").toArray()[0]?.origin;
    if (savedOrigin && savedOrigin !== origin) throw new Error("Project origin cannot be changed by provisioning");
    if (this.projectId()) {
      if (canonicalOrigin(this.projectOrigin()) !== origin) throw new Error("Project origin cannot be changed by provisioning");
      return { projectId: this.projectId() };
    }
    if (!savedOrigin) {
      const insertOrigin = () => {
        invalidateTextPreflightMarker(this.ctx.storage);
        return this.ctx.storage.sql.exec("INSERT INTO mapi_project_origin VALUES (?)", origin);
      };
      if (this.#fenceArmed) withOwnerFence(this.ctx.storage, this.#authority, insertOrigin);
      else if (this.#pendingAuthority) this.ctx.storage.transactionSync(() => { this.#assertPendingAuthority(); insertOrigin(); });
      else insertOrigin();
    }
    this.#initialize();
    const result = this.#call("mapi_provision", { name, origin });
    this.#reactor = undefined;
    this.#memory = undefined;
    return result;
  }

  addUser(email, password, route) {
    return this.#withRoute(route, () => this.#addUser(email, password));
  }

  #addUser(email, password) {
    const projectId = this.projectId();
    if (!projectId) throw new Error("Project is not initialized");
    this.#initialize();
    return this.#call("mapi_add_user", { projectId, email, password });
  }

  failNextAudit(after = 1) {
    if (this.env.MAPI_LOCAL_TEST !== "1") throw new Error("Local testing is disabled");
    if (!Number.isInteger(after) || after < 1 || after > 20) throw new Error("Invalid failure position");
    this.#failAudit = after;
  }

  testCounts() {
    if (this.env.MAPI_LOCAL_TEST !== "1") throw new Error("Local testing is disabled");
    const sql = this.ctx.storage.sql;
    return Object.fromEntries(["projects", "users", "events"].map((table) => [table, sql.exec(`SELECT COUNT(*) AS count FROM ${table}`).one().count]));
  }

  evict() {
    if (this.env.MAPI_LOCAL_TEST !== "1") throw new Error("Local testing is disabled");
    this.ctx.abort("MaPi local eviction test");
  }

  async bookmark() {
    return this.ctx.storage.getCurrentBookmark();
  }

  async restore(bookmark) {
    this.#detectFence();
    throw new Error("Coordinated recovery is required");
  }

  recover(route) {
    this.#detectFence();
    throw new Error("Coordinated recovery is required");
  }

  #upstream(method, path, body, headers = {}) {
    const request = {
      method, url: this.projectOrigin() + path,
      headers: Object.fromEntries(Object.entries(headers).map(([name, value]) => [name, [value]])),
      body: body === undefined ? "" : encoder.encode(JSON.stringify(body)).toBase64(),
      peer: "127.0.0.1",
    };
    if (body !== undefined) request.headers["content-type"] = ["application/json"];
    const result = this.#call("mapi_request", request);
    const data = result.body ? JSON.parse(decoder.decode(Uint8Array.fromBase64(result.body))) : null;
    return { ...result, data };
  }

  #mintHandoff(email, password) {
    this.#initialize();
    const projectId = this.projectId();
    if (!projectId) return { status: 503 };
    const { token } = this.#call("mapi_project_token", { projectId });
    const auth = { authorization: "Bearer " + token };
    const start = this.#upstream("POST", "/auth_attempts", { project_id: projectId }, auth);
    if (start.status !== 200 && start.status !== 201) return legacyLoginFailure();
    const path = `/auth_attempts/${start.data.attempt_id}/challenges`;
    for (const [method, proof] of [["identifier", { login_name: email }], ["password", { password }]]) {
      const challenge = this.#upstream("POST", path, { method }, auth);
      if (!successfulUpstreamStatus(challenge.status)) return legacyLoginFailure();
      const verified = this.#upstream("POST", `${path}/${challenge.data.challenge_id}/verify`, proof, auth);
      if (!successfulUpstreamStatus(verified.status)) return legacyLoginFailure();
    }
    const handoff = this.#upstream("POST", `/auth_attempts/${start.data.attempt_id}/handoff`, undefined, auth);
    return successfulUpstreamStatus(handoff.status) ? { status: 200, handoff: handoff.data.handoff_token } : legacyLoginFailure();
  }

  #exchangeHandoff(handoff) {
    const projectId = this.projectId();
    const { token } = this.#call("mapi_project_token", { projectId });
    return this.#upstream("POST", `/sessions/exchange?project_id=${encodeURIComponent(projectId)}`, { handoff_token: handoff }, { authorization: "Bearer " + token });
  }

  allowLogin(ip, scope = "password") {
    if (!["password", "oauth"].includes(scope)) throw new Error("Invalid throttle scope");
    this.#detectFence();
    const allowed = this.ctx.storage.transactionSync(() => {
      this.#assertRecoveryObjectEpoch();
      if (this.#fenceArmed) assertOwnerFence(this.ctx.storage, this.#authority);
      invalidateTextPreflightMarker(this.ctx.storage);
      return admitLogin(this.ctx.storage.sql, ip, scope, Date.now());
    });
    return allowed;
  }

  login(email, password, ip, route) {
    return this.#withRoute(route, () => this.#login(email, password, ip));
  }

  #login(email, password, ip) {
    if (!this.allowLogin(ip)) return { status: 429 };
    const handoff = this.#mintHandoff(email, password);
    if (handoff.status !== 200) return handoff;
    const session = this.#exchangeHandoff(handoff.handoff);
    if (!successfulUpstreamStatus(session.status)) return legacyLoginFailure();
    return { status: 200, cookie: session.headers["Set-Cookie"]?.[0] ?? session.headers["set-cookie"]?.[0] };
  }

  testRecovery(email, password) {
    if (this.env.MAPI_LOCAL_TEST !== "1") throw new Error("Local testing is disabled");
    const handoff = this.#mintHandoff(email, password);
    if (handoff.status !== 200) throw new Error("Test handoff failed");
    this.#call("mapi_recover", { projectId: this.projectId(), epoch: this.env.MAPI_RECOVERY_EPOCH ?? "0" });
    return this.#exchangeHandoff(handoff.handoff).status;
  }

  session(cookie, operation = "read", csrfToken = "", route) {
    return this.#withRoute(route, () => this.#session(cookie, operation, csrfToken));
  }

  #session(cookie, operation, csrfToken) {
    this.#initialize();
    const project = encodeURIComponent(this.projectId());
    const headers = { cookie };
    if (operation === "read") return this.#upstream("GET", `/sessions/me?project_id=${project}`, undefined, headers);
    if (operation === "csrf") return this.#upstream("GET", `/sessions/me/csrf?project_id=${project}`, undefined, headers);
    headers["x-zitadel-csrf"] = csrfToken;
    headers.origin = this.projectOrigin();
    return this.#upstream("DELETE", `/sessions/me?project_id=${project}`, undefined, headers);
  }

  status(verifyRuntime = false, route) {
    const sql = this.ctx.storage.sql;
    const schema = sql.exec("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'mapi_schema_version'").toArray().length;
    const pending = sql.exec("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'mapi_pending_owner'").toArray().length;
    if (!schema || pending) return { schemaVersion: 0, ready: false, configurationReady: false, fenceReady: false, wasmMemoryBytes: 0, wasmHighWaterBytes: 0, wasmHighWaterPages: 0, bootId: this.#bootId, reactorInitializations: 0, maintenance: this.env.MAPI_MAINTENANCE === "1", recoveryReady: this.#recoveryObjectEpoch === null && (this.env.MAPI_RECOVERY_EPOCH ?? "0") === "0" };
    return this.#withRoute(route, () => this.#status(verifyRuntime));
  }

  #status(verifyRuntime) {
    const projectId = this.projectId();
    // Preserve the existing lazy startup for deployments with default TTLs.
    // An explicitly configured TTL must be validated by the Go reactor before
    // an object can report ready, including before provisioning and after restart.
    let fenceReady = true;
    if (this.#fenceArmed) {
      try { withOwnerFence(this.ctx.storage, this.#authority, () => {}); } catch { fenceReady = false; }
    }
    const configurationReady = fenceReady && this.#configurationReady(verifyRuntime);
    return {
      schemaVersion: this.ctx.storage.sql.exec("SELECT version FROM mapi_schema_version").one().version,
      ready: Boolean(projectId) && configurationReady,
      configurationReady,
      fenceReady,
      wasmMemoryBytes: this.#memory?.().byteLength ?? 0,
      wasmHighWaterBytes: this.#wasmHighWaterBytes,
      wasmHighWaterPages: this.#wasmHighWaterBytes / 65_536,
      bootId: this.#bootId,
      reactorInitializations: this.#reactorInitializations,
      maintenance: this.env.MAPI_MAINTENANCE === "1",
      recoveryReady: this.#recoveryReady(),
    };
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    // The login SDK is a public build-time asset and contains no project data.
    // It can be served without waiting for a busy project's owner object.
    if (env.MAPI_OFFICIAL_LOGIN === "1" && url.pathname === "/zitadel-login.mjs" && request.method === "GET") {
      return env.ASSETS.fetch(request);
    }
    const registry = env.PROJECT_REGISTRY.getByName("projects");
    const configuredOrigin = canonicalOrigin(env.MAPI_APP_ORIGIN);
    let requestOrigin = url.origin;
    const configuredUrl = new URL(configuredOrigin);
    if (["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) && ["localhost", "127.0.0.1", "[::1]"].includes(configuredUrl.hostname) && url.port === configuredUrl.port && url.protocol === configuredUrl.protocol) {
      requestOrigin = configuredOrigin;
    }
    let route = await registry.resolve(requestOrigin);
    if (!route && requestOrigin === configuredOrigin) route = await registry.reserve(configuredOrigin, "application");
    if (url.pathname === "/_mapi/admin/projects" && request.method === "POST") {
      if (!sameKey(request.headers.get("authorization"), `Bearer ${env.MAPI_OPERATOR_TOKEN || ""}`) || !env.MAPI_OPERATOR_TOKEN) return new Response(null, { status: 404, headers: noStore });
      if (env.MAPI_MAINTENANCE === "1") return new Response(null, { status: 503, headers: noStore });
      let args;
      try { args = JSON.parse(await readLimited(request, 4096)); } catch { return new Response(null, { status: 400, headers: noStore }); }
      if (typeof args.name !== "string" || !args.name.trim() || args.name.length > 200 || typeof args.origin !== "string") return new Response(null, { status: 400, headers: noStore });
      let origin;
      try { origin = canonicalOrigin(args.origin); } catch { return new Response(null, { status: 400, headers: noStore }); }
      try {
        const reserved = await registry.reserve(origin, `project:${crypto.randomUUID()}`);
        if (reserved.state === "moving") return new Response(null, { status: 503, headers: noStore });
        if (reserved.state === "active") await registry.activate(origin, reserved.object_name, reserved.project_id);
        const project = env.NEXTGEN_APPLICATION.getByName(reserved.object_name);
        const reservedRoute = { projectId: reserved.project_id, origin: reserved.origin, objectName: reserved.object_name, generation: reserved.generation };
        if (!(await project.status(false, reservedRoute)).recoveryReady) return new Response(null, { status: 503, headers: noStore });
        const result = await project.provision(args.name, origin, { projectId: reserved.project_id, origin: reserved.origin, objectName: reserved.object_name, generation: reserved.generation });
        await registry.activate(origin, reserved.object_name, result.projectId);
        return Response.json({ projectId: result.projectId, origin }, { headers: noStore });
      } catch (error) {
        console.error("Project initialization failed", error.code ?? "internal error");
        return new Response(null, { status: 503, headers: noStore });
      }
    }
    if (!route) return new Response(null, { status: 404, headers: noStore });
    if (route.state === "moving") return new Response(null, { status: 503, headers: noStore });
    const object = env.NEXTGEN_APPLICATION.getByName(route.object_name);
    if (route.state === "pending" && route.object_name === "application") {
      const projectId = await object.identity();
      if (projectId) route = await registry.activate(route.origin, route.object_name, projectId);
    }
    const ownerRoute = { projectId: route.project_id, origin: route.origin, objectName: route.object_name, generation: route.generation };
    // Hot-path admission, rate limiting and execution happen together inside
    // the owning object. The registry must still resolve an active route first.
    if (route.state === "active" && env.MAPI_OIDC_EXPERIMENTAL === "1" && isOAuthRoute(request.method, url.pathname, route.project_id)) {
      if (env.MAPI_MAINTENANCE === "1") return new Response(null, { status: 503, headers: noStore });
      try { return await handleOAuthIngress(request, object, route.project_id, route.origin, ownerRoute); }
      catch (error) { logOverload(error, "application"); return new Response(null, { status: 503, headers: noStore }); }
    }
    if (route.state === "active" && env.MAPI_OFFICIAL_LOGIN === "1" && url.pathname.startsWith("/__nextgen/")) {
      if (env.MAPI_MAINTENANCE === "1") return new Response(null, { status: 503, headers: noStore });
      try { return await handleFlowProxy(request, object, route.project_id, route.origin, ownerRoute); }
      catch (error) { logOverload(error, "application"); return new Response(null, { status: 503, headers: noStore }); }
    }
    if (route.state === "active" && env.MAPI_OFFICIAL_LOGIN === "1" && url.pathname === "/login" && request.method === "GET") {
      if (env.MAPI_MAINTENANCE === "1" || !(await object.admitLogin(ownerRoute))) return new Response(null, { status: 503, headers: noStore });
      const handles = url.searchParams.getAll("mapi_oauth");
      if (handles.length && (env.MAPI_OIDC_EXPERIMENTAL !== "1" || handles.length !== 1 || !/^[A-Za-z0-9_-]{43}$/.test(handles[0]))) return new Response(null, { status: 400, headers: noStore });
      return renderLogin(route.project_id, handles[0] ?? "");
    }
    if (route.state === "active" && route.project_id !== await object.identity()) return new Response(null, { status: 503, headers: noStore });
    if (url.pathname.startsWith("/_mapi/admin/oidc/")) {
      const actions = new Map([["/_mapi/admin/oidc/init", "initialize"], ["/_mapi/admin/oidc/clients", "register"], ["/_mapi/admin/oidc/rotate", "rotate"], ["/_mapi/admin/oidc/logout-uri", "register_logout"], ["/_mapi/admin/oidc/client-secret/rotate", "rotate_client_secret"], ["/_mapi/admin/oidc/client-secret/revoke", "revoke_client_secrets"], ["/_mapi/admin/oidc/flow/status", "flow_status"], ["/_mapi/admin/oidc/flow/publish", "flow_publish"], ["/_mapi/admin/oidc/flow/rollback", "flow_rollback"]]);
      const action = actions.get(url.pathname);
      if (env.MAPI_OIDC_EXPERIMENTAL !== "1" || !action || request.method !== "POST" || !env.MAPI_OPERATOR_TOKEN || !sameKey(request.headers.get("authorization"), `Bearer ${env.MAPI_OPERATOR_TOKEN}`)) return new Response(null, { status: 404, headers: noStore });
      const status = await object.status(false, ownerRoute);
      if (route.state !== "active" || env.MAPI_MAINTENANCE === "1" || status.maintenance || !status.recoveryReady || status.fenceReady !== true || url.origin !== route.origin) return new Response(null, { status: 503, headers: noStore });
      let body;
      try { body = JSON.parse(await readLimited(request, 65536) || "{}"); } catch { return new Response(null, { status: 400, headers: noStore }); }
      if (!body || typeof body !== "object" || Array.isArray(body)) return new Response(null, { status: 400, headers: noStore });
      const options = {};
      if (action === "register") {
        if (!body.document || typeof body.document !== "object" || Array.isArray(body.document)) return new Response(null, { status: 400, headers: noStore });
        options.document = body.document;
      }
      if (action === "register_logout") {
        if (typeof body.clientId !== "string" || typeof body.logoutUri !== "string" || !body.clientId || !body.logoutUri) return new Response(null, { status: 400, headers: noStore });
        options.clientId = body.clientId; options.logoutUri = body.logoutUri;
      }
      if (["rotate_client_secret", "revoke_client_secrets"].includes(action)) {
        if (typeof body.clientId !== "string" || !body.clientId) return new Response(null, { status: 400, headers: noStore });
        options.clientId = body.clientId;
      }
      if (action === "flow_publish") {
        if (!body.document || typeof body.document !== "object" || Array.isArray(body.document) || typeof body.expectedDeploymentId !== "string" || !body.expectedDeploymentId) return new Response(null, { status: 400, headers: noStore });
        options.document = body.document; options.expectedDeploymentId = body.expectedDeploymentId;
      }
      if (action === "flow_rollback") {
        if (typeof body.targetDeploymentId !== "string" || !body.targetDeploymentId || typeof body.expectedDeploymentId !== "string" || !body.expectedDeploymentId) return new Response(null, { status: 400, headers: noStore });
        options.targetDeploymentId = body.targetDeploymentId; options.expectedDeploymentId = body.expectedDeploymentId;
      }
      try { return Response.json(await (action.startsWith("flow_") ? object.flowRelease(action.slice(5), options, ownerRoute) : object.oauthAdmin(action, options, ownerRoute)), { headers: noStore }); }
      catch { return new Response(null, { status: await ownerRouteStillAvailable(registry, object, route, ownerRoute) ? 400 : 503, headers: noStore }); }
    }
    if (["/livez", "/readyz", "/api/v1/livez", "/api/v1/readyz", "/api/v1/openapi.json"].includes(url.pathname)) {
      const headers = {};
      for (const name of ["accept", "accept-encoding", "if-none-match", "if-modified-since", "range", "origin"]) {
        if (request.headers.has(name)) headers[name] = [request.headers.get(name)];
      }
      let result;
      try { result = await object.handleRequest({ method: request.method, url: request.url, headers, body: "", peer: request.headers.get("cf-connecting-ip") ?? "127.0.0.1" }, ownerRoute); }
      catch (error) { logOverload(error, "application"); return new Response(null, { status: 503, headers: noStore }); }
      const outgoing = new Headers();
      for (const [name, values] of Object.entries(result.headers)) for (const value of values) outgoing.append(name, value);
      const body = result.body && ![204, 205, 304].includes(result.status) && request.method !== "HEAD" ? Uint8Array.fromBase64(result.body) : null;
      return new Response(body, { status: result.status, headers: outgoing, encodeBody: "manual" });
    }
    if (["/_mapi/admin/status", "/_mapi/admin/init", "/_mapi/admin/users", "/_mapi/admin/bookmark", "/_mapi/admin/restore", "/_mapi/admin/recover", "/_mapi/admin/test/fail-audit", "/_mapi/admin/test/evict", "/_mapi/admin/test/recovery", "/_mapi/admin/test/counts"].includes(url.pathname)) {
      if (!sameKey(request.headers.get("authorization"), `Bearer ${env.MAPI_OPERATOR_TOKEN || ""}`) || !env.MAPI_OPERATOR_TOKEN) {
        return new Response(null, { status: 404, headers: { "cache-control": "no-store" } });
      }
      if (url.pathname.endsWith("/status") && request.method === "GET") {
        return Response.json(await object.status(true, ownerRoute), { headers: { "cache-control": "no-store" } });
      }
      if (url.pathname.endsWith("/bookmark") && request.method === "GET") {
        return Response.json({ bookmark: await object.bookmark(ownerRoute) }, { headers: noStore });
      }
      if (url.pathname.endsWith("/recover") && request.method === "POST") {
        if (env.MAPI_MAINTENANCE !== "1") return new Response(null, { status: 403, headers: noStore });
        try { await object.recover(ownerRoute); return new Response(null, { status: 204, headers: noStore }); }
        catch (error) { logOverload(error, "application"); return new Response(null, { status: 503, headers: noStore }); }
      }
      if (url.pathname.endsWith("/restore") && request.method === "POST") {
        if (env.MAPI_MAINTENANCE !== "1") return new Response(null, { status: 403, headers: noStore });
        let text;
        try { text = await readLimited(request, 4096); } catch { return new Response(null, { status: 413 }); }
        let args;
        try { args = JSON.parse(text); } catch { return new Response(null, { status: 400 }); }
        if (typeof args.bookmark !== "string" || !/^[0-9a-z-]+$/.test(args.bookmark)) return new Response(null, { status: 400 });
        try { await object.restore(args.bookmark, ownerRoute); } catch (error) { logOverload(error, "application"); return new Response(null, { status: 503, headers: noStore }); }
        return new Response(null, { status: 202, headers: noStore });
      }
      // A previous activation may have committed the registry route before
      // its owner acknowledgement was lost. Retry that transition on init.
      if (url.pathname === "/_mapi/admin/init" && request.method === "POST" && route.state === "active") {
        try { await registry.activate(route.origin, route.object_name, route.project_id); }
        catch { return new Response(null, { status: 503, headers: noStore }); }
      }
      const state = await object.status(false, ownerRoute);
      if (env.MAPI_MAINTENANCE === "1" || !state.recoveryReady) return new Response(null, { status: 503, headers: noStore });
      if (url.pathname === "/_mapi/admin/test/fail-audit" && request.method === "POST" && env.MAPI_LOCAL_TEST === "1" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
        let args = {};
        try { const text = await readLimited(request, 1024); if (text) args = JSON.parse(text); } catch { return new Response(null, { status: 400, headers: noStore }); }
        await object.failNextAudit(args.after ?? 1);
        return new Response(null, { status: 204, headers: noStore });
      }
      if (url.pathname === "/_mapi/admin/test/counts" && request.method === "GET" && env.MAPI_LOCAL_TEST === "1" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
        return Response.json(await object.testCounts(), { headers: noStore });
      }
      if (url.pathname === "/_mapi/admin/test/evict" && request.method === "POST" && env.MAPI_LOCAL_TEST === "1" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
        await object.evict();
        return new Response(null, { status: 204, headers: noStore });
      }
      if (url.pathname === "/_mapi/admin/test/recovery" && request.method === "POST" && env.MAPI_LOCAL_TEST === "1" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
        let args;
        try { args = JSON.parse(await readLimited(request, 4096)); } catch { return new Response(null, { status: 400, headers: noStore }); }
        const status = await object.testRecovery(args.email, args.password);
        return Response.json({ status }, { headers: noStore });
      }
      if (url.pathname.endsWith("/init") && request.method === "POST") {
        if (!env.MAPI_MASTER_KEY || !env.MAPI_APP_ORIGIN) return new Response(null, { status: 503 });
        let text;
        try { text = await readLimited(request, 4096); } catch { return new Response(null, { status: 413 }); }
        let args;
        try { args = JSON.parse(text); } catch { return new Response(null, { status: 400 }); }
        if (typeof args.name !== "string" || !args.name.trim() || args.name.length > 200) return new Response(null, { status: 400 });
        try {
          const result = await object.provision(args.name, route.origin, ownerRoute);
          await registry.activate(route.origin, route.object_name, result.projectId);
          return Response.json(result, { headers: { "cache-control": "no-store" } });
        } catch (error) {
          console.error("Project initialization failed", String(error));
          return new Response(null, { status: 503, headers: { "cache-control": "no-store" } });
        }
      }
      if (url.pathname.endsWith("/users") && request.method === "POST") {
        if (route.state !== "active" || state.fenceReady !== true || state.maintenance === true) return new Response(null, { status: 503, headers: noStore });
        let text;
        try { text = await readLimited(request, 4096); } catch { return new Response(null, { status: 413 }); }
        let args;
        try { args = JSON.parse(text); } catch { return new Response(null, { status: 400 }); }
        if (typeof args.email !== "string" || typeof args.password !== "string" || !args.email || !args.password) return new Response(null, { status: 400 });
        try {
          return Response.json(await object.addUser(args.email, args.password, ownerRoute), { headers: { "cache-control": "no-store" } });
        } catch (error) {
          if (!(await ownerRouteStillAvailable(registry, object, route, ownerRoute))) return new Response(null, { status: 503, headers: noStore });
          if (error.code === "user.already_exists") return new Response(null, { status: 409, headers: noStore });
          console.error("User creation failed", error.code ?? "internal error");
          return new Response(null, { status: 400, headers: noStore });
        }
      }
      return new Response(null, { status: 405 });
    }
    if (route.state !== "active") return new Response(null, { status: 503, headers: noStore });
    const appStatus = await object.status(false, ownerRoute);
    if (env.MAPI_MAINTENANCE === "1" || appStatus.maintenance || !appStatus.recoveryReady || !appStatus.ready) return new Response(null, { status: 503, headers: noStore });
    if (url.pathname === "/login" && request.method === "GET") {
      return page('<h1>Sign in</h1><form method="post" action="/login"><label>Email <input name="email" type="email" autocomplete="username" required></label><br><label>Password <input name="password" type="password" autocomplete="current-password" required></label><br><button>Sign in</button></form>');
    }
    if (["/login", "/logout"].includes(url.pathname) && request.method === "POST") {
      if (request.headers.get("origin") !== route.origin) return new Response(null, { status: 403, headers: noStore });
      if (url.pathname === "/logout") {
        let text;
        try { text = await readLimited(request, 4096); } catch { return new Response(null, { status: 413, headers: noStore }); }
        const csrfToken = new URLSearchParams(text).get("csrf") ?? "";
        let result;
        try { result = await object.session(request.headers.get("cookie") ?? "", "logout", csrfToken, ownerRoute); }
        catch (error) { logOverload(error, "application"); return new Response(null, { status: 503, headers: noStore }); }
        if (result.status !== 204) {
          const status = result.status === 429 ? 429 : Number.isInteger(result.status) && result.status >= 400 && result.status < 500 && result.status !== 408 ? result.status : 503;
          return new Response(null, { status, headers: noStore });
        }
        const headers = new Headers({ ...noStore, location: "/login" });
        for (const cookie of result.headers["Set-Cookie"] ?? result.headers["set-cookie"] ?? []) headers.append("set-cookie", cookie);
        return new Response(null, { status: 303, headers });
      }
      let text;
      try { text = await readLimited(request, 4096); } catch { return new Response(null, { status: 413, headers: noStore }); }
      const form = new URLSearchParams(text);
      let result;
      try { result = await object.login(form.get("email") ?? "", form.get("password") ?? "", request.headers.get("cf-connecting-ip") ?? "local", ownerRoute); }
      catch (error) { logOverload(error, "application"); return new Response(null, { status: 503, headers: noStore }); }
      if (result.status === 503) return new Response(null, { status: 503, headers: noStore });
      if (result.status === 429) return page("<h1>Too many attempts</h1><p>Try again shortly.</p>", 429);
      if (result.status !== 200 || !result.cookie) return page('<h1>Sign in failed</h1><p>Check your email and password.</p><a href="/login">Try again</a>', 401);
      return new Response(null, { status: 303, headers: { ...noStore, location: "/app", "set-cookie": result.cookie } });
    }
    if (url.pathname === "/app" && request.method === "GET") {
      let result;
      try { result = await object.session(request.headers.get("cookie") ?? "", "read", "", ownerRoute); }
      catch (error) { logOverload(error, "application"); return new Response(null, { status: 503, headers: noStore }); }
      if (result.status === 429) return new Response(null, { status: 429, headers: noStore });
      if (result.status !== 200) {
        const unauthenticated = Number.isInteger(result.status) && result.status >= 400 && result.status < 500 && result.status !== 408;
        return unauthenticated ? new Response(null, { status: 303, headers: { ...noStore, location: "/login" } }) : new Response(null, { status: 503, headers: noStore });
      }
      let csrf;
      try { csrf = await object.session(request.headers.get("cookie") ?? "", "csrf", "", ownerRoute); }
      catch (error) { logOverload(error, "application"); return new Response(null, { status: 503, headers: noStore }); }
      if (csrf.status === 429) return new Response(null, { status: 429, headers: noStore });
      if (csrf.status !== 200 || !/^[A-Za-z0-9_-]+$/.test(csrf.data?.csrf_token ?? "")) return new Response(null, { status: 503, headers: noStore });
      return page(`<h1>Signed in</h1><form action="/logout" method="post"><input type="hidden" name="csrf" value="${csrf.data.csrf_token}"><button>Sign out</button></form>`);
    }
    if (request.method !== "GET" || url.pathname !== "/health") {
      return new Response(null, { status: 404, headers: { "cache-control": "no-store" } });
    }
    const status = await object.status(false, ownerRoute);
    return Response.json(status, { status: status.ready ? 200 : 503, headers: { "cache-control": "no-store" } });
  },
};
