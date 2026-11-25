import { invalidateTextPreflightMarker } from './relocation-text-marker.js';

// These helpers are used by the migration coordinator and owner mutation
// paths. The caller must obtain route authority from the registry.
// These identifiers cross a JavaScript/SQLite boundary and must have a stable
// Unicode representation. Reject unpaired UTF-16 surrogates before touching
// storage; otherwise their conversion can make an authority tuple ambiguous.
function validFenceText(value) {
  if (typeof value !== "string" || value.length === 0) return false;
  for (let i = 0; i < value.length; i++) {
    const unit = value.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return false;
  }
  return true;
}

function validateRoute(route) {
  if (!route || !validFenceText(route.projectId) ||
      !validFenceText(route.origin) ||
      !validFenceText(route.objectName) ||
      !Number.isSafeInteger(route.generation) || route.generation < 1) {
    throw new Error("Invalid owner route");
  }
}

// Reserve a fresh destination before importing. The reservation survives
// eviction and prevents the application from serving requests until activation.
export function reserveMoveDestination(storage, route, moveId) {
  validateRoute(route);
  if (route.generation < 2) throw new Error("Invalid destination generation");
  if (!validFenceText(moveId)) throw new Error("Invalid move ID");
  return storage.transactionSync(() => {
    storage.sql.exec(`CREATE TABLE IF NOT EXISTS mapi_destination_reservation (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      project_id TEXT NOT NULL,
      origin TEXT NOT NULL,
      object_name TEXT NOT NULL,
      generation INTEGER NOT NULL,
      move_id TEXT NOT NULL
    )`);
    // A prior reservation may be retried after eviction, but only the schema
    // we create here can enforce a single owner without write side effects.
    // Normalize ASCII whitespace runs and ASCII case, but require the same
    // punctuation spacing. Noncanonical equivalent definitions fail closed.
    const expected = 'create table mapi_destination_reservation ( singleton integer primary key check (singleton = 1), project_id text not null, origin text not null, object_name text not null, generation integer not null, move_id text not null )';
    const definition = storage.sql.exec("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'mapi_destination_reservation' COLLATE NOCASE").toArray()[0]?.sql;
    const extras = storage.sql.exec("SELECT 1 FROM sqlite_schema WHERE tbl_name = 'mapi_destination_reservation' COLLATE NOCASE AND type IN ('index', 'trigger') AND sql IS NOT NULL LIMIT 1").toArray();
    const normalize = text => text.replace(/[ \t\r\n\f]+/g, ' ').replace(/^ +| +$/g, '').replace(/[A-Z]/g, char => char.toLowerCase());
    if (typeof definition !== 'string' || normalize(definition) !== expected || extras.length ||
        storage.sql.exec('SELECT 1 FROM mapi_destination_reservation WHERE singleton <> 1 LIMIT 1').toArray().length) {
      throw new Error('Invalid destination reservation');
    }
    const existing = storage.sql.exec("SELECT 1 FROM mapi_destination_reservation WHERE singleton = 1").toArray().length;
    if (existing) {
      // Compare the tuple in SQLite instead of materializing stored control
      // values before validation; retries do not rewrite the reservation.
      const matches = storage.sql.exec("SELECT 1 FROM mapi_destination_reservation WHERE singleton = 1 AND project_id = ? AND origin = ? AND object_name = ? AND generation = ? AND move_id = ?", route.projectId, route.origin, route.objectName, route.generation, moveId).toArray().length;
      if (!matches) {
        throw new Error("Conflicting destination reservation");
      }
      return;
    }
    // SQLite resolves table and view names case-insensitively, and tables,
    // views and indexes share a schema namespace. A binary name lookup can
    // miss an occupied uppercase table or a view/index blocking creation.
    const object = name => storage.sql.exec("SELECT type FROM sqlite_schema WHERE name = ? COLLATE NOCASE AND type IN ('table', 'view', 'index') LIMIT 1", name).toArray()[0]?.type;
    const occupied = name => {
      const type = object(name);
      return type !== undefined && (type !== 'table' || storage.sql.exec(`SELECT 1 FROM ${name} LIMIT 1`).toArray().length > 0);
    };
    if (occupied('mapi_project') || occupied('projects') || occupied('mapi_project_origin') ||
        object('mapi_pending_owner') !== undefined || object('mapi_owner_fence') !== undefined ||
        object('mapi_relocation_project') !== undefined) {
      throw new Error("Destination is not fresh");
    }
    storage.sql.exec("INSERT INTO mapi_destination_reservation VALUES (1, ?, ?, ?, ?, ?)", route.projectId, route.origin, route.objectName, route.generation, moveId);
  });
}

export function createOwnerFenceTable(storage) {
  storage.sql.exec(`CREATE TABLE IF NOT EXISTS mapi_owner_fence (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      project_id TEXT NOT NULL,
      origin TEXT NOT NULL,
      object_name TEXT NOT NULL,
      generation INTEGER NOT NULL CHECK (generation > 0),
      state TEXT NOT NULL CHECK (state IN ('pending', 'active', 'frozen', 'retired')),
      move_id TEXT,
      digest TEXT
  )`);
}

// An extra trigger can mutate business or audit rows while still leaving the
// expected fence row intact. The normal owner schema has no fence triggers;
// check inside the same transaction before executing a fence transition.
function requireNoFenceTriggers(storage, message) {
  if (storage.sql.exec("SELECT 1 FROM sqlite_schema WHERE type = 'trigger' AND tbl_name = 'mapi_owner_fence' COLLATE NOCASE LIMIT 1").toArray().length) {
    throw new Error(message);
  }
}

export function initializeOwnerFence(storage, route, invalidatePreflight = false) {
  validateRoute(route);
  return storage.transactionSync(() => {
    if (invalidatePreflight) invalidateTextPreflightMarker(storage);
    createOwnerFenceTable(storage);
    requireNoFenceTriggers(storage, "Owner fence initialization did not take effect");
    const current = storage.sql.exec("SELECT project_id, origin, object_name, generation, state FROM mapi_owner_fence WHERE singleton = 1").toArray()[0];
    if (current) {
      assertOwnerFence(storage, route);
      return;
    }
    storage.sql.exec("INSERT INTO mapi_owner_fence (singleton, project_id, origin, object_name, generation, state, move_id, digest) VALUES (1, ?, ?, ?, ?, 'active', NULL, NULL)", route.projectId, route.origin, route.objectName, route.generation);
    // Do not acknowledge adoption if an ignored insert or a trigger leaves a
    // different row. Throwing here rolls back the insert and side effects.
    const result = storage.sql.exec(`SELECT changes() AS changed, EXISTS (
      SELECT 1 FROM mapi_owner_fence WHERE singleton = 1 AND project_id = ?
        AND origin = ? AND object_name = ? AND generation = ?
        AND state = 'active' AND move_id IS NULL AND digest IS NULL
    ) AS active`, route.projectId, route.origin, route.objectName, route.generation).one();
    if (result.changed !== 1 || result.active !== 1) throw new Error("Owner fence initialization did not take effect");
    assertOwnerFence(storage, route);
  });
}

// Invoke while the authoritative storage transaction is open.
export function assertOwnerFence(storage, route) {
  validateRoute(route);
  const current = storage.sql.exec("SELECT project_id, origin, object_name, generation, state FROM mapi_owner_fence WHERE singleton = 1").toArray()[0];
  if (!current || current.state !== "active" || current.project_id !== route.projectId ||
      current.origin !== route.origin || current.object_name !== route.objectName ||
      current.generation !== route.generation) {
    throw new Error("Owner is fenced or route is stale");
  }
}

export function withOwnerFence(storage, route, mutation) {
  validateRoute(route);
  return storage.transactionSync(() => {
    assertOwnerFence(storage, route);
    const result = mutation();
    // transactionSync cannot keep the fence and mutation atomic across an
    // asynchronous continuation. Throw inside the transaction to roll back
    // any writes performed before a callback accidentally returns a Promise.
    // This does not cancel a continuation already scheduled by that callback;
    // callers must never schedule work that can mutate storage after returning.
    if (result !== null && (typeof result === "object" || typeof result === "function") && typeof result.then === "function") {
      throw new Error("Owner fence mutation must be synchronous");
    }
    return result;
  });
}

export function freezeOwnerFence(storage, route, moveId, invalidatePreflight = false) {
  validateRoute(route);
  if (!validFenceText(moveId)) throw new Error("Invalid move ID");
  return storage.transactionSync(() => {
    requireNoFenceTriggers(storage, "Owner freeze did not take effect");
    const current = storage.sql.exec("SELECT project_id, origin, object_name, generation, state, move_id FROM mapi_owner_fence WHERE singleton = 1").toArray()[0];
    if (current?.state === "frozen" && current.project_id === route.projectId && current.origin === route.origin &&
        current.object_name === route.objectName && current.generation === route.generation && current.move_id === moveId) return;
    assertOwnerFence(storage, route);
    if (invalidatePreflight) invalidateTextPreflightMarker(storage);
    // A move needs a distinct, exactly representable generation for the
    // destination. Do not freeze an active source that cannot have one.
    // Preserve idempotent retries for a fence already frozen by older code.
    if (route.generation === Number.MAX_SAFE_INTEGER) throw new Error("Source generation has no safe successor");
    storage.sql.exec("UPDATE mapi_owner_fence SET state = 'frozen', move_id = ?, digest = NULL WHERE singleton = 1", moveId);
    // An ignored update or a trigger that changes the row back must not be
    // acknowledged as a fence. Check both the logical update count and the
    // durable row inside this transaction so any side effects roll back.
    const result = storage.sql.exec(`SELECT changes() AS changed, EXISTS (
      SELECT 1 FROM mapi_owner_fence WHERE singleton = 1 AND project_id = ?
        AND origin = ? AND object_name = ? AND generation = ?
        AND state = 'frozen' AND move_id = ? AND digest IS NULL
    ) AS frozen`, route.projectId, route.origin, route.objectName, route.generation, moveId).one();
    if (result.changed !== 1 || result.frozen !== 1) throw new Error("Owner freeze did not take effect");
  });
}

// The caller must first verify the committed route with the registry. Keep the
// local transition and its postcondition in one synchronous transaction.
export function retireOwnerFence(storage, route, moveId, digest, reconciliationReady) {
  validateRoute(route);
  if (!validFenceText(moveId)) throw new Error("Invalid move ID");
  return storage.transactionSync(() => {
    requireNoFenceTriggers(storage, "Owner retirement did not take effect");
    const current = storage.sql.exec("SELECT project_id, origin, object_name, generation, state, move_id, digest FROM mapi_owner_fence WHERE singleton = 1").toArray()[0];
    if (!current || !["frozen", "retired"].includes(current.state) || current.project_id !== route.projectId ||
        current.origin !== route.origin || current.object_name !== route.objectName || current.generation !== route.generation ||
        current.move_id !== moveId || current.digest !== digest) throw new Error("Source retirement mismatch");
    if (current.state === "retired") return;
    if (!reconciliationReady) throw new Error("Legacy committed relocation requires manual review");
    storage.sql.exec("UPDATE mapi_owner_fence SET state = 'retired' WHERE singleton = 1");
    const result = storage.sql.exec(`SELECT changes() AS changed, EXISTS (
      SELECT 1 FROM mapi_owner_fence WHERE singleton = 1 AND project_id = ?
        AND origin = ? AND object_name = ? AND generation = ?
        AND state = 'retired' AND move_id = ? AND digest IS ?
    ) AS retired`, route.projectId, route.origin, route.objectName, route.generation, moveId, digest).one();
    if (result.changed !== 1 || result.retired !== 1) throw new Error("Owner retirement did not take effect");
  });
}
