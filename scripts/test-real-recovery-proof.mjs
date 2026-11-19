import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { setTimeout } from "node:timers/promises";

async function freePort() {
  const socket = createServer().listen(0, "127.0.0.1");
  await once(socket, "listening");
  const { port } = socket.address();
  await new Promise((done, reject) => socket.close((error) => error ? reject(error) : done()));
  return port;
}

const directory = await mkdtemp(resolve(tmpdir(), "mapi-real-recovery-"));
const port = await freePort();
const inspectorPort = await freePort();
const server = spawn(process.execPath, [resolve("node_modules/wrangler/bin/wrangler.js"), "dev", "--local", "--config", "scripts/real-recovery-proof.wrangler.jsonc", "--env-file", resolve(".dev.vars.app"), "--ip", "127.0.0.1", "--port", String(port), "--inspector-port", String(inspectorPort), "--persist-to", directory], {
  stdio: ["ignore", "ignore", "pipe"],
  env: { ...process.env, WRANGLER_LOG_PATH: resolve(directory, "wrangler.log"), WRANGLER_SEND_METRICS: "false" },
});
let diagnostic = "";
server.stderr.on("data", (chunk) => { diagnostic = (diagnostic + chunk.toString()).slice(-16000); });
try {
  let response;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (server.exitCode !== null) throw new Error("Wrangler exited before readiness");
    try { response = await fetch(`http://127.0.0.1:${port}/`); break; }
    catch { await setTimeout(200); }
  }
  if (!response) throw new Error("Wrangler did not become ready");
  const result = await response.json();
  assert.equal(response.status, 200, JSON.stringify(result));
  assert.equal(result.ok, true, result.error);
  console.log("Real project recovery proof passed stale route, in-flight write, recovery rollback, audit, handoff and session invalidation, and isolation checks.");
} catch (error) {
  if (diagnostic) console.error(diagnostic);
  throw error;
} finally {
  if (server.exitCode === null && server.signalCode === null) {
    const stopped = once(server, "exit");
    server.kill("SIGTERM");
    await stopped;
  }
  await rm(directory, { recursive: true, force: true });
}
