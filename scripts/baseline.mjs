import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { listExportableSchema } from "./sqlite-schema-export.mjs";

const source = resolve(".mapi/nextgen/apps/api");
const dir = await mkdtemp(resolve(tmpdir(), "mapi-baseline-"));
const path = resolve(dir, "baseline.sqlite");
const quoteName = (name) => '"' + name.replaceAll('"', '""') + '"';
function literal(value) {
  if (value === null) return "NULL";
  if (typeof value === "bigint" || typeof value === "number") return String(value);
  if (value instanceof Uint8Array) return "X'" + Buffer.from(value).toString("hex") + "'";
  return "CAST(X'" + Buffer.from(value).toString("hex") + "' AS TEXT)";
}

try {
  execFileSync("go", ["run", "./cmd/mapi-baseline", path], {
    cwd: source, stdio: "inherit", env: { ...process.env, GOWORK: "off", GOTOOLCHAIN: "go1.26.9" },
  });
  const db = new DatabaseSync(path);
  try {
    const schema = listExportableSchema(db);
    const tables = schema.filter(({ type }) => type === "table");
    if (!tables.some(({ name }) => name === "authz_catalogs")) {
      throw new Error("Upstream authorization catalog is missing");
    }
    if (db.prepare("SELECT COUNT(*) AS n FROM authz_catalogs").get().n === 0) {
      throw new Error("Upstream authorization catalog is empty");
    }
    const statements = tables.map(({ sql }) => sql);
    const shared = new Set(['authz_bundle_members', 'authz_bundles', 'authz_catalogs', 'authz_expression_edges', 'authz_relation_closure', 'authz_relation_references', 'authz_relations', 'goose_db_version']);
    const referenceRows = {};
    for (const { name } of tables) {
      const table = quoteName(name);
      const columns = db.prepare("PRAGMA table_xinfo(" + table + ")").all()
        .filter(({ hidden }) => hidden === 0).map(({ name }) => quoteName(name)).join(", ");
      const values = db.prepare("SELECT " + columns + " FROM " + table);
      values.setReadBigInts(true);
      const rows = values.all();
      if (shared.has(name)) {
        const names = db.prepare('PRAGMA table_xinfo(' + table + ')').all().filter(({ hidden }) => hidden === 0).map(({ name }) => name);
        const encode = value => typeof value === 'bigint' ? { integer: String(value) } : value instanceof Uint8Array ? { blob: Buffer.from(value).toString('base64') } : value;
        referenceRows[name] = { columns: names, rows: rows.map(row => names.map(key => encode(row[key]))).sort((a, b) => { const left = JSON.stringify(a), right = JSON.stringify(b); return left < right ? -1 : left > right ? 1 : 0; }) };
      }
      if (["projects", "users", "user_passwords", "sessions"].includes(name) && rows.length !== 0) {
        throw new Error("Baseline contains unexpected records in " + name);
      }
      for (const row of rows) {
        statements.push("INSERT INTO " + table + " (" + columns + ") VALUES (" + Object.values(row).map(literal).join(", ") + ")");
      }
    }
    statements.push(...schema.filter(({ type }) => type !== "table").map(({ sql }) => sql));
    const check = new DatabaseSync(":memory:");
    try {
      check.exec("PRAGMA foreign_keys = OFF");
      for (const statement of statements) check.exec(statement);
      for (const { name } of tables) {
        const table = quoteName(name);
        const columns = db.prepare("PRAGMA table_xinfo(" + table + ")").all()
          .filter(({ hidden }) => hidden === 0).map(({ name }) => quoteName(name)).join(", ");
        function rows(connection) {
          const query = connection.prepare("SELECT " + columns + " FROM " + table);
          query.setReadBigInts(true);
          return query.all().map((row) => Object.values(row).map(literal).join(",")).sort();
        }
        if (JSON.stringify(rows(db)) !== JSON.stringify(rows(check))) throw new Error("Baseline rows differ for " + name);
      }
      const byName = (a, b) => a.name.localeCompare(b.name);
      const restoredSchema = listExportableSchema(check);
      if (JSON.stringify([...schema].sort(byName)) !== JSON.stringify(restoredSchema.sort(byName))) {
        throw new Error("Baseline schema differs from upstream migrations");
      }
      if (check.prepare("PRAGMA foreign_key_check").all().length) throw new Error("Baseline foreign key check failed");
    } finally { check.close(); }
    await mkdir("worker/generated", { recursive: true });
    await writeFile("worker/generated/baseline.json", JSON.stringify({ version: 1, statements, referenceRows }));
    console.log("Migrated empty SQLite baseline generated and verified.");
  } finally { db.close(); }
} finally { await rm(dir, { recursive: true, force: true }); }
