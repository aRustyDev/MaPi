import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { setTimeout } from "node:timers/promises";

async function freePort() {
  const socket = createServer().listen(0, "127.0.0.1");
  await once(socket, "listening");
  const port = socket.address().port;
  await new Promise((done) => socket.close(done));
  return port;
}

const directory = await mkdtemp(resolve(tmpdir(), "mapi-phase1-control-"));
const address = await freePort();
const inspector = await freePort();
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
const envFile = resolve(directory, "worker.env");
await writeFile(envFile, `MAPI_MASTER_KEY=${Buffer.from(JSON.stringify({ id: "master-test", pem: privateKey })).toString("base64")}\nMAPI_OPERATOR_TOKEN=synthetic-operator-token\n`, { mode: 0o600 });
const server = spawn(process.execPath, [resolve("node_modules/wrangler/bin/wrangler.js"), "dev", "--local", "--config", "scripts/phase1-control-test.wrangler.jsonc", "--env-file", envFile, "--ip", "127.0.0.1", "--port", String(address), "--inspector-port", String(inspector), "--persist-to", directory], {
  stdio: ["ignore", "ignore", "inherit"],
  env: { ...process.env, WRANGLER_LOG_PATH: resolve(directory, "wrangler.log"), WRANGLER_SEND_METRICS: "false" },
});
try {
  let response;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (server.exitCode !== null) throw new Error("Wrangler exited before readiness");
    try { response = await fetch(`http://127.0.0.1:${address}/`); break; }
    catch { await setTimeout(200); }
  }
  if (!response) throw new Error("Wrangler did not become ready");
  const result = await response.json();
  assert.equal(response.status, 200, result.error);
  assert.equal(result.ok, true);
  console.log("Private Phase 1 control verified Go token, audit, authorization and frozen owner rejection.");
} finally {
  if (server.exitCode === null && server.signalCode === null) {
    const stopped = once(server, "exit");
    server.kill("SIGTERM");
    await stopped;
  }
  await rm(directory, { recursive: true, force: true });
}
