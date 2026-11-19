import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { startLocalZitadel, bootstrapProject } from "@zitadel/testing";
import { runParity } from "./parity.mjs";

const dir = resolve(".mapi", "fixtures", Date.now().toString());
const output = resolve(".mapi", "fixture.json");
const generated = resolve("worker", "generated");

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

function exportFixture(db) {
  const schema = db.prepare("SELECT name, type, sql FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY rowid").all();
  const tables = schema.filter(({ type }) => type === "table");
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
  return statements.concat(schema.filter(({ type }) => type !== "table").map(({ sql }) => sql));
}

await mkdir(dir, { recursive: true, mode: 0o700 });
await mkdir(generated, { recursive: true });
const server = await startLocalZitadel({ dir, projectName: "MaPi synthetic fixture" });
try {
  const user = await server.seedUser();
  const other = await bootstrapProject({ baseUrl: server.handle.baseUrl, projectName: "MaPi scope test" });
  const fixture = { ...server.handle, user, otherProjectId: other.projectId, otherProjectSecret: other.projectSecret };
  const dataDir = resolve(dir, ".zitadel", "local", "nextgen-data");
  const dbPath = resolve(dataDir, "zitadel.db");
  const db = new DatabaseSync(dbPath);
  let statements;
  try { statements = exportFixture(db); }
  finally { db.close(); }
  const keysDir = resolve(dataDir, "master-keys");
  const files = await readdir(keysDir);
  if (files.length !== 1) throw new Error("Expected exactly one generated master key");
  const key = { id: files[0], pem: await readFile(resolve(keysDir, files[0]), "utf8") };
  await writeFile(resolve(generated, "fixture.json"),
    JSON.stringify({ projectId: fixture.projectId, statements }), { mode: 0o600 });
  await writeFile(output, JSON.stringify(fixture), { mode: 0o600 });
  const masterKey = JSON.stringify(key);
  await writeFile(resolve(".mapi", "runtime-key.json"), masterKey, { mode: 0o600 });
  await writeFile(resolve(".dev.vars.poc"), "MAPI_MASTER_KEY=" + Buffer.from(masterKey).toString("base64") + "\nMAPI_LOCAL_TEST=1\n", { mode: 0o600 });

  if (process.argv.includes("--test")) {
    const db = new DatabaseSync(dbPath);
    try {
      const result = await runParity(server.handle.baseUrl, fixture, {
        expireHandoff: () => db.exec("UPDATE auth_attempts SET handed_off_at = 1 WHERE handed_off_at IS NOT NULL"),
        expireSession: (id) => db.prepare("UPDATE sessions SET updated_at = 1 WHERE id = ?").run(id),
      });
      const events = db.prepare("SELECT event_type, COUNT(*) AS count FROM events WHERE project_id = ? GROUP BY event_type ORDER BY event_type").all(fixture.projectId);
      const baseline = { wire: result.wire, signInMs: result.signInMs, events };
      await writeFile(resolve(".mapi", "baseline.json"), JSON.stringify(baseline, null, 2));
      console.log(JSON.stringify(baseline, null, 2));
    } finally { db.close(); }
  } else console.log("Synthetic fixture exported.");
} finally { await server.stop(); }
