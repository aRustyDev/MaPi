// SQLite reserves the literal, case-insensitive `sqlite_` prefix. LIKE's
// unescaped underscore matches any character and would omit legal user names.
export function listExportableSchema(db) {
  return db.prepare("SELECT name, type, sql FROM sqlite_schema WHERE sql IS NOT NULL AND lower(substr(name, 1, 7)) <> 'sqlite_' ORDER BY rowid").all();
}

function identifier(name) {
  return '"' + name.replaceAll('"', '""') + '"';
}

function literal(value) {
  if (value === null) return "NULL";
  if (typeof value === "bigint" || typeof value === "number") return String(value);
  if (value instanceof Uint8Array) return "X'" + Buffer.from(value).toString("hex") + "'";
  if (value.includes("\0")) return "CAST(X'" + Buffer.from(value).toString("hex") + "' AS TEXT)";
  return "'" + value.replaceAll("'", "''") + "'";
}

// AUTOINCREMENT is a SQLite keyword in a CREATE TABLE statement. Ignore
// quoted tokens and comments so a table, column or default string containing
// the word cannot cause us to manipulate its unrelated sequence state.
function hasAutoincrement(sql) {
  const tokens = /'(?:''|[^'])*(?:'|$)|"(?:""|[^"])*(?:"|$)|`(?:``|[^`])*(?:`|$)|\[[^\]]*(?:\]|$)|--[^\n]*|\/\*[\s\S]*?(?:\*\/|$)|[A-Za-z_\u0080-\u{10ffff}][A-Za-z_0-9$\u0080-\u{10ffff}]*/gu;
  for (const match of sql.matchAll(tokens)) {
    if (match[0].replace(/[a-z]/g, character => character.toUpperCase()) === "AUTOINCREMENT") return true;
  }
  return false;
}

function readSequences(db, tables) {
  const autoincrement = tables.filter(({sql}) => hasAutoincrement(sql)).map(({name}) => name);
  const allowed = new Set(autoincrement);
  const sequenceTable = db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='sqlite_sequence'").get();
  if (!sequenceTable) {
    if (autoincrement.length) throw new Error("SQLite sequence table missing");
    return { autoincrement, entries: [] };
  }
  const query = db.prepare("SELECT name, seq, typeof(name) AS name_type, typeof(seq) AS seq_type FROM sqlite_sequence ORDER BY rowid");
  query.setReadBigInts(true);
  const entries = [], seen = new Set();
  for (const row of query.iterate()) {
    if (row.name_type !== "text" || typeof row.name !== "string" || !row.name.isWellFormed() || !allowed.has(row.name) || seen.has(row.name) ||
        row.seq_type !== "integer" || typeof row.seq !== "bigint" || row.seq < -9223372036854775808n || row.seq > 9223372036854775807n) {
      throw new Error("Invalid SQLite sequence state");
    }
    seen.add(row.name);
    entries.push([row.name, row.seq]);
  }
  return { autoincrement, entries };
}

// Retain the fixture export's original ordering and literal representation:
// create tables, insert data, then create indexes, triggers and views.
export function exportFixture(db) {
  const schema = listExportableSchema(db);
  const tables = schema.filter(({ type }) => type === "table");
  const sequences = readSequences(db, tables);
  const statements = tables.map(({ sql }) => sql);
  for (const { name } of tables) {
    const table = identifier(name);
    const columns = db.prepare("PRAGMA table_xinfo(" + table + ")").all()
      .filter(({ hidden }) => hidden === 0).map(({ name }) => identifier(name)).join(", ");
    const values = db.prepare("SELECT " + columns + " FROM " + table);
    values.setReadBigInts(true);
    for (const row of values.iterate()) {
      statements.push("INSERT INTO " + table + " (" + columns + ") VALUES (" + Object.values(row).map(literal).join(", ") + ")");
    }
  }
  // Explicit row inserts create/advance destination sequence records. Restore
  // each source record, including a deliberately absent record, only for an
  // exported AUTOINCREMENT table; do not delete unrelated destination state.
  for (const name of sequences.autoincrement) statements.push("DELETE FROM sqlite_sequence WHERE name = " + literal(name));
  for (const [name, seq] of sequences.entries) statements.push("INSERT INTO sqlite_sequence (name, seq) VALUES (" + literal(name) + ", " + literal(seq) + ")");
  return statements.concat(schema.filter(({ type }) => type !== "table").map(({ sql }) => sql));
}
