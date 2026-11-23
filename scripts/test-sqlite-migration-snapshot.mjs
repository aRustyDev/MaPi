// Exercise only the pinned migration endpoint in disposable local workerd.
// The broader bridge endpoint and unrelated boundary tests are not invoked.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { setTimeout } from "node:timers/promises";
import { snapshotSchema, snapshotSchemaObjects } from "./sqlite-bridge-schema.mjs";

const upstream = resolve(".mapi/nextgen");
const pin = "b0b74cd4a198428ea9b82910c217259ffc62b65c";
const migrationDir = "apps/api/internal/storage/dialect/sqlite/migration/sql";
const paths = execFileSync("git", ["-C", upstream, "ls-tree", "-r", "--name-only", pin, "--", migrationDir], { encoding: "utf8" })
  .trim().split("\n").filter((path) => /^\d+_.+\.sql$/.test(path.split("/").at(-1))).sort();
const pinned = paths.map((path) => {
  const filename = path.split("/").at(-1);
  const source = execFileSync("git", ["-C", upstream, "show", `${pin}:${path}`], { encoding: "utf8" });
  const sections = source.split(/^-- \+goose (Up|Down)\s*$/m);
  assert.equal(sections.length, 5);
  assert.equal(sections[1], "Up"); assert.equal(sections[3], "Down");
  function statements(section) {
    const expressions = [...section.matchAll(/^-- \+goose StatementBegin\s*$([\s\S]*?)^-- \+goose StatementEnd\s*$/gm)];
    const residue = section.replace(/^-- \+goose StatementBegin\s*$[\s\S]*?^-- \+goose StatementEnd\s*$/gm, "");
    assert(!residue.split("\n").some((line) => line.trim() && !line.trim().startsWith("--")));
    return expressions.map((item) => item[1].trim());
  }
  return {version: Number(filename.slice(0, 6)), name: filename, up: statements(sections[2]), down: statements(sections[4])};
});
const fixture = JSON.parse(await readFile("worker/generated/sqlite-bridge-migrations.json", "utf8"));
assert.deepEqual(fixture, pinned, "generated migration fixture must match the pin");
const baseline = JSON.parse(await readFile("worker/generated/baseline.json", "utf8"));
const db = new DatabaseSync(":memory:");
db.exec("PRAGMA foreign_keys = OFF");
for (const statement of baseline.statements) db.exec(statement);
const tables = snapshotSchema((statement) => db.prepare(statement).all());
const objects = snapshotSchemaObjects((statement) => db.prepare(statement).all());
db.close();

async function freePort() {
  const socket = createServer().listen(0, "127.0.0.1");
  await once(socket, "listening");
  const {port} = socket.address();
  await new Promise((done, reject) => socket.close((error) => error ? reject(error) : done()));
  return port;
}
const directory = await mkdtemp(resolve(tmpdir(), "mapi-migration-snapshot-"));
let server;
try {
  const environment = resolve(directory, "empty.env");
  await writeFile(environment, "");
  const port = await freePort(), inspectorPort = await freePort();
  server = spawn(process.execPath, [resolve("node_modules/wrangler/bin/wrangler.js"), "dev", "--local", "--config", "scripts/sqlite-bridge-test.wrangler.jsonc", "--env-file", environment, "--ip", "127.0.0.1", "--port", String(port), "--inspector-port", String(inspectorPort), "--persist-to", directory], {
    stdio: ["ignore", "ignore", "pipe"],
    env: {...process.env, WRANGLER_LOG_PATH: resolve(directory, "wrangler.log"), WRANGLER_SEND_METRICS: "false"},
  });
  let diagnostics = "";
  server.stderr.on("data", (chunk) => { diagnostics = (diagnostics + chunk.toString()).slice(-12000); });
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (server.exitCode !== null) throw new Error(`Wrangler exited before readiness: ${diagnostics}`);
    const socket = createConnection({host:"127.0.0.1", port});
    ready = await new Promise((done) => { socket.once("connect", () => { socket.destroy(); done(true); }); socket.once("error", () => done(false)); });
    if (ready) break;
    await setTimeout(200);
  }
  if (!ready) throw new Error(`Wrangler did not become ready: ${diagnostics}`);
  // Dispatch the migration exactly once; an uncertain response is a failure.
  const response = await fetch(`http://127.0.0.1:${port}/migrations`, {method:"POST", headers:{"content-type":"application/json"}, body:JSON.stringify({tables, objects}), signal:AbortSignal.timeout(60000)});
  const result = await response.json();
  assert.equal(response.status, 200, JSON.stringify(result));
  assert.equal(result.ok, true, result.error);
  assert.equal(result.versions, pinned.length);
  assert.deepEqual(result.seededBackfills, [29, 33]);
  assert.equal(result.injectedRollback, true);
  assert.equal(result.adaptedMigration, 33);
  assert.equal(result.schemaMatched, true);
  assert.equal(result.objectsMatched, true);
  assert.equal(result.objectCount, objects.length);
  assert.equal(objects.length, 0);
  assert.equal(result.maxObjectCount, 0);
  console.log(`Pinned migration snapshot passed ${result.versions} Up/Down/Up rounds with foreign-key declarations and table options in disposable workerd.`);
} finally {
  if (server && server.exitCode === null && server.signalCode === null) {
    const stopped = once(server, "exit");
    server.kill("SIGTERM");
    await stopped;
  }
  await rm(directory, {recursive:true, force:true});
}
