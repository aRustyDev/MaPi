// Distinct local destination-reservation identifier test; no real owner,
// registry, history integration, Woven, or external service is accessed.
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { reserveMoveDestination } from '../worker/owner-fence.js';

const route = { projectId:'p', origin:'https://p.invalid', objectName:'destination', generation:2 };
const move = 'synthetic-move';
function fixture(setup) {
  const db = new DatabaseSync(':memory:');
  if (setup) db.exec(setup);
  const storage = {
    sql: { exec(sql, ...args) {
      const stmt = db.prepare(sql);
      const result = stmt.columns().length ? stmt.all(...args) : (stmt.run(...args), []);
      return { toArray:() => result, one:() => { assert.equal(result.length,1); return result[0]; } };
    } },
    transactionSync(fn) {
      db.exec('BEGIN');
      try { const result=fn(); db.exec('COMMIT'); return result; }
      catch (error) { db.exec('ROLLBACK'); throw error; }
    },
  };
  return {db,storage};
}
for (const [description, setup] of [
  ['populated uppercase projects', "CREATE TABLE PROJECTS(id TEXT); INSERT INTO PROJECTS VALUES ('existing')"],
  ['populated mixed-case project metadata', "CREATE TABLE Mapi_Project(project_id TEXT); INSERT INTO Mapi_Project VALUES ('existing')"],
  ['populated mixed-case origin', "CREATE TABLE Mapi_Project_Origin(origin TEXT); INSERT INTO Mapi_Project_Origin VALUES ('existing')"],
  ['pending owner table', 'CREATE TABLE MAPI_PENDING_OWNER(id TEXT)'],
  ['existing owner fence table', 'CREATE TABLE MAPI_OWNER_FENCE(id TEXT)'],
  ['existing relocation state table', 'CREATE TABLE MAPI_RELOCATION_PROJECT(id TEXT)'],
  ['reserved project view', 'CREATE VIEW PROJECTS AS SELECT 1 AS id'],
  ['reserved project index', 'CREATE TABLE other(id TEXT); CREATE INDEX PROJECTS ON other(id)'],
  ['reserved origin view', 'CREATE VIEW MAPI_PROJECT_ORIGIN AS SELECT 1 AS origin'],
  ['reserved owner fence view', 'CREATE VIEW MAPI_OWNER_FENCE AS SELECT 1 AS singleton'],
  ['reserved pending owner index', 'CREATE TABLE other(id TEXT); CREATE INDEX MAPI_PENDING_OWNER ON other(id)'],
]) {
  const {db,storage}=fixture(setup);
  assert.throws(() => reserveMoveDestination(storage,route,move), /Destination is not fresh/, description);
  assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name='mapi_destination_reservation'").get().n,0,description);
  db.close();
}
for (const setup of ['', 'CREATE TABLE PROJECTS(id TEXT)', 'CREATE TABLE Mapi_Project(project_id TEXT)']) {
  const {db,storage}=fixture(setup);
  reserveMoveDestination(storage,route,move);
  reserveMoveDestination(storage,route,move);
  assert.equal(db.prepare('SELECT count(*) AS n FROM mapi_destination_reservation').get().n,1);
  db.close();
}
const reservationDDL = `CREATE TABLE MAPI_DESTINATION_RESERVATION (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1), project_id TEXT NOT NULL,
  origin TEXT NOT NULL, object_name TEXT NOT NULL, generation INTEGER NOT NULL,
  move_id TEXT NOT NULL
)`;
{
  const {db,storage}=fixture(reservationDDL);
  reserveMoveDestination(storage,route,move);
  // Existing matching reservations remain idempotent even after the target
  // has staged project data; subsequent import checks establish ownership.
  db.exec("CREATE TABLE PROJECTS(id TEXT); INSERT INTO PROJECTS VALUES ('staged')");
  reserveMoveDestination(storage,route,move);
  assert.equal(db.prepare('SELECT count(*) AS n FROM MAPI_DESTINATION_RESERVATION').get().n,1);
  db.close();
}
{
  const {db,storage}=fixture(`${reservationDDL}; CREATE TABLE business(v INTEGER); INSERT INTO business VALUES(0);
    CREATE TRIGGER reservation_side_effect AFTER INSERT ON MAPI_DESTINATION_RESERVATION BEGIN UPDATE business SET v=1; END`);
  assert.throws(() => reserveMoveDestination(storage,route,move), /Invalid destination reservation/);
  assert.equal(db.prepare('SELECT count(*) AS n FROM MAPI_DESTINATION_RESERVATION').get().n,0);
  assert.equal(db.prepare('SELECT v FROM business').get().v,0);
  db.close();
}
console.log('Destination SQLite identifier freshness checks passed');
