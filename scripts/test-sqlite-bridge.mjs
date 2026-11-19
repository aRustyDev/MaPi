import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { setTimeout } from "node:timers/promises";

const upstream = resolve(".mapi/nextgen/apps/api");
const target = resolve(upstream, "cmd/mapi-bridge-test");
await mkdir(target, { recursive: true });
await mkdir("worker/generated", { recursive: true });
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
  console.log("Go/Wasm SQLite bridge passed nested commit/rollback, panic rollback, int64, and parameter-limit checks in workerd.");
} finally {
  if (server.exitCode === null && server.signalCode === null) {
    const stopped = once(server, "exit");
    server.kill("SIGTERM");
    await stopped;
  }
  await rm(directory, { recursive: true, force: true });
}
