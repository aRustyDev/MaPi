import { completedHistoryCheckpoint } from './registry-history.js';

// These functions are for a trusted coordinator. Source and destination
// attestations must be read from their authoritative objects by that coordinator.
export function validRelocationDigest(value) {
  return typeof value === 'string' && value.length === 64 && /^[0-9a-f]{64}$/.test(value);
}

export function initializeMoveRegistry(storage) {
  storage.sql.exec(`CREATE TABLE IF NOT EXISTS mapi_route_moves (
    project_id TEXT PRIMARY KEY,
    source_object TEXT NOT NULL,
    destination_object TEXT NOT NULL,
    generation INTEGER NOT NULL,
    move_id TEXT NOT NULL,
    phase TEXT NOT NULL CHECK (phase IN ('moving', 'committed')),
    digest TEXT
  )`);
  storage.sql.exec("CREATE TABLE IF NOT EXISTS mapi_route_move_ids (move_id TEXT PRIMARY KEY, project_id TEXT NOT NULL)");
  storage.sql.exec("CREATE TABLE IF NOT EXISTS mapi_route_move_objects (object_name TEXT PRIMARY KEY)");
  storage.sql.exec("CREATE TABLE IF NOT EXISTS mapi_move_reconciliation (project_id TEXT PRIMARY KEY, move_id TEXT NOT NULL, tables TEXT NOT NULL, table_index INTEGER NOT NULL, cursor TEXT)");
  if (!storage.sql.exec("PRAGMA table_info(mapi_move_reconciliation)").toArray().some(column => column.name === 'journal_version')) storage.sql.exec('ALTER TABLE mapi_move_reconciliation ADD COLUMN journal_version INTEGER NOT NULL DEFAULT 0');
  storage.sql.exec("CREATE TABLE IF NOT EXISTS mapi_move_journals (move_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, complete INTEGER NOT NULL)");
  storage.sql.exec("CREATE TABLE IF NOT EXISTS mapi_move_evidence (move_id TEXT NOT NULL, project_id TEXT NOT NULL, table_index INTEGER NOT NULL, table_name TEXT NOT NULL, cursor_in TEXT NOT NULL, cursor_out TEXT, row_count INTEGER NOT NULL, digest TEXT NOT NULL, table_done INTEGER NOT NULL, UNIQUE (move_id, table_index, cursor_in))");
  storage.sql.exec("CREATE TABLE IF NOT EXISTS mapi_move_completion (project_id TEXT NOT NULL, move_id TEXT NOT NULL, PRIMARY KEY(project_id, move_id))");
  storage.sql.exec("CREATE TABLE IF NOT EXISTS mapi_move_history (move_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, source_object TEXT NOT NULL, destination_object TEXT NOT NULL, generation INTEGER NOT NULL, digest TEXT NOT NULL)");
  storage.sql.exec("INSERT OR IGNORE INTO mapi_route_move_objects SELECT object_name FROM project_routes");
  storage.sql.exec("INSERT OR IGNORE INTO mapi_route_move_objects SELECT source_object FROM mapi_route_moves");
  storage.sql.exec("INSERT OR IGNORE INTO mapi_route_move_objects SELECT destination_object FROM mapi_route_moves");
}

export function beginRegistryMove(storage, projectId, sourceObject, destinationObject, generation, moveId) {
  if (!projectId || !sourceObject || !destinationObject || destinationObject === sourceObject || !moveId || !Number.isSafeInteger(generation) || generation < 1 || generation === Number.MAX_SAFE_INTEGER) throw new Error("Invalid move");
  return storage.transactionSync(() => {
    const current = storage.sql.exec("SELECT * FROM mapi_route_moves WHERE project_id = ?", projectId).toArray()[0];
    if (current?.phase === "moving" && current.source_object === sourceObject && current.destination_object === destinationObject && current.generation === generation && current.move_id === moveId) return current;
    if (current?.phase === "moving") throw new Error("Conflicting move");
    const route = storage.sql.exec("SELECT object_name, state, generation FROM project_routes WHERE project_id = ?", projectId).toArray()[0];
    if (!route || route.state !== "active" || route.object_name !== sourceObject || route.generation !== generation) throw new Error("Stale route");
    if (storage.sql.exec("SELECT 1 FROM mapi_project_recoveries WHERE project_id = ?", projectId).toArray().length) throw new Error("Project route is recovering");
    if (storage.sql.exec("SELECT 1 FROM mapi_route_move_ids WHERE move_id = ?", moveId).toArray().length) throw new Error("Move ID already used");
    if (storage.sql.exec("SELECT 1 FROM project_routes WHERE object_name = ?", destinationObject).toArray().length ||
        storage.sql.exec("SELECT 1 FROM mapi_route_move_objects WHERE object_name = ?", destinationObject).toArray().length) throw new Error("Destination object already used");
    storage.sql.exec("INSERT OR IGNORE INTO mapi_route_move_objects VALUES (?)", sourceObject);
    storage.sql.exec("INSERT INTO mapi_route_move_objects VALUES (?)", destinationObject);
    storage.sql.exec("INSERT INTO mapi_route_move_ids VALUES (?, ?)", moveId, projectId);
    storage.sql.exec("DELETE FROM mapi_move_reconciliation WHERE project_id = ?", projectId);
    storage.sql.exec("INSERT INTO mapi_route_moves VALUES (?, ?, ?, ?, ?, 'moving', NULL) ON CONFLICT(project_id) DO UPDATE SET source_object = excluded.source_object, destination_object = excluded.destination_object, generation = excluded.generation, move_id = excluded.move_id, phase = 'moving', digest = NULL", projectId, sourceObject, destinationObject, generation, moveId);
    return storage.sql.exec("SELECT * FROM mapi_route_moves WHERE project_id = ?", projectId).one();
  });
}

export function commitRegistryMove(storage, projectId, generation, moveId, source, destination) {
  return storage.transactionSync(() => {
    const move = storage.sql.exec("SELECT * FROM mapi_route_moves WHERE project_id = ?", projectId).toArray()[0];
    const route = storage.sql.exec("SELECT origin, project_id, object_name, state, generation FROM project_routes WHERE project_id = ?", projectId).toArray()[0];
    if (move?.phase === "committed" && move.move_id === moveId && move.generation === generation && route?.object_name === move.destination_object && route.generation === generation + 1) return route;
    if (!move || move.phase !== "moving" || move.generation !== generation || move.move_id !== moveId || !route || route.state !== "active" || route.object_name !== move.source_object || route.generation !== generation ||
        source?.state !== "frozen" || source.project_id !== projectId || source.object_name !== move.source_object || source.generation !== generation || source.move_id !== moveId || !validRelocationDigest(source.digest) ||
        destination?.state !== "staged" || destination.project_id !== projectId || destination.object_name !== move.destination_object || destination.generation !== generation + 1 || destination.move_id !== moveId || destination.digest !== source.digest) {
      throw new Error("Move reconciliation failed");
    }
    if (!completedHistoryCheckpoint(storage.sql, { projectId, moveId, sourceObject: move.source_object, destinationObject: move.destination_object, generation }, source.digest)) throw new Error("Transfer history verification incomplete");
    storage.sql.exec("UPDATE project_routes SET object_name = ?, generation = ? WHERE project_id = ? AND object_name = ? AND generation = ?", move.destination_object, generation + 1, projectId, move.source_object, generation);
    storage.sql.exec("UPDATE mapi_route_moves SET phase = 'committed', digest = ? WHERE project_id = ?", source.digest, projectId);
    return storage.sql.exec("SELECT origin, project_id, object_name, state, generation FROM project_routes WHERE project_id = ?", projectId).one();
  });
}
