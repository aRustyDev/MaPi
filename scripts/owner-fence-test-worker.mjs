import { DurableObject } from "cloudflare:workers";
import { createOwnerFenceTable, initializeOwnerFence, withOwnerFence, freezeOwnerFence, reserveMoveDestination } from "../worker/owner-fence.js";

const route = { projectId: "proj_test", origin: "https://project.example", objectName: "application", generation: 1 };
export class OwnerFenceTest extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS records (name TEXT PRIMARY KEY)");
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS audit (name TEXT PRIMARY KEY)");
  }
  init() { initializeOwnerFence(this.ctx.storage, route); }
  initAt(authority) { initializeOwnerFence(this.ctx.storage, authority); }
  freezeAt(authority, moveId) { freezeOwnerFence(this.ctx.storage, authority, moveId); }
  legacyFreeze(moveId) { this.ctx.storage.sql.exec("UPDATE mapi_owner_fence SET state = 'frozen', move_id = ? WHERE singleton = 1", moveId); }
  fenceState() { return this.ctx.storage.sql.exec('SELECT * FROM mapi_owner_fence ORDER BY singleton').toArray(); }
  write(authority, name, fail = false) {
    return withOwnerFence(this.ctx.storage, authority, () => {
      this.ctx.storage.sql.exec("INSERT INTO records VALUES (?)", name);
      this.ctx.storage.sql.exec("INSERT INTO audit VALUES (?)", name);
      if (fail) throw new Error("injected mutation failure");
    });
  }
  writeReturningPromise(authority, customThenable = false) {
    return withOwnerFence(this.ctx.storage, authority, () => {
      this.ctx.storage.sql.exec("INSERT INTO records VALUES ('async-result')");
      this.ctx.storage.sql.exec("INSERT INTO audit VALUES ('async-result')");
      return customThenable ? { then() {} } : Promise.resolve();
    });
  }
  freeze(id) { freezeOwnerFence(this.ctx.storage, route, id); }
  seedInitFault(kind) {
    const sql = this.ctx.storage.sql;
    if (kind === 'uppercase-side-effect') {
      sql.exec(`CREATE TABLE MAPI_OWNER_FENCE (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1), project_id TEXT NOT NULL,
        origin TEXT NOT NULL, object_name TEXT NOT NULL, generation INTEGER NOT NULL CHECK (generation > 0),
        state TEXT NOT NULL CHECK (state IN ('pending', 'active', 'frozen', 'retired')), move_id TEXT, digest TEXT
      )`);
    } else createOwnerFenceTable(this.ctx.storage);
    if (kind === 'ignore') {
      sql.exec("CREATE TRIGGER init_fault BEFORE INSERT ON mapi_owner_fence BEGIN INSERT INTO records VALUES ('triggered'); SELECT RAISE(IGNORE); END");
    } else if (kind === 'undo') {
      sql.exec("CREATE TRIGGER init_fault AFTER INSERT ON mapi_owner_fence BEGIN INSERT INTO records VALUES ('triggered'); DELETE FROM mapi_owner_fence WHERE singleton = 1; END");
    } else if (kind === 'side-effect' || kind === 'uppercase-side-effect') {
      sql.exec("CREATE TRIGGER init_fault AFTER INSERT ON mapi_owner_fence BEGIN INSERT INTO records VALUES ('triggered'); INSERT INTO audit VALUES ('triggered'); END");
    } else throw Error('Unknown initialization fault');
  }
  seedFreezeFault(kind) {
    const sql = this.ctx.storage.sql;
    if (kind === 'ignore') {
      sql.exec("CREATE TRIGGER freeze_fault BEFORE UPDATE ON mapi_owner_fence WHEN NEW.state = 'frozen' BEGIN INSERT INTO records VALUES ('triggered'); SELECT RAISE(IGNORE); END");
    } else if (kind === 'undo') {
      sql.exec("CREATE TRIGGER freeze_fault AFTER UPDATE ON mapi_owner_fence WHEN NEW.state = 'frozen' BEGIN INSERT INTO records VALUES ('triggered'); UPDATE mapi_owner_fence SET state = 'active', move_id = NULL WHERE singleton = 1; END");
    } else if (kind === 'side-effect') {
      sql.exec("CREATE TRIGGER freeze_fault AFTER UPDATE ON mapi_owner_fence WHEN NEW.state = 'frozen' BEGIN INSERT INTO records VALUES ('triggered'); INSERT INTO audit VALUES ('triggered'); END");
    } else throw Error('Unknown freeze fault');
  }
  rows() {
    return ["records", "audit"].map((table) => this.ctx.storage.sql.exec(`SELECT name FROM ${table} ORDER BY name`).toArray().map((row) => row.name));
  }
  evict() { this.ctx.abort("owner fence restart"); }
  seedBadReservation(kind) {
    const sql = this.ctx.storage.sql;
    if (kind === "view") {
      sql.exec("CREATE VIEW mapi_destination_reservation AS SELECT 1 AS singleton, 'other' AS project_id, 'https://other.example' AS origin, 'other' AS object_name, 2 AS generation, 'other' AS move_id");
    } else if (kind === "schema") {
      sql.exec("CREATE TABLE mapi_destination_reservation (singleton INTEGER PRIMARY KEY, project_id TEXT NOT NULL, origin TEXT NOT NULL, object_name TEXT NOT NULL, generation INTEGER NOT NULL, move_id TEXT NOT NULL)");
    } else if (kind === "unicode-space") {
      sql.exec("CREATE TABLE mapi_destination_reservation ( singleton INTEGER PRIMARY KEY CHECK (singleton = 1), project_id\u00a0TEXT NOT NULL, origin TEXT NOT NULL, object_name TEXT NOT NULL, generation INTEGER NOT NULL, move_id TEXT NOT NULL )");
    } else if (kind === "format") {
      sql.exec("create table mapi_destination_reservation (\n singleton integer primary key check (singleton = 1),\n project_id text not null, origin text not null, object_name text not null, generation integer not null, move_id text not null\n )");
    } else if (kind === "noncanonical") {
      sql.exec("CREATE TABLE mapi_destination_reservation ( singleton INTEGER PRIMARY KEY CHECK(singleton=1), project_id TEXT NOT NULL, origin TEXT NOT NULL, object_name TEXT NOT NULL, generation INTEGER NOT NULL, move_id TEXT NOT NULL )");
    } else {
      sql.exec(`CREATE TABLE mapi_destination_reservation (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      project_id TEXT NOT NULL,
      origin TEXT NOT NULL,
      object_name TEXT NOT NULL,
      generation INTEGER NOT NULL,
      move_id TEXT NOT NULL
    )`);
      if (kind === "trigger") sql.exec("CREATE TRIGGER reservation_side_effect AFTER INSERT ON mapi_destination_reservation BEGIN INSERT INTO records VALUES ('triggered'); END");
      else if (kind === "index") sql.exec("CREATE INDEX reservation_extra_index ON mapi_destination_reservation(project_id)");
      else if (kind === "extra-row") {
        sql.exec("PRAGMA ignore_check_constraints = ON");
        sql.exec("INSERT INTO mapi_destination_reservation VALUES (2, 'other', 'https://other.example', 'other', 2, 'other')");
        sql.exec("PRAGMA ignore_check_constraints = OFF");
      } else throw Error("Unknown reservation fixture");
    }
  }
  seedStagedData() {
    this.ctx.storage.sql.exec('CREATE TABLE projects (id TEXT PRIMARY KEY)');
    this.ctx.storage.sql.exec("INSERT INTO projects VALUES ('proj_destination')");
    this.ctx.storage.sql.exec('CREATE TABLE mapi_relocation_project (project_id TEXT PRIMARY KEY, state TEXT NOT NULL)');
    this.ctx.storage.sql.exec("INSERT INTO mapi_relocation_project VALUES ('proj_destination', 'staged')");
  }
  seedOccupiedDestination() {
    this.ctx.storage.sql.exec('CREATE TABLE projects (id TEXT PRIMARY KEY)');
    this.ctx.storage.sql.exec("INSERT INTO projects VALUES ('old_project')");
  }
  reserveDestination(authority, moveId) { return reserveMoveDestination(this.ctx.storage, authority, moveId); }
  reservationState() {
    const sql = this.ctx.storage.sql;
    const tables = sql.exec("SELECT name, sql FROM sqlite_schema WHERE name = 'mapi_destination_reservation' OR tbl_name = 'mapi_destination_reservation' ORDER BY type, name").toArray();
    const rows = tables.some(table => table.name === 'mapi_destination_reservation') ? sql.exec("SELECT * FROM mapi_destination_reservation ORDER BY singleton").toArray() : [];
    const present = name => sql.exec("SELECT 1 FROM sqlite_schema WHERE type='table' AND name = ?", name).toArray().length > 0;
    const projects = present('projects') ? sql.exec('SELECT id FROM projects ORDER BY id').toArray() : [];
    const staged = present('mapi_relocation_project') ? sql.exec('SELECT * FROM mapi_relocation_project ORDER BY project_id').toArray() : [];
    return { tables, rows, business: this.rows(), projects, staged };
  }
}
const reject = async (fn, expected) => { try { await fn(); } catch (error) { if (expected && !String(error).includes(expected)) throw error; return; } throw new Error("Expected rejection"); };
export default {
  async fetch(request, env) {
    try {
      let owner = env.OWNER.getByName("test");
      if (new URL(request.url).pathname === "/restart") {
        await reject(() => owner.evict());
        owner = env.OWNER.getByName("test");
        await reject(() => owner.write(route, "after-restart"));
        if (JSON.stringify(await owner.rows()) !== '[["before"],["before"]]') throw new Error("fenced state changed after restart");
        return Response.json({ ok: true });
      }
      await reject(() => owner.write(route, "uninitialized"));
      for (const kind of ['ignore', 'undo', 'side-effect', 'uppercase-side-effect']) {
        const candidate = env.OWNER.getByName('init-fault-' + kind);
        const candidateRoute = { ...route, objectName: 'init-fault-' + kind };
        await candidate.seedInitFault(kind);
        const before = JSON.stringify({ fence: await candidate.fenceState(), rows: await candidate.rows() });
        await reject(() => candidate.initAt(candidateRoute), 'Owner fence initialization did not take effect');
        if (JSON.stringify({ fence: await candidate.fenceState(), rows: await candidate.rows() }) !== before) throw Error('Rejected initialization changed source: ' + kind);
        await reject(() => candidate.write(candidateRoute, 'must-not-write'));
      }
      // Valid supplementary Unicode survives the owner fence and reservation
      // round trip. Malformed JavaScript strings are tested separately with a
      // storage spy and are never sent to this SQLite fixture.
      const unicodeRoute = { projectId: 'project-😀', origin: 'https://project.example', objectName: 'source-😀', generation: 1 };
      const unicodeSource = env.OWNER.getByName('source-unicode');
      await unicodeSource.initAt(unicodeRoute);
      await unicodeSource.write(unicodeRoute, 'unicode-write');
      await unicodeSource.freezeAt(unicodeRoute, 'move-😀');
      await reject(() => unicodeSource.write(unicodeRoute, 'unicode-stale'), 'Owner is fenced or route is stale');
      const unicodeFence = (await unicodeSource.fenceState())[0];
      if (unicodeFence.project_id !== unicodeRoute.projectId || unicodeFence.object_name !== unicodeRoute.objectName || unicodeFence.move_id !== 'move-😀' || unicodeFence.state !== 'frozen') throw Error('Unicode fence differs');
      const unicodeDestination = env.OWNER.getByName('destination-unicode');
      const unicodeTarget = { ...unicodeRoute, objectName: 'destination-😀', generation: 2 };
      await unicodeDestination.reserveDestination(unicodeTarget, 'move-😀');
      await unicodeDestination.reserveDestination(unicodeTarget, 'move-😀');
      const unicodeReservation = (await unicodeDestination.reservationState()).rows[0];
      if (unicodeReservation.project_id !== unicodeTarget.projectId || unicodeReservation.object_name !== unicodeTarget.objectName || unicodeReservation.move_id !== 'move-😀') throw Error('Unicode reservation differs');
      const lastMovableRoute = { ...route, objectName: 'last-movable', generation: Number.MAX_SAFE_INTEGER - 1 };
      const lastMovable = env.OWNER.getByName('last-movable');
      await lastMovable.initAt(lastMovableRoute);
      await lastMovable.freezeAt(lastMovableRoute, 'last-move');
      await lastMovable.freezeAt(lastMovableRoute, 'last-move');
      if ((await lastMovable.fenceState())[0]?.state !== 'frozen') throw Error('Last movable generation did not freeze');
      const lastDestination = env.OWNER.getByName('last-destination');
      await lastDestination.reserveDestination({ ...lastMovableRoute, objectName: 'last-destination', generation: Number.MAX_SAFE_INTEGER }, 'last-move');
      const exhaustedRoute = { ...route, objectName: 'exhausted', generation: Number.MAX_SAFE_INTEGER };
      const exhausted = env.OWNER.getByName('exhausted');
      await exhausted.initAt(exhaustedRoute);
      await exhausted.write(exhaustedRoute, 'before-exhaustion');
      const exhaustedBefore = JSON.stringify({ fence: await exhausted.fenceState(), rows: await exhausted.rows() });
      await reject(() => exhausted.freezeAt(exhaustedRoute, 'cannot-move'), 'Source generation has no safe successor');
      if (JSON.stringify({ fence: await exhausted.fenceState(), rows: await exhausted.rows() }) !== exhaustedBefore) throw Error('Rejected freeze changed source state');
      await exhausted.write(exhaustedRoute, 'after-exhaustion');
      const legacyExhausted = env.OWNER.getByName('legacy-exhausted');
      await legacyExhausted.initAt(exhaustedRoute);
      await legacyExhausted.legacyFreeze('legacy-move');
      const legacyBefore = JSON.stringify(await legacyExhausted.fenceState());
      await legacyExhausted.freezeAt(exhaustedRoute, 'legacy-move');
      if (JSON.stringify(await legacyExhausted.fenceState()) !== legacyBefore) throw Error('Legacy freeze retry changed state');
      for (const kind of ['ignore', 'undo', 'side-effect']) {
        const candidate = env.OWNER.getByName('freeze-fault-' + kind);
        const candidateRoute = { ...route, objectName: 'freeze-fault-' + kind };
        await candidate.initAt(candidateRoute);
        await candidate.write(candidateRoute, 'before');
        await candidate.seedFreezeFault(kind);
        const before = JSON.stringify({ fence: await candidate.fenceState(), rows: await candidate.rows() });
        await reject(() => candidate.freezeAt(candidateRoute, 'fault-move'), 'Owner freeze did not take effect');
        if (JSON.stringify({ fence: await candidate.fenceState(), rows: await candidate.rows() }) !== before) throw Error('Rejected freeze changed source: ' + kind);
        await candidate.write(candidateRoute, 'after');
      }
      const destinationRoute = { projectId: 'proj_destination', origin: 'https://destination.example', objectName: 'destination', generation: 2 };
      let fresh = env.OWNER.getByName('reservation-fresh');
      await fresh.reserveDestination(destinationRoute, 'move-destination');
      await fresh.seedStagedData();
      const reserved = await fresh.reservationState();
      await fresh.reserveDestination(destinationRoute, 'move-destination');
      await reject(() => fresh.reserveDestination(destinationRoute, 'wrong-move'), 'Conflicting destination reservation');
      for (const changed of [
        { ...destinationRoute, projectId: 'proj_foreign' },
        { ...destinationRoute, origin: 'https://foreign.example' },
        { ...destinationRoute, objectName: 'foreign-owner' },
        { ...destinationRoute, generation: 3 },
      ]) await reject(() => fresh.reserveDestination(changed, 'move-destination'), 'Conflicting destination reservation');
      if (JSON.stringify(await fresh.reservationState()) !== JSON.stringify(reserved)) throw Error('Conflicting retry changed staged destination');
      await reject(() => fresh.evict());
      fresh = env.OWNER.getByName('reservation-fresh');
      await fresh.reserveDestination(destinationRoute, 'move-destination');
      if (JSON.stringify(await fresh.reservationState()) !== JSON.stringify(reserved)) throw Error('Valid reservation retry changed state');
      const formatted = env.OWNER.getByName('reservation-format');
      await formatted.seedBadReservation('format');
      await formatted.reserveDestination(destinationRoute, 'move-destination');
      const occupied = env.OWNER.getByName('reservation-occupied');
      await occupied.seedOccupiedDestination();
      const occupiedBefore = await occupied.reservationState();
      await reject(() => occupied.reserveDestination(destinationRoute, 'move-destination'), 'Destination is not fresh');
      if (JSON.stringify(await occupied.reservationState()) !== JSON.stringify(occupiedBefore)) throw Error('Rejected destination left a reservation or changed data');
      for (const kind of ['view', 'schema', 'unicode-space', 'noncanonical', 'trigger', 'index', 'extra-row']) {
        const candidate = env.OWNER.getByName('reservation-' + kind);
        await candidate.seedBadReservation(kind);
        const before = await candidate.reservationState();
        await reject(() => candidate.reserveDestination(destinationRoute, 'move-destination'), kind === 'view' ? undefined : 'Invalid destination reservation');
        if (JSON.stringify(await candidate.reservationState()) !== JSON.stringify(before)) throw Error('Rejected reservation changed destination state: ' + kind);
      }
      await owner.init();
      await owner.init();
      await reject(() => owner.write({ ...route, generation: 2 }, "wrong-generation"));
      await reject(() => owner.write({ ...route, objectName: "other" }, "wrong-owner"));
      await reject(() => owner.write({ ...route, origin: "https://other.example" }, "wrong-origin"));
      await reject(() => owner.write({ ...route, projectId: "proj_other" }, "wrong-project"));
      await reject(() => owner.write(route, "rolled-back", true));
      await reject(() => owner.writeReturningPromise(route), "Owner fence mutation must be synchronous");
      await reject(() => owner.writeReturningPromise(route, true), "Owner fence mutation must be synchronous");
      await owner.write(route, "before");
      await owner.freeze("move-1");
      await owner.freeze("move-1");
      await reject(() => owner.freeze("move-2"));
      await reject(() => owner.write(route, "stale"));
      if (JSON.stringify(await owner.rows()) !== '[["before"],["before"]]') throw new Error("rejected transaction changed rows");
      return Response.json({ ok: true });
    } catch (error) { return Response.json({ error: String(error) }, { status: 500 }); }
  },
};
