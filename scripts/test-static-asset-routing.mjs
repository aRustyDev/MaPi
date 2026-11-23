import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { setTimeout } from "node:timers/promises";

async function freePort() {
  const server = createServer().listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  await new Promise((done) => server.close(done));
  return port;
}

const dir = await mkdtemp(resolve(tmpdir(), "mapi-static-assets-"));
let server;
try {
  const [port, inspector] = await Promise.all([freePort(), freePort()]);
  const config = resolve(dir, "wrangler.jsonc");
  await writeFile(config, JSON.stringify({
    name: "mapi-local-static-asset-test",
    main: resolve("scripts/static-asset-routing-test-worker.mjs"),
    compatibility_date: "2026-11-19",
    workers_dev: false,
    assets: { directory: resolve("worker/assets"), binding: "ASSETS", run_worker_first: true },
  }));
  const asset = await readFile(resolve("worker/assets/zitadel-login.mjs"));
  const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
  server = spawn(process.execPath, [resolve("node_modules/wrangler/bin/wrangler.js"), "dev", "--local", "--config", config, "--ip", "127.0.0.1", "--port", String(port), "--inspector-port", String(inspector), "--persist-to", dir], {
    stdio: ["ignore", "ignore", "inherit"], env: { ...process.env, WRANGLER_LOG_PATH: resolve(dir, "wrangler.log"), WRANGLER_SEND_METRICS: "false" },
  });
  const origin = `http://127.0.0.1:${port}`;
  let response;
  for (let i = 0; i < 100; i++) {
    if (server.exitCode !== null || server.signalCode !== null) throw new Error("local workerd exited");
    try { response = await fetch(`${origin}/zitadel-login.mjs?test=1`); break; }
    catch { await setTimeout(200); }
  }
  if (!response) throw new Error("local workerd did not start");
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /javascript/i);
  assert.equal(digest(Buffer.from(await response.arrayBuffer())), digest(asset));
  assert.equal(response.headers.get("x-test-assets-calls"), "1");
  assert.equal(response.headers.get("x-test-registry-calls"), "0");
  assert.equal(response.headers.get("x-test-owner-calls"), "0");

  for (const [path, options] of [
    ["/zitadel-login.mjs", { method: "POST" }],
    ["/zitadel-login.mjs", { method: "GET", headers: { "x-test-login-enabled": "0" } }],
    ["/other.mjs", { method: "GET" }],
  ]) {
    const other = await fetch(origin + path, options);
    assert.equal(other.status, 598);
    assert.equal(other.headers.get("x-test-assets-calls"), "0");
    assert.equal(other.headers.get("x-test-registry-calls"), "1");
    assert.equal(other.headers.get("x-test-owner-calls"), "0");
  }
  console.log("Static login asset is served without registry or project-object calls.");
} finally {
  if (server && server.exitCode === null && server.signalCode === null) {
    const exited = once(server, "exit"); server.kill("SIGTERM"); await exited;
  }
  await rm(dir, { recursive: true, force: true });
}
