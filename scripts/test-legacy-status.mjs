import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { setTimeout } from "node:timers/promises";

async function port() {
  const server = createServer().listen(0, "127.0.0.1");
  await once(server, "listening");
  const number = server.address().port;
  await new Promise(done => server.close(done));
  return number;
}

// Instrument only a throwaway local module. Production app.js has no fault RPC.
const generated = resolve("worker/generated-legacy-status-app.js");
const source = await readFile(resolve("worker/app.js"), "utf8");
const classAnchor = "export class NextgenApplication extends DurableObject {";
const upstreamAnchor = "  #upstream(method, path, body, headers = {}) {";
if (source.split(classAnchor).length !== 2 || source.split(upstreamAnchor).length !== 2) throw Error("Missing or ambiguous local fault injection anchors");
const instrumented = source.replace(classAnchor, `${classAnchor}
  #testFault = null;
  #testFaultObserved = false;
  testFault(index, status) { if (this.env.MAPI_LOCAL_TEST !== "1") throw Error("Local testing disabled"); this.#testFault = { index, status, seen: 0 }; this.#testFaultObserved = false; }
  testFaultHit() { if (this.env.MAPI_LOCAL_TEST !== "1") throw Error("Local testing disabled"); return this.#testFaultObserved; }
  testSessionCount() { if (this.env.MAPI_LOCAL_TEST !== "1") throw Error("Local testing disabled"); return this.ctx.storage.sql.exec("SELECT COUNT(*) AS n FROM sessions").one().n; }
  testThrottle(ip) { if (this.env.MAPI_LOCAL_TEST !== "1") throw Error("Local testing disabled"); this.ctx.storage.sql.exec("INSERT OR REPLACE INTO mapi_login_limits VALUES (?, ?, 60)", "ip:password:" + ip, Math.floor(Date.now() / 60000)); }
`).replace(upstreamAnchor, `${upstreamAnchor}
    if (this.#testFault && this.#testFault.seen++ === this.#testFault.index) { const status = this.#testFault.status; this.#testFault = null; this.#testFaultObserved = true; return { status, headers: {}, data: { error: "sensitive upstream details" }, body: "sensitive upstream details" }; }
`);
await writeFile(generated, instrumented, { flag: "wx" });
let dir, server;
try {
  dir = await mkdtemp(resolve(tmpdir(), "mapi-legacy-status-"));
  const address = await port(), inspector = await port(), envFile = resolve(dir, "worker.env");
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
  const master = Buffer.from(JSON.stringify({ id: "master-test", pem: privateKey })).toString("base64");
  await writeFile(envFile, `MAPI_MASTER_KEY=${master}\n`, { mode: 0o600 });
  server = spawn(process.execPath, [resolve("node_modules/wrangler/bin/wrangler.js"), "dev", "--local", "--config", "scripts/legacy-status-test.wrangler.jsonc", "--env-file", envFile, "--ip", "127.0.0.1", "--port", String(address), "--inspector-port", String(inspector), "--persist-to", dir], { stdio: ["ignore", "ignore", "inherit"], env: { ...process.env, WRANGLER_LOG_PATH: resolve(dir, "wrangler.log"), WRANGLER_SEND_METRICS: "false" } });
  let response;
  for (let i = 0; i < 100; i++) {
    if (server.exitCode !== null) throw Error("Local workerd exited");
    try { response = await fetch(`http://127.0.0.1:${address}/`, { signal: AbortSignal.timeout(120000) }); break; }
    catch (error) { if (error.name === "TimeoutError") throw error; await setTimeout(200); }
  }
  if (!response) throw Error("Local workerd did not start");
  const result = await response.json();
  if (response.status !== 200) throw Error(`Local status test returned HTTP ${response.status}: ${result.error} ${result.stack}`);
  assert.equal(result.ok, true, result.error);
  assert.equal(result.cases, 62);
  console.log("Legacy login and session upstream status handling passed (59 fault cases and 3 credential/admission checks).");
} finally {
  if (server && server.exitCode === null && server.signalCode === null) { const stopped = once(server, "exit"); server.kill("SIGTERM"); await stopped; }
  if (dir) await rm(dir, { recursive: true, force: true });
  await rm(generated, { force: true });
}
