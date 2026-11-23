import assert from "node:assert/strict";
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

const directory = await mkdtemp(resolve(tmpdir(), "mapi-registry-move-"));
const address = await freePort();
const inspector = await freePort();
const envFile = resolve(directory, "empty.env");
await writeFile(envFile, "");
const server = spawn(process.execPath, [resolve("node_modules/wrangler/bin/wrangler.js"), "dev", "--local", "--config", "scripts/registry-move-test.wrangler.jsonc", "--env-file", envFile, "--ip", "127.0.0.1", "--port", String(address), "--inspector-port", String(inspector), "--persist-to", directory], {
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
  console.log("Registry move closes one route and atomically advances generation.");
} finally {
  if (server.exitCode === null && server.signalCode === null) {
    const stopped = once(server, "exit");
    server.kill("SIGTERM");
    await stopped;
  }
  await rm(directory, { recursive: true, force: true });
}
