import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { exportFixture } from "./sqlite-schema-export.mjs";

// Native SQLite fixture only: no application server, generated files or
// deployed project. Sequence values are read as BigInts to avoid V8 rounding.
const read = (db, sql, ...args) => {
  const query = db.prepare(sql);
  query.setReadBigInts(true);
  return query.all(...args);
};
const sequence = db => read(db, "SELECT name, seq FROM sqlite_sequence ORDER BY name").map(({name, seq}) => [name, seq]);

const source = new DatabaseSync(":memory:"), restored = new DatabaseSync(":memory:");
try {
  source.exec(`
    CREATE TABLE high(id INTEGER PRIMARY KEY AUTOINCREMENT, value TEXT);
    CREATE TABLE empty_after_delete(id INTEGER PRIMARY KEY AUTOINCREMENT);
    CREATE TABLE missing(id INTEGER PRIMARY KEY AUTOINCREMENT);
    CREATE TABLE just_created(id INTEGER PRIMARY KEY AUTOINCREMENT);
    CREATE TABLE negative(id INTEGER PRIMARY KEY AUTOINCREMENT);
    CREATE TABLE "a'""quoted" (id INTEGER PRIMARY KEY AUTOINCREMENT);
    CREATE TABLE "AUTOINCREMENT" (v TEXT DEFAULT 'AUTOINCREMENT' /* AUTOINCREMENT */);
    INSERT INTO high VALUES (5, 'keep'), (9000, 'deleted');
    DELETE FROM high WHERE id=9000;
    INSERT INTO missing VALUES (40);
    DELETE FROM sqlite_sequence WHERE name='missing';
    INSERT INTO negative VALUES (1);
    DELETE FROM negative;
    UPDATE sqlite_sequence SET seq=-5 WHERE name='negative';
  `);
  const largeInsert = source.prepare("INSERT INTO empty_after_delete VALUES (?)");
  // `run()` returns the inserted row ID too; keep that result exact rather
  // than asking Node to represent it as an unsafe JavaScript number.
  largeInsert.setReadBigInts(true);
  largeInsert.run(9007199254740993n);
  source.exec("DELETE FROM empty_after_delete; INSERT INTO \"a'\"\"quoted\" VALUES (9); DELETE FROM \"a'\"\"quoted\"");
  const before = sequence(source);
  assert(before.some(([name, seq]) => name === "empty_after_delete" && seq === 9007199254740993n));
  assert(!before.some(([name]) => name === "missing" || name === "just_created"));
  const statements = exportFixture(source);
  for (const sql of statements) restored.exec(sql);
  assert.deepEqual(sequence(restored), before);
  for (const table of ["high", "empty_after_delete", "missing", "just_created", "negative", "a'\"quoted"]) {
    const quoted = '"' + table.replaceAll('"', '""') + '"';
    source.exec(`INSERT INTO ${quoted} DEFAULT VALUES`);
    restored.exec(`INSERT INTO ${quoted} DEFAULT VALUES`);
    assert.deepEqual(read(restored, `SELECT id FROM ${quoted} ORDER BY id`), read(source, `SELECT id FROM ${quoted} ORDER BY id`));
  }
  assert.equal(read(restored, "SELECT max(id) AS id FROM high")[0].id, 9001n);
  assert.equal(read(restored, "SELECT id FROM empty_after_delete")[0].id, 9007199254740994n);
  assert.equal(read(restored, "SELECT max(id) AS id FROM missing")[0].id, 41n);
  assert.equal(read(restored, "SELECT id FROM just_created")[0].id, 1n);
  assert.equal(read(restored, "SELECT id FROM negative")[0].id, 1n);
  assert.equal(read(restored, "SELECT id FROM \"a'\"\"quoted\"")[0].id, 10n);
} finally { source.close(); restored.close(); }

// SQLite permits direct edits to its sequence table. Duplicate/orphan rows or
// non-integer sequence values are not normalized silently by this exporter.
for (const mutate of [
  "INSERT INTO sqlite_sequence VALUES ('tracked', 8)",
  "INSERT INTO sqlite_sequence VALUES ('unknown', 8)",
  "INSERT INTO sqlite_sequence VALUES ('plain', 8)",
  "UPDATE sqlite_sequence SET seq='bad' WHERE name='tracked'",
  "UPDATE sqlite_sequence SET seq=2.5 WHERE name='tracked'",
  "UPDATE sqlite_sequence SET name=42 WHERE name='tracked'",
]) {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("CREATE TABLE tracked(id INTEGER PRIMARY KEY AUTOINCREMENT); CREATE TABLE plain(id INTEGER); INSERT INTO tracked DEFAULT VALUES");
    db.exec(mutate);
    assert.throws(() => exportFixture(db), /Invalid SQLite sequence state/);
  } finally { db.close(); }
}
console.log("Synthetic SQLite fixture sequence replay passed.");
