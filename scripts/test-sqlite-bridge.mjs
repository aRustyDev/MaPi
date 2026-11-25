import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { access, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout } from "node:timers/promises";
import { snapshotSchema, snapshotSchemaObjects } from "./sqlite-bridge-schema.mjs";

const upstream = resolve(".mapi/nextgen/apps/api");
const target = resolve(upstream, "cmd/mapi-bridge-test");
await mkdir(target, { recursive: true });
await mkdir("worker/generated", { recursive: true });
const upstreamRoot = resolve(".mapi/nextgen");
const upstreamCommit = "b0b74cd4a198428ea9b82910c217259ffc62b65c";
const migrationDir = "apps/api/internal/storage/dialect/sqlite/migration/sql";
const migrations = [];
const migrationPaths = execFileSync("git", ["-C", upstreamRoot, "ls-tree", "-r", "--name-only", upstreamCommit, "--", migrationDir], { encoding: "utf8" })
  .trim().split("\n").filter((path) => /^\d+_.+\.sql$/.test(path.split("/").at(-1))).sort();
for (const path of migrationPaths) {
  const filename = path.split("/").at(-1);
  const source = execFileSync("git", ["-C", upstreamRoot, "show", `${upstreamCommit}:${path}`], { encoding: "utf8" });
  const sections = source.split(/^-- \+goose (Up|Down)\s*$/m);
  if (sections.length !== 5 || sections[1] !== "Up" || sections[3] !== "Down") {
    throw new Error(`Unexpected migration sections in ${filename}`);
  }
  function statements(section) {
    const items = [...section.matchAll(/^-- \+goose StatementBegin\s*$([\s\S]*?)^-- \+goose StatementEnd\s*$/gm)];
    const residue = section.replace(/^-- \+goose StatementBegin\s*$[\s\S]*?^-- \+goose StatementEnd\s*$/gm, "");
    if (residue.split("\n").some((line) => line.trim() && !line.trim().startsWith("--"))) {
      throw new Error(`Unparsed migration content in ${filename}`);
    }
    return items.map((item) => item[1].trim());
  }
  migrations.push({ version: Number(filename.slice(0, 6)), name: filename, up: statements(sections[2]), down: statements(sections[4]) });
}
await writeFile("worker/generated/sqlite-bridge-migrations.json", JSON.stringify(migrations));
try {
  await access("worker/generated/baseline.json");
} catch {
  execFileSync(process.execPath, ["scripts/baseline.mjs"], { stdio: "inherit" });
}
const nativeBaseline = JSON.parse(await readFile("worker/generated/baseline.json", "utf8"));
const nativeDb = new DatabaseSync(":memory:");
nativeDb.exec("PRAGMA foreign_keys = OFF");
for (const statement of nativeBaseline.statements) nativeDb.exec(statement);
const nativeSchema = snapshotSchema((statement) => nativeDb.prepare(statement).all());
const nativeObjects = snapshotSchemaObjects((statement) => nativeDb.prepare(statement).all());
nativeDb.close();
await copyFile("upstream/overlay/apps/api/cmd/mapi-bridge-test/main_wasip1.go", resolve(target, "main_wasip1.go"));
execFileSync("go", ["build", "-trimpath", "-ldflags=-s -w", "-buildmode=c-shared", "-o", resolve("worker/generated/sqlite-bridge-test.wasm"), "./cmd/mapi-bridge-test"], {
  cwd: upstream, stdio: "inherit",
  env: { ...process.env, GOWORK: "off", GOOS: "wasip1", GOARCH: "wasm", CGO_ENABLED: "0", GOTOOLCHAIN: "go1.26.9" },
});

async function freePort() {
  const socket = createServer().listen(0, "127.0.0.1");
  await once(socket, "listening");
  const { port } = socket.address();
  await new Promise((done, reject) => socket.close((error) => error ? reject(error) : done()));
  return port;
}

const directory = await mkdtemp(resolve(tmpdir(), "mapi-sqlite-bridge-"));
const environment = resolve(directory, "empty.env");
await writeFile(environment, "");
const port = await freePort();
const inspectorPort = await freePort();
const server = spawn(process.execPath, [resolve("node_modules/wrangler/bin/wrangler.js"), "dev", "--local", "--config", "scripts/sqlite-bridge-test.wrangler.jsonc", "--env-file", environment, "--ip", "127.0.0.1", "--port", String(port), "--inspector-port", String(inspectorPort), "--persist-to", directory], {
  stdio: ["ignore", "ignore", "inherit"],
  env: { ...process.env, WRANGLER_LOG_PATH: resolve(directory, "wrangler.log"), WRANGLER_SEND_METRICS: "false" },
});
try {
  let response;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (server.exitCode !== null) throw new Error("Wrangler exited before readiness");
    try { response = await fetch(`http://127.0.0.1:${port}/`); break; }
    catch { await setTimeout(200); }
  }
  if (!response) throw new Error("Wrangler did not become ready");
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.ok, true, result.error);
  assert.equal(result.changes, 1, "SQLite logical affected rows must not include index writes");
  assert.deepEqual(result.upstreamCases, [
    "TestProjectStatements_Create/explicit-id-and-duplicate",
    "TestProjectStatements_Update/name",
    "TestProjectCRUD/create-get-update-delete",
    "TestUserStatements_Create_EmptyIDAssigned/create-get",
  ]);
  console.log("Pinned upstream adapted assertion matrix:", result.upstreamCases.join(", "));
  assert.equal(result.wideReturning, true);
  assert.ok(result.frameCount >= 512, "Expected framed transfer of both near-limit BLOB snapshots");
  assert.equal(result.maxFrameBytes, 32 * 1024);
  console.log(`Go/Wasm used ${result.frameCount} binary result frames, maximum ${result.maxFrameBytes} bytes.`);
  console.log("100-column RETURNING preserved the 8,388,530-byte sparse BLOB, column order, and NULLs after rollback and commit in Go/Wasm.");
  const migrationResponse = await fetch(`http://127.0.0.1:${port}/migrations`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tables: nativeSchema, objects: nativeObjects }),
  });
  assert.equal(migrationResponse.status, 200);
  const migrationResult = await migrationResponse.json();
  assert.equal(migrationResult.ok, true, migrationResult.error);
  assert.equal(migrationResult.versions, migrations.length);
  assert.deepEqual(migrationResult.seededBackfills, [29, 33]);
  assert.equal(migrationResult.injectedRollback, true);
  assert.equal(migrationResult.adaptedMigration, 33);
  assert.equal(migrationResult.schemaMatched, true);
  assert.equal(migrationResult.objectsMatched, true);
  assert.equal(migrationResult.objectCount, nativeObjects.length);
  assert.equal(nativeObjects.length, 0, "the pinned native baseline has no application views or triggers");
  assert.equal(migrationResult.maxObjectCount, 0, "the pinned migration snapshots have no application views or triggers");
  console.log(`Pinned SQLite migrations passed Up/Down/Up in workerd for ${migrationResult.versions} versions, including seeded backfills and rollback; migration 33 uses a bounded UNION rewrite.`);
  console.log("Go/Wasm SQLite bridge passed nested transactions, panic rollback, stored int64 and type round trips, RETURNING safety, and parameter-limit checks in workerd.");
} finally {
  if (server.exitCode === null && server.signalCode === null) {
    const stopped = once(server, "exit");
    server.kill("SIGTERM");
    await stopped;
  }
  await rm(directory, { recursive: true, force: true });
}
