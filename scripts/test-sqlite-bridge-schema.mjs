import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { checkExpressions, columnCollations, conflictPolicies, foreignKeyDeclarations, snapshotSchema, snapshotSchemaObjects } from "./sqlite-bridge-schema.mjs";

const a = `CREATE TABLE a (v TEXT,
  CHECK (length(v) > 0 AND v <> 'check (x)  y'),
  CHECK (v <> 'it''s )' AND v <> 'x'))`;
const b = `CREATE TABLE a (v TEXT, CHECK(length(v)>0 AND v<>'check (x)  y'),
  /* CHECK (ignored) */ CHECK(v <> 'it''s )' AND v <> 'x'))`;
assert.deepEqual(checkExpressions(a), checkExpressions(b));
assert.notDeepEqual(checkExpressions(a), checkExpressions(b.replace("check (x)  y", "check (x) y")));
assert.notDeepEqual(checkExpressions(a), checkExpressions(b.replace("length(v)>0", "length(v)>=0")));
assert.deepEqual(checkExpressions('CREATE TABLE t ("CHECK" TEXT, v TEXT CHECK (v <> \'-- )\'))'), [["(", "v", "<", ">", "'-- )'", ")"]]);
assert.throws(() => checkExpressions("CREATE TABLE t (v CHECK ((v > 0)"), /Unterminated CHECK/);

function snapshot(sql) {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(sql);
    return snapshotSchema(statement => db.prepare(statement).all());
  } finally { db.close(); }
}
assert.deepEqual(snapshot(a), snapshot(b));
assert.notDeepEqual(snapshot(a), snapshot(b.replace("length(v)>0", "length(v)>=0")));
// SQLite allows identifiers that would otherwise resolve to Object prototype
// properties. Every table must remain an own, serialized snapshot entry.
const prototypeTables = snapshot('CREATE TABLE "__proto__" (x TEXT); CREATE TABLE "constructor" (y TEXT)');
assert.equal(Object.getPrototypeOf(prototypeTables), null);
assert.deepEqual(Object.keys(prototypeTables).sort(), ["__proto__", "constructor"]);
const serializedPrototypeTables = JSON.parse(JSON.stringify(prototypeTables));
assert.equal(Object.hasOwn(serializedPrototypeTables, "__proto__"), true);
assert.equal(Object.hasOwn(serializedPrototypeTables, "constructor"), true);
assert.notDeepEqual(serializedPrototypeTables, JSON.parse(JSON.stringify(snapshot('CREATE TABLE "constructor" (y TEXT)'))));
// SQLite reserves the literal `sqlite_` prefix, not `sqlite` followed by an
// arbitrary character. A LIKE pattern with an unescaped underscore omitted
// these legal user tables, views and triggers from the comparison.
{
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(`CREATE TABLE sqliteXrecord(id INTEGER);
      CREATE TABLE SQLITEXcapital(id INTEGER);
      CREATE TABLE ordinary(id INTEGER PRIMARY KEY AUTOINCREMENT);
      CREATE INDEX sqliteXidx ON sqliteXrecord(id);
      CREATE VIEW sqliteXview AS SELECT id FROM sqliteXrecord;
      CREATE TRIGGER sqliteXtrigger AFTER INSERT ON sqliteXrecord BEGIN UPDATE sqliteXrecord SET id=id; END`);
    const query = statement => db.prepare(statement).all();
    const tables = snapshotSchema(query);
    const objects = snapshotSchemaObjects(query);
    assert.deepEqual(Object.keys(tables).sort(), ["SQLITEXcapital", "ordinary", "sqliteXrecord"].sort());
    assert.equal(Object.hasOwn(tables, "sqlite_sequence"), false);
    assert(tables.sqliteXrecord.indexes.some(index => index[0] === "sqliteXidx"));
    assert.deepEqual(objects.map(([type, name]) => [type, name]), [["trigger", "sqliteXtrigger"], ["view", "sqliteXview"]]);
    db.exec("DROP INDEX sqliteXidx; DROP VIEW sqliteXview; DROP TRIGGER sqliteXtrigger");
    assert.notDeepEqual(tables, snapshotSchema(query));
    assert.notDeepEqual(objects, snapshotSchemaObjects(query));
  } finally { db.close(); }
}
// table_xinfo and index metadata can be identical for tables with different
// storage options. Compare the flags and demonstrate observable behavior.
const regularTable = "CREATE TABLE t(a TEXT NOT NULL PRIMARY KEY, b INTEGER)";
const withoutRowidTable = regularTable + " WITHOUT ROWID";
const strictTable = regularTable + " STRICT";
assert.deepEqual(snapshot(regularTable).t.tableOptions, [0, 0]);
assert.deepEqual(snapshot(withoutRowidTable).t.tableOptions, [1, 0]);
assert.deepEqual(snapshot(strictTable).t.tableOptions, [0, 1]);
assert.notDeepEqual(snapshot(regularTable), snapshot(withoutRowidTable));
assert.notDeepEqual(snapshot(regularTable), snapshot(strictTable));
for (const [ddl, strict, hasRowid] of [[regularTable, false, true], [withoutRowidTable, false, false], [strictTable, true, true]]) {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(ddl);
    if (strict) assert.throws(() => db.exec("INSERT INTO t VALUES ('a', 'not-an-integer')"), /cannot store TEXT value/);
    else db.exec("INSERT INTO t VALUES ('a', 'not-an-integer')");
    if (hasRowid) db.prepare("SELECT rowid FROM t").all();
    else assert.throws(() => db.prepare("SELECT rowid FROM t").all(), /no such column/);
  } finally { db.close(); }
}
{
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(regularTable);
    const actual = statement => db.prepare(statement).all();
    for (const alter of [
      rows => rows.filter(row => row.name !== "t"),
      rows => rows.map(row => row.name === "t" ? {...row, strict: undefined} : row),
      rows => rows.map(row => row.name === "t" ? {...row, wr: 2} : row),
      rows => rows.map(row => row.name === "t" ? {...row, ncol: row.ncol + 1} : row),
      rows => [...rows, rows.find(row => row.name === "t")],
    ]) {
      assert.throws(() => snapshotSchema(statement => statement === "PRAGMA table_list" ? alter(actual(statement)) : actual(statement)), /SQLite .*metadata/);
    }
  } finally { db.close(); }
}
// foreign_key_list is identical for these schemas, but only a deferred FK
// allows a temporarily missing parent to be inserted later in the transaction.
const immediateFK = "CREATE TABLE p(id INTEGER PRIMARY KEY); CREATE TABLE c(pid INTEGER REFERENCES p(id))";
const deferredFK = immediateFK.replace("REFERENCES p(id)", "REFERENCES p(id) DEFERRABLE INITIALLY DEFERRED");
assert.deepEqual(snapshot(immediateFK).c.foreignKeys, snapshot(deferredFK).c.foreignKeys);
assert.notDeepEqual(snapshot(immediateFK), snapshot(deferredFK));
assert.deepEqual(snapshot(deferredFK), snapshot(deferredFK.replace("DEFERRABLE INITIALLY", "DEFERRABLE /* comment */ INITIALLY")));
const explicitImmediateFK = immediateFK.replace("REFERENCES p(id)", "REFERENCES p(id) DEFERRABLE INITIALLY IMMEDIATE");
assert.deepEqual(snapshot(immediateFK).c.foreignKeys, snapshot(explicitImmediateFK).c.foreignKeys);
assert.notDeepEqual(snapshot(immediateFK), snapshot(explicitImmediateFK));
const compositeFK = "CREATE TABLE p(a INTEGER, b INTEGER, PRIMARY KEY(a,b)); CREATE TABLE c(a INTEGER, b INTEGER, FOREIGN KEY(a,b) REFERENCES p(a,b) DEFERRABLE INITIALLY DEFERRED)";
assert.notDeepEqual(snapshot(compositeFK), snapshot(compositeFK.replace("INITIALLY DEFERRED", "INITIALLY IMMEDIATE")));
const quotedFK = 'CREATE TABLE "p,()" ("id)" INTEGER PRIMARY KEY); CREATE TABLE "c(x" ("value," INTEGER, CONSTRAINT "REFERENCES" FOREIGN KEY("value,") REFERENCES "p,()"("id)") DEFERRABLE INITIALLY DEFERRED)';
assert.notDeepEqual(snapshot(quotedFK), snapshot(quotedFK.replace("INITIALLY DEFERRED", "INITIALLY IMMEDIATE")));
assert.deepEqual(snapshot(quotedFK), snapshot(quotedFK.replace('REFERENCES "p,()"', 'REFERENCES /* comma, closing ) */ "p,()"')));
const twoInlineFKs = "CREATE TABLE p(id INTEGER PRIMARY KEY); CREATE TABLE q(id INTEGER PRIMARY KEY); CREATE TABLE c(x INTEGER REFERENCES p(id) REFERENCES q(id) DEFERRABLE INITIALLY DEFERRED)";
assert.equal(snapshot(twoInlineFKs).c.foreignKeys.length, 2);
assert.equal(snapshot(twoInlineFKs).c.foreignKeyDeclarations.length, 2);
assert.notDeepEqual(snapshot(twoInlineFKs), snapshot(twoInlineFKs.replace("INITIALLY DEFERRED", "INITIALLY IMMEDIATE")));
const missingFKMetadata = new DatabaseSync(":memory:");
try {
  missingFKMetadata.exec(immediateFK);
  assert.throws(() => snapshotSchema((sql) => sql.startsWith("PRAGMA foreign_key_list") ? [] : missingFKMetadata.prepare(sql).all()), /Foreign-key declarations do not match metadata/);
} finally { missingFKMetadata.close(); }
assert.deepEqual(foreignKeyDeclarations("CREATE TABLE t(v TEXT DEFAULT 'REFERENCES x(y)' CHECK (v <> 'REFERENCES p(id)'))"), []);
assert.throws(() => foreignKeyDeclarations("CREATE TABLE t (v TEXT REFERENCES p(id)"), /Unterminated foreign-key/);
for (const [ddl, deferred] of [[immediateFK, false], [explicitImmediateFK, false], [deferredFK, true]]) {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("PRAGMA foreign_keys=ON");
    db.exec(ddl);
    db.exec("BEGIN");
    if (deferred) {
      db.exec("INSERT INTO c VALUES (1); INSERT INTO p VALUES (1); COMMIT");
      assert.equal(db.prepare("SELECT count(*) AS n FROM c").get().n, 1);
    } else {
      assert.throws(() => db.exec("INSERT INTO c VALUES (1)"), /FOREIGN KEY constraint failed/);
      db.exec("ROLLBACK");
      assert.equal(db.prepare("SELECT count(*) AS n FROM c").get().n, 0);
    }
  } finally { db.close(); }
}
const partialIndex = "CREATE TABLE t (v TEXT); CREATE INDEX ix ON t (v) WHERE v <> 'a  b'";
assert.deepEqual(snapshot(partialIndex), snapshot("CREATE TABLE t(v TEXT); CREATE INDEX ix ON t(v) WHERE v<>'a  b'"));
assert.notDeepEqual(snapshot(partialIndex), snapshot(partialIndex.replace("a  b", "a b")));
const expressionIndex = "CREATE TABLE t (v TEXT); CREATE INDEX ix ON t (v || 'a  b')";
assert.notDeepEqual(snapshot(expressionIndex), snapshot(expressionIndex.replace("a  b", "a b")));
// table_xinfo reports the generated column kind but not the expression.
const generated = 'CREATE TABLE t (v TEXT, "g,)""AS" TEXT GENERATED ALWAYS AS (lower(v) || \',  \') STORED, n INTEGER AS (length(v) + 1) VIRTUAL)';
assert.deepEqual(snapshot(generated), snapshot(generated.replace("length(v) + 1", "length( v )+1")));
assert.notDeepEqual(snapshot(generated), snapshot(generated.replace("length(v) + 1", "length(v) + 2")));
assert.notDeepEqual(snapshot(generated), snapshot(generated.replace(",  '", ", '")));
// The pinned projects.name column has no index, so index_xinfo alone cannot
// distinguish the original BINARY comparison from an accidental NOCASE.
// Reproduce the generated definition without requiring generated build files.
const projects = `CREATE TABLE projects (
    id              TEXT    NOT NULL,
    name            TEXT    NOT NULL,
    created_at      INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL,
    password_hash_policy TEXT,
    PRIMARY KEY (id)
)`;
const projectsNocase = projects.replace("name            TEXT    NOT NULL", "name            TEXT COLLATE NOCASE NOT NULL");
assert.notEqual(projectsNocase, projects);
assert.notDeepEqual(snapshot(projects), snapshot(projectsNocase));
for (const [ddl, expected] of [[projects, 1], [projectsNocase, 2]]) {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(ddl);
    db.exec("INSERT INTO projects (id, name, created_at, updated_at) VALUES ('1', 'a', 0, 0), ('2', 'A', 0, 0)");
    assert.equal(db.prepare("SELECT count(*) AS n FROM projects WHERE name = 'a'").get().n, expected);
  } finally { db.close(); }
}
const columnCollation = `CREATE TABLE t ("a,)""b" TEXT /* comment */ COLLATE "NOCASE",
  π x TEXT DEFAULT 'COLLATE BINARY' CHECK (π x COLLATE NOCASE <> 'x'),
  g TEXT AS (lower(π x) COLLATE NOCASE), CHECK (π x <> 'COLLATE BINARY'))`;
assert.deepEqual(columnCollations(columnCollation, [['a,)"b', 'TEXT', 0, null, 0, 0], ['π x', 'TEXT', 0, null, 0, 0], ['g', 'TEXT', 0, null, 0, 2]]),
  [['a,)"b', ['"NOCASE"']]]);
assert.deepEqual(columnCollations('CREATE TABLE t (`v``x` TEXT CONSTRAINT "COLLATE" CHECK (`v``x` COLLATE NOCASE <> \'COLLATE\'))',
  [['v`x', 'TEXT', 0, null, 0, 0]]), []);
assert.deepEqual(snapshot(columnCollation), snapshot(columnCollation.replace("/* comment */", "-- comment\n")));
assert.notDeepEqual(snapshot(columnCollation), snapshot(columnCollation.replace('COLLATE "NOCASE"', 'COLLATE "BINARY"')));
assert.notDeepEqual(snapshot(columnCollation), snapshot(columnCollation.replace('COLLATE "NOCASE"', '')));
assert.deepEqual(snapshot("CREATE TABLE t(v TEXT CONSTRAINT x COLLATE NOCASE NOT NULL)"),
  snapshot("CREATE TABLE t(v TEXT CONSTRAINT x /* skip */ COLLATE NOCASE NOT NULL)"));
// Neither table_xinfo nor index_list describes a constraint's conflict mode.
const conflict = "CREATE TABLE t (v TEXT NOT NULL ON CONFLICT IGNORE DEFAULT 'fallback')";
const conflictReplace = conflict.replace("CONFLICT IGNORE", "CONFLICT REPLACE");
assert.notDeepEqual(snapshot(conflict), snapshot(conflictReplace));
assert.notDeepEqual(snapshot(conflict), snapshot(conflict.replace(" ON CONFLICT IGNORE", "")));
assert.deepEqual(snapshot(conflict), snapshot(conflict.replace("ON CONFLICT", "ON /* comment */ CONFLICT")));
for (const [ddl, expected] of [[conflict, []], [conflictReplace, ['fallback']]]) {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(ddl);
    db.exec("INSERT INTO t (v) VALUES (NULL)");
    assert.deepEqual(db.prepare("SELECT v FROM t").all().map(({ v }) => v), expected);
  } finally { db.close(); }
}
const swappedPolicies = "CREATE TABLE t (a TEXT NOT NULL ON CONFLICT IGNORE, b TEXT NOT NULL ON CONFLICT FAIL)";
assert.notDeepEqual(snapshot(swappedPolicies), snapshot(swappedPolicies.replace("IGNORE", "TEMP").replace("FAIL", "IGNORE").replace("TEMP", "FAIL")));
assert.notDeepEqual(snapshot("CREATE TABLE t(a INTEGER, b INTEGER, UNIQUE(a, b) ON CONFLICT IGNORE)"),
  snapshot("CREATE TABLE t(a INTEGER, b INTEGER, UNIQUE(a, b) ON CONFLICT FAIL)"));
// SQLite checks unique constraints in an order affected by their declaration.
// A multi-conflict insert can fail or be ignored solely due to that order,
// including when one of the constraints uses the implicit ABORT policy.
for (const secondConstraint of ["UNIQUE(b) ON CONFLICT FAIL", "UNIQUE(b)"]) {
  const ignoreFirst = `CREATE TABLE t(a INT, b INT, UNIQUE(a) ON CONFLICT IGNORE, ${secondConstraint})`;
  const ignoreLast = `CREATE TABLE t(a INT, b INT, ${secondConstraint}, UNIQUE(a) ON CONFLICT IGNORE)`;
  assert.notDeepEqual(snapshot(ignoreFirst), snapshot(ignoreLast));
  for (const [ddl, fails] of [[ignoreFirst, true], [ignoreLast, false]]) {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec(ddl);
      db.exec("INSERT INTO t VALUES (1,1), (2,2)");
      if (fails) assert.throws(() => db.exec("INSERT INTO t VALUES (1,2)"), /UNIQUE constraint failed/);
      else db.exec("INSERT INTO t VALUES (1,2)");
      assert.equal(db.prepare("SELECT count(*) AS n FROM t").get().n, 2);
    } finally { db.close(); }
  }
}
const implicitAB = "CREATE TABLE t(a INT, b INT, UNIQUE(a), UNIQUE(b))";
const implicitBA = "CREATE TABLE t(a INT, b INT, UNIQUE(b), UNIQUE(a))";
assert.notDeepEqual(snapshot(implicitAB), snapshot(implicitBA));
for (const [ddl, column] of [[implicitAB, "b"], [implicitBA, "a"]]) {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(ddl);
    db.exec("INSERT INTO t VALUES (1,1), (2,2)");
    assert.throws(() => db.exec("INSERT INTO t VALUES (1,2)"), new RegExp(`UNIQUE constraint failed: t\\.${column}`));
  } finally { db.close(); }
}
assert.deepEqual(conflictPolicies("CREATE TABLE t (v TEXT DEFAULT 'ON CONFLICT IGNORE' CHECK(v <> 'ON CONFLICT FAIL'))"), []);
assert.deepEqual(conflictPolicies('CREATE TABLE t ("ON" TEXT, "CONFLICT" TEXT, `ON CONFLICT` TEXT, v TEXT CHECK (v <> \'ON CONFLICT REPLACE\'))'), []);
assert.deepEqual(conflictPolicies("CREATE TABLE t (v TEXT -- ON CONFLICT FAIL\n)"), []);
assert.throws(() => conflictPolicies("CREATE TABLE t (v TEXT NOT NULL ON CONFLICT IGNORE"), /Unterminated/);
const multipleGenerated = "CREATE TABLE t(v TEXT, a TEXT AS (coalesce(substr(v, 1, length(v)), '?')), b TEXT AS (upper(v)))";
assert.notDeepEqual(snapshot(multipleGenerated), snapshot(multipleGenerated.replace("a TEXT AS (coalesce(substr(v, 1, length(v)), '?')), b TEXT AS (upper(v))", "a TEXT AS (upper(v)), b TEXT AS (coalesce(substr(v, 1, length(v)), '?'))")));
assert.deepEqual(snapshot(multipleGenerated), snapshot("CREATE TABLE t(v TEXT, b TEXT AS (upper(v)), a TEXT AS (coalesce(substr(v,1,length(v)),'?')))"));
const generatedDb = new DatabaseSync(":memory:");
try {
  generatedDb.exec(generated);
  generatedDb.exec("INSERT INTO t (v) VALUES ('AB')");
  assert.deepEqual({ ...generatedDb.prepare('SELECT "g,)""AS" AS g, n FROM t').get() }, { g: 'ab,  ', n: 3 });
} finally { generatedDb.close(); }
// SQLite permits non-ASCII bytes within unquoted identifiers; JavaScript's
// broad \s character class would erase the no-break spaces in this identifier.
const unicodeIndex = 'CREATE TABLE t (a INTEGER, b INTEGER, "a\u00a0AND\u00a0b" INTEGER); CREATE INDEX ix ON t (a) WHERE a\u00a0AND\u00a0b';
assert.notDeepEqual(snapshot(unicodeIndex), snapshot(unicodeIndex.replace('WHERE a\u00a0AND\u00a0b', 'WHERE a AND b')));
const unicodeCheck = 'CREATE TABLE t (a INTEGER, b INTEGER, "a\u00a0AND\u00a0b" INTEGER, CHECK(a\u00a0AND\u00a0b))';
assert.notDeepEqual(snapshot(unicodeCheck), snapshot(unicodeCheck.replace('CHECK(a\u00a0AND\u00a0b)', 'CHECK(a AND b)')));
// A carriage return does not terminate a SQLite line comment.
const commentIndex = 'CREATE TABLE t (a INTEGER); CREATE INDEX ix ON t(a) WHERE a --\r 2\n';
assert.notDeepEqual(snapshot(commentIndex), snapshot(commentIndex.replace('--\r', '- -\r')));
const objectDb = new DatabaseSync(":memory:");
try {
  objectDb.exec("CREATE TABLE t (v INTEGER); CREATE VIEW visible AS SELECT v FROM t; CREATE TRIGGER t_insert AFTER INSERT ON t BEGIN UPDATE t SET v = v + 1; END; CREATE TABLE mapi_test_internal (v INTEGER); CREATE TRIGGER mapi_test_internal_trigger AFTER INSERT ON mapi_test_internal BEGIN SELECT 1; END");
  const objects = () => snapshotSchemaObjects(statement => objectDb.prepare(statement).all());
  const initial = objects();
  assert.deepEqual(initial.map(([type, name, table]) => [type, name, table]), [["trigger", "t_insert", "t"], ["view", "visible", "visible"]]);
  objectDb.exec("DROP VIEW visible; CREATE VIEW visible AS SELECT v + 1 AS v FROM t");
  assert.notDeepEqual(objects(), initial);
  objectDb.exec("DROP TRIGGER t_insert");
  assert.equal(objects().length, 1);
} finally { objectDb.close(); }
console.log("SQLite migration schema snapshot tests passed");
