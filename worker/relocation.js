import { execute } from "./sql.js";

const MAX_SNAPSHOT_BYTES = 512 * 1024;
const MAX_SNAPSHOT_ROWS = 10_000;
const quote = (value) => '"' + value.replaceAll('"', '""') + '"';

function metadata(storage) {
  storage.sql.exec(`CREATE TABLE IF NOT EXISTS mapi_relocation_project (
    project_id TEXT PRIMARY KEY, generation INTEGER NOT NULL, state TEXT NOT NULL,
    move_id TEXT, digest TEXT, object_name TEXT NOT NULL
  )`);
}

function project(storage, projectId) {
  return storage.sql.exec("SELECT project_id, generation, state, move_id, digest, object_name FROM mapi_relocation_project WHERE project_id = ?", projectId).toArray()[0];
}

export function initializeProjectFence(storage, projectId, objectName, generation = 1) {
  metadata(storage);
  const existing = storage.sql.exec("SELECT project_id, object_name FROM mapi_relocation_project").toArray();
  if (existing.some((entry) => entry.project_id !== projectId || entry.object_name !== objectName)) throw new Error("Project object already owned");
  storage.sql.exec("INSERT OR IGNORE INTO mapi_relocation_project (project_id, generation, state, object_name) VALUES (?, ?, 'active', ?)", projectId, generation, objectName);
}

// Call inside every project mutation's transaction. A cached registry route is
// insufficient because a previous owner may have been fenced since resolution.
export function assertProjectWritable(storage, projectId, generation) {
  const state = project(storage, projectId);
  if (!state || state.state !== "active" || state.generation !== generation) throw new Error("Project is fenced or the route is stale");
}

export function freezeProject(storage, projectId, generation, moveId) {
  return storage.transactionSync(() => {
    const state = project(storage, projectId);
    if (state?.state === "frozen" && state.move_id === moveId && state.generation === generation) return;
    assertProjectWritable(storage, projectId, generation);
    storage.sql.exec("UPDATE mapi_relocation_project SET state = 'frozen', move_id = ?, digest = NULL WHERE project_id = ?", moveId, projectId);
  });
}

function columns(storage, name) {
  return storage.sql.exec(`PRAGMA table_xinfo(${quote(name)})`).toArray().filter((column) => column.hidden === 0).map((column) => column.name);
}

async function digest(content) {
  const bytes = new TextEncoder().encode(content);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

// The caller supplies the complete schema-owned table list. Large projects are
// rejected before transfer and need a resumable chunked transport.
export async function snapshotProject(storage, projectId, generation, moveId, tables) {
  const snapshot = storage.transactionSync(() => {
    const state = project(storage, projectId);
    if (state?.state !== "frozen" || state.generation !== generation || state.move_id !== moveId) throw new Error("Source is not fenced for this move");
    if (!tables.length || new Set(tables).size !== tables.length || tables.some((name) => name.startsWith("mapi_relocation_"))) throw new Error("Invalid snapshot tables");
    let rows = 0;
    let estimatedBytes = 0;
    const data = tables.map((name) => {
      const names = columns(storage, name);
      if (!names.length) throw new Error("Snapshot table is missing");
      const count = storage.sql.exec(`SELECT COUNT(*) AS n FROM ${quote(name)}`).one().n;
      rows += count;
      if (rows > MAX_SNAPSHOT_ROWS) throw new Error("Snapshot row limit exceeded");
      const result = [];
      for (let offset = 0; offset < count; offset++) {
        const row = execute(storage, { statement: `SELECT ${names.map(quote).join(", ")} FROM ${quote(name)} ORDER BY ${names.map(quote).join(", ")} LIMIT 1 OFFSET ?`, args: [{ kind: "value", value: offset }], query: true }).rows[0];
        estimatedBytes += new TextEncoder().encode(JSON.stringify(row)).length + 1;
        if (estimatedBytes > MAX_SNAPSHOT_BYTES) throw new Error("Snapshot byte limit exceeded");
        result.push(row);
      }
      return { name, columns: names, rows: result };
    });
    return { projectId, generation, moveId, data };
  });
  const content = JSON.stringify(snapshot);
  if (new TextEncoder().encode(content).length > MAX_SNAPSHOT_BYTES) throw new Error("Snapshot byte limit exceeded");
  const hash = await digest(content);
  storage.transactionSync(() => {
    const state = project(storage, projectId);
    if (state?.state !== "frozen" || state.generation !== generation || state.move_id !== moveId) throw new Error("Source fence changed during snapshot");
    if (state.digest && state.digest !== hash) throw new Error("Snapshot changed on retry");
    storage.sql.exec("UPDATE mapi_relocation_project SET digest = ? WHERE project_id = ?", hash, projectId);
  });
  return { content, digest: hash };
}

export async function stageProject(storage, envelope, tables, destinationObject, failAfterRows = 0) {
  if (typeof envelope.content !== "string" || new TextEncoder().encode(envelope.content).length > MAX_SNAPSHOT_BYTES) throw new Error("Snapshot byte limit exceeded");
  if (await digest(envelope.content) !== envelope.digest) throw new Error("Snapshot digest mismatch");
  const snapshot = JSON.parse(envelope.content);
  if (!Array.isArray(snapshot.data) || JSON.stringify(snapshot.data.map((table) => table.name)) !== JSON.stringify(tables)) throw new Error("Snapshot tables differ");
  let rowCount = 0;
  for (const table of snapshot.data) rowCount += table.rows.length;
  if (rowCount > MAX_SNAPSHOT_ROWS) throw new Error("Snapshot row limit exceeded");
  metadata(storage);
  return storage.transactionSync(() => {
    const existing = project(storage, snapshot.projectId);
    if (existing?.state === "staged" && existing.move_id === snapshot.moveId && existing.digest === envelope.digest && existing.generation === snapshot.generation + 1 && existing.object_name === destinationObject) return;
    if (existing || storage.sql.exec("SELECT COUNT(*) AS n FROM mapi_relocation_project").one().n) throw new Error("Destination is not empty");
    if (!destinationObject) throw new Error("Destination object is missing");
    storage.sql.exec("PRAGMA defer_foreign_keys = ON");
    let inserted = 0;
    for (const table of snapshot.data) {
      const expected = columns(storage, table.name);
      if (JSON.stringify(expected) !== JSON.stringify(table.columns)) throw new Error("Snapshot columns differ");
      if (storage.sql.exec(`SELECT COUNT(*) AS n FROM ${quote(table.name)}`).one().n !== 0) throw new Error("Destination table is not empty");
      for (const row of table.rows) {
        if (row.length !== expected.length) throw new Error("Snapshot row has incorrect width");
        const args = row.map((value) => value && typeof value === "object" && "integer" in value ? { kind: "int", value: value.integer } : value && typeof value === "object" && "blob" in value ? { kind: "blob", value: value.blob } : { kind: "value", value });
        execute(storage, { statement: `INSERT INTO ${quote(table.name)} (${expected.map(quote).join(", ")}) VALUES (${expected.map(() => "?").join(", ")})`, args, query: false });
        inserted++;
        if (failAfterRows && inserted === failAfterRows) throw new Error("Injected import failure");
      }
    }
    if (storage.sql.exec("PRAGMA foreign_key_check").toArray().length) throw new Error("Snapshot violates foreign keys");
    storage.sql.exec("INSERT INTO mapi_relocation_project VALUES (?, ?, 'staged', ?, ?, ?)", snapshot.projectId, snapshot.generation + 1, snapshot.moveId, envelope.digest, destinationObject);
  });
}

// The orchestrator must activate only after a successful registry CAS. Callers
// must authenticate this control path and validate that the registry agrees.
export function activateProject(storage, projectId, generation, moveId, committedRoute) {
  if (committedRoute?.state !== "active" || committedRoute.project_id !== projectId || committedRoute.generation !== generation || committedRoute.move_id !== moveId) throw new Error("Registry has not committed this move");
  return storage.transactionSync(() => {
    const state = project(storage, projectId);
    if (state?.state === "active" && state.generation === generation && state.move_id === moveId && state.object_name === committedRoute.source_object) return;
    if (state?.state !== "staged" || state.generation !== generation || state.move_id !== moveId || state.object_name !== committedRoute.source_object) throw new Error("Destination is not staged for this move");
    storage.sql.exec("UPDATE mapi_relocation_project SET state = 'active' WHERE project_id = ?", projectId);
  });
}

export function retireProject(storage, projectId, generation, moveId, committedRoute) {
  if (committedRoute?.state !== "active" || committedRoute.project_id !== projectId || committedRoute.generation !== generation + 1 || committedRoute.move_id !== moveId) throw new Error("Registry has not committed this move");
  return storage.transactionSync(() => {
    const state = project(storage, projectId);
    if (state?.state === "retired" && state.move_id === moveId) return;
    if (state?.state !== "frozen" || state.generation !== generation || state.move_id !== moveId || state.object_name === committedRoute.source_object) throw new Error("Source is not fenced for this move");
    storage.sql.exec("UPDATE mapi_relocation_project SET state = 'retired' WHERE project_id = ?", projectId);
  });
}

export function initializeRouteGeneration(storage) {
  storage.sql.exec(`CREATE TABLE IF NOT EXISTS mapi_relocation_routes (
    project_id TEXT PRIMARY KEY, origin TEXT NOT NULL, source_object TEXT NOT NULL,
    destination_object TEXT, generation INTEGER NOT NULL, state TEXT NOT NULL, move_id TEXT
  )`);
}

export function registerRouteGeneration(storage, projectId, origin, sourceObject) {
  initializeRouteGeneration(storage);
  return storage.transactionSync(() => {
    const route = storage.sql.exec("SELECT project_id, origin, object_name, state FROM project_routes WHERE project_id = ?", projectId).toArray()[0];
    if (!route || route.origin !== origin || route.object_name !== sourceObject || route.state !== "active") throw new Error("Registry route mismatch");
    storage.sql.exec("INSERT OR IGNORE INTO mapi_relocation_routes (project_id, origin, source_object, generation, state) VALUES (?, ?, ?, 1, 'active')", projectId, origin, sourceObject);
  });
}

export function readRouteGeneration(storage, projectId) {
  return storage.sql.exec("SELECT * FROM mapi_relocation_routes WHERE project_id = ?", projectId).toArray()[0] ?? null;
}

export function beginRelocation(storage, projectId, sourceObject, destinationObject, generation, moveId) {
  if (!moveId || !destinationObject || destinationObject === sourceObject) throw new Error("Invalid move");
  return storage.transactionSync(() => {
    const route = readRouteGeneration(storage, projectId);
    if (route?.state === "moving" && route.move_id === moveId && route.source_object === sourceObject && route.destination_object === destinationObject && route.generation === generation) return route;
    if (!route || route.state !== "active" || route.source_object !== sourceObject || route.generation !== generation) throw new Error("Stale or conflicting move");
    storage.sql.exec("UPDATE mapi_relocation_routes SET state = 'moving', destination_object = ?, move_id = ? WHERE project_id = ?", destinationObject, moveId, projectId);
    return readRouteGeneration(storage, projectId);
  });
}

export function commitRelocation(storage, projectId, generation, moveId, frozen, staged) {
  return storage.transactionSync(() => {
    const route = readRouteGeneration(storage, projectId);
    if (route?.state === "active" && route.generation === generation + 1 && route.move_id === moveId) return route;
    if (!route || route.state !== "moving" || route.generation !== generation || route.move_id !== moveId || frozen?.state !== "frozen" || frozen.project_id !== projectId || frozen.generation !== generation || frozen.move_id !== moveId || frozen.object_name !== route.source_object || !frozen.digest || staged?.state !== "staged" || staged.project_id !== projectId || staged.generation !== generation + 1 || staged.move_id !== moveId || staged.object_name !== route.destination_object || staged.digest !== frozen.digest) throw new Error("Source and destination are not ready for this move");
    const current = storage.sql.exec("SELECT object_name, state FROM project_routes WHERE project_id = ?", projectId).toArray()[0];
    if (!current || current.state !== "active" || current.object_name !== route.source_object) throw new Error("Registry route changed");
    storage.sql.exec("UPDATE project_routes SET object_name = ? WHERE project_id = ?", route.destination_object, projectId);
    storage.sql.exec("UPDATE mapi_relocation_routes SET state = 'active', source_object = destination_object, destination_object = NULL, generation = generation + 1 WHERE project_id = ?", projectId);
    return readRouteGeneration(storage, projectId);
  });
}

export function projectFenceStatus(storage, projectId) {
  return project(storage, projectId) ?? null;
}
