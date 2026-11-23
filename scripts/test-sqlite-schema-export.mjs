import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { exportFixture, listExportableSchema } from "./sqlite-schema-export.mjs";

// Synthetic, in-memory databases only. Exercise the same functions used by
// both generators without starting a server or writing generated artifacts.
const source = new DatabaseSync(":memory:");
const restored = new DatabaseSync(":memory:");
try {
  source.exec(`
    CREATE TABLE sqliteXrecord(id INTEGER PRIMARY KEY, text_value TEXT, bytes BLOB, exact INTEGER);
    CREATE TABLE SQLITEXcapital(id INTEGER);
    CREATE TABLE ordinary(id INTEGER PRIMARY KEY AUTOINCREMENT, value TEXT);
    CREATE TABLE "__proto__" (value TEXT);
  `);
  source.prepare("INSERT INTO sqliteXrecord VALUES (?, ?, ?, ?)").run(3n, "nul\0quote' and 🌍", new Uint8Array([0, 255, 9]), 9223372036854775807n);
  source.exec(`
    INSERT INTO ordinary(value) VALUES ('autoincrement');
    INSERT INTO "__proto__" VALUES ('prototype table');
    CREATE INDEX sqliteXindex ON sqliteXrecord(text_value);
    CREATE VIEW sqliteXview AS SELECT id, text_value FROM sqliteXrecord;
    CREATE TRIGGER sqliteXtrigger AFTER INSERT ON sqliteXrecord BEGIN UPDATE sqliteXrecord SET exact=exact+1 WHERE id=NEW.id; END;
  `);
  const schema = listExportableSchema(source);
  assert.deepEqual(schema.map(({name}) => name), ["sqliteXrecord", "SQLITEXcapital", "ordinary", "__proto__", "sqliteXindex", "sqliteXview", "sqliteXtrigger"]);
  assert(source.prepare("SELECT name FROM sqlite_schema WHERE name='sqlite_sequence'").get());
  assert(!schema.some(({name}) => name === "sqlite_sequence"));

  const statements = exportFixture(source);
  restored.exec("PRAGMA foreign_keys = OFF");
  for (const statement of statements) restored.exec(statement);
  const sortedSchema = db => listExportableSchema(db).map(({name, type, sql}) => [name, type, sql]).sort((a, b) => a[0].localeCompare(b[0]));
  assert.deepEqual(sortedSchema(restored), sortedSchema(source));
  for (const table of ["sqliteXrecord", "SQLITEXcapital", "ordinary", "__proto__"]) {
    const quoted = '"' + table.replaceAll('"', '""') + '"';
    const read = db => { const query = db.prepare(`SELECT * FROM ${quoted}`); query.setReadBigInts(true); return query.all(); };
    assert.deepEqual(read(restored), read(source));
  }
  assert.deepEqual(restored.prepare("SELECT id, text_value FROM sqliteXview").all(), source.prepare("SELECT id, text_value FROM sqliteXview").all());
  assert(restored.prepare("SELECT name FROM sqlite_schema WHERE name='sqlite_sequence'").get());
  for (const db of [source, restored]) {
    db.exec("INSERT INTO sqliteXrecord(id, exact) VALUES (4, 5)");
    assert.equal(db.prepare("SELECT exact FROM sqliteXrecord WHERE id=4").get().exact, 6);
  }
  console.log("Synthetic SQLite schema export and replay passed.");
} finally { source.close(); restored.close(); }
