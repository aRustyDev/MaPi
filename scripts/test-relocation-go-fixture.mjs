import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { setTimeout } from "node:timers/promises";

async function freePort() {
  const server = createServer().listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}
const dir = await mkdtemp(resolve(tmpdir(), "mapi-go-relocation-"));
const port = await freePort();
const inspectorPort = await freePort();
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 4096, privateKeyEncoding: { type: "pkcs1", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
const key = Buffer.from(JSON.stringify({ id: "fixture-key", pem: privateKey })).toString("base64");
const envPath = resolve(dir, "vars");
await writeFile(envPath, `MAPI_MASTER_KEY=${key}\nMAPI_OPERATOR_TOKEN=${randomBytes(32).toString("base64url")}\nMAPI_APP_ORIGIN=https://one.example.test\nMAPI_LOCAL_TEST=1\n`, { mode: 0o600 });
const server = spawn(process.execPath, [resolve("node_modules/wrangler/bin/wrangler.js"), "dev", "--local", "--config", "scripts/relocation-go-fixture.wrangler.jsonc", "--env-file", envPath, "--ip", "127.0.0.1", "--port", String(port), "--inspector-port", String(inspectorPort), "--persist-to", dir], {
  stdio: ["ignore", "ignore", "pipe"], env: { ...process.env, WRANGLER_SEND_METRICS: "false", WRANGLER_LOG_PATH: resolve(dir, "wrangler.log") },
});
const tables = [
  "projects", "mapi_project", "mapi_login_limits", "authz_assignments", "encryption_keys", "signing_keys",
  "json_schemas", "flow_definitions", "policies", "policy_revisions", "project_origins", "releases", "variable_sets",
  "deployments", "deployment_origins", "deployment_variable_sets", "resource_scope_index", "search_entries",
  "users", "user_attributes", "user_passwords", "sessions", "tokens", "auth_attempts", "checks", "events",
];
const referenceTables = ["authz_catalogs", "authz_expression_edges", "authz_relation_closure", "authz_relation_references", "authz_relations", "goose_db_version"];
let diagnostic = "";
let restartRetries = 0;
server.stderr.on("data", (chunk) => { diagnostic = (diagnostic + chunk.toString()).slice(-12000); });
async function call(name, action, values = {}) {
  const repeatable = ["provision", "tables", "freeze", "begin", "chunk", "receive", "copyStatus", "activate", "finish", "page", "identity"];
  for (let attempt = 0; attempt < 4; attempt++) {
    const response = await fetch(`http://127.0.0.1:${port}/`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, action, ...values }) });
    const text = await response.text();
    if (repeatable.includes(action) && text.startsWith("Your worker restarted mid-request") && attempt < 3) {
      restartRetries++;
      await setTimeout(250);
      continue;
    }
    let body;
    try { body = JSON.parse(text); } catch { throw Error(`${action}: HTTP ${response.status}: ${text.slice(0, 200)}`); }
    assert.equal(response.status, 200, `${action}: ${JSON.stringify(body)}`);
    return body;
  }
  throw Error(`${action}: worker restart retries exhausted`);
}
async function snapshot(name, selected = tables) {
  const result = {};
  for (const table of selected) {
    const digest = createHash("sha256");
    let cursor = null;
    let count = 0;
    for (;;) {
      const page = await call(name, "page", { table, cursor });
      for (const row of page.rows) { digest.update(JSON.stringify(row)); digest.update("\n"); }
      count += page.rows.length;
      if (page.rows.length < 64) break;
      cursor = page.cursor;
    }
    result[table] = { count, digest: digest.digest("hex") };
  }
  return result;
}
try {
  for (let i = 0; i < 100; i++) {
    if (server.exitCode !== null) throw Error("Wrangler exited");
    try { await fetch(`http://127.0.0.1:${port}/`, { method: "POST", body: "{}" }); break; }
    catch { if (i === 99) throw Error("Wrangler did not start"); await setTimeout(200); }
  }
  const project = await call("one", "provision", { origin: "https://one.example.test" });
  const other = await call("two", "provision", { origin: "https://two.example.test" });
  assert.notEqual(project.projectId, other.projectId);
  const password = "Synthetic-Password-123!";
  await call("one", "user", { email: "one@example.test", password });
  await call("two", "user", { email: "two@example.test", password });
  const one = await call("one", "login", { email: "one@example.test", password });
  const revoked = await call("one", "login", { email: "one@example.test", password });
  const two = await call("two", "login", { email: "two@example.test", password });
  assert.equal(one.status, 200);
  assert.equal(revoked.status, 200);
  assert.equal(two.status, 200);
  const cookie = one.cookie.split(";", 1)[0];
  const revokedCookie = revoked.cookie.split(";", 1)[0];
  const otherCookie = two.cookie.split(";", 1)[0];
  assert.equal((await call("one", "session", { cookie })).status, 200);
  const csrf = await call("one", "session", { cookie: revokedCookie, operation: "csrf" });
  assert.equal(csrf.status, 200);
  assert.equal((await call("one", "session", { cookie: revokedCookie, operation: "logout", csrfToken: csrf.data.csrf_token })).status, 204);
  assert.notEqual((await call("one", "session", { cookie: revokedCookie })).status, 200);
  assert.notEqual((await call("two", "session", { cookie })).status, 200);
  const baseline = await call("target", "tables");
  const source = await call("one", "tables");
  const expected = await snapshot("one");
  const reference = await snapshot("one", referenceTables);
  assert.deepEqual(await snapshot("target", referenceTables), reference, "baseline reference records differ");
  const sourceNames = new Set(source.map(({ name }) => name));
  const baselineNames = new Set(baseline.map(({ name }) => name));
  const unaccounted = [...sourceNames].filter((name) => !tables.includes(name) && !baselineNames.has(name) && name !== "mapi_project_origin");
  assert.deepEqual(unaccounted, [], "unaccounted populated fixture tables");
  await call("one", "freeze", { project: project.projectId });
  await call("target", "begin", { project: project.projectId });
  let chunks = 0;
  for (;;) {
    const [envelope, control] = await Promise.all([
      call("one", "chunk", { project: project.projectId, index: chunks }),
      call("two", "session", { cookie: otherCookie }),
    ]);
    assert.equal(control.status, 200);
    await call("target", "receive", { project: project.projectId, envelope });
    chunks++;
    if (JSON.parse(envelope.content).done) break;
  }
  const frozen = await call("one", "copyStatus", { project: project.projectId });
  const staged = await call("target", "copyStatus", { project: project.projectId });
  assert.equal(frozen.digest, staged.digest);
  assert.equal(staged.state, "staged");
  assert.deepEqual(await snapshot("target"), expected);
  await call("target", "finish", { origin: "https://one.example.test" });
  await call("target", "activate", { project: project.projectId });
  assert.equal(await call("target", "identity"), project.projectId, "copied project ID");
  assert.equal((await call("target", "session", { cookie })).status, 200, "copied session");
  assert.notEqual((await call("target", "session", { cookie: revokedCookie })).status, 200, "copied revoked session");
  const migrated = await call("target", "login", { email: "one@example.test", password });
  assert.equal(migrated.status, 200, "copied credentials");
  assert.notEqual((await call("target", "session", { cookie: otherCookie })).status, 200, "foreign cookie rejected after copy");
  assert.equal((await call("two", "session", { cookie: otherCookie })).status, 200, "other project session");
  console.log(JSON.stringify({ authenticatedProjects: 2, copiedTables: tables.length, chunks, restartRetries, sourceEventCount: expected.events.count, sourceUserCount: expected.users.count, sourceProjectIdPreserved: true, userCredentialAndSessionPreserved: true, foreignCookieRejected: true, otherProjectActiveDuringCopy: true, sourceTables: source, baselineTables: baseline }, null, 2));
} catch (error) {
  if (diagnostic) console.error(diagnostic);
  throw error;
} finally {
  if (server.exitCode === null && server.signalCode === null) {
    const stopped = once(server, "exit"); server.kill("SIGTERM"); await stopped;
  }
  await rm(dir, { recursive: true, force: true });
}
