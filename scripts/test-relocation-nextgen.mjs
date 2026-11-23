import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout } from "node:timers/promises";

let tables;
const large = process.env.MAPI_LARGE_IMPORT === "1";
const users = large ? 10_000 : 128;
const events = large ? 100_000 : 512;
async function freePort() {
  const socket = createServer().listen(0, "127.0.0.1");
  await once(socket, "listening");
  const port = socket.address().port;
  await new Promise((done, reject) => socket.close((error) => error ? reject(error) : done()));
  return port;
}
const directory = await mkdtemp(resolve(tmpdir(), "mapi-nextgen-relocation-"));
const environment = resolve(directory, "empty.env");
await writeFile(environment, "");
const port = await freePort();
const inspectorPort = await freePort();
const server = spawn(process.execPath, [resolve("node_modules/wrangler/bin/wrangler.js"), "dev", "--local", "--config", "scripts/relocation-nextgen-test.wrangler.jsonc", "--env-file", environment, "--ip", "127.0.0.1", "--port", String(port), "--inspector-port", String(inspectorPort), "--persist-to", directory], {
  stdio: ["ignore", "ignore", "pipe"],
  env: { ...process.env, WRANGLER_LOG_PATH: resolve(directory, "wrangler.log"), WRANGLER_SEND_METRICS: "false" },
});
let diagnostic = "";
server.stderr.on("data", (chunk) => { diagnostic = (diagnostic + chunk.toString()).slice(-16000); });
async function call(name, action, options = {}, expectFailure = false) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const response = await fetch(`http://127.0.0.1:${port}/`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, action, ...options }),
    });
    const text = await response.text();
    if (!expectFailure && ["chunk", "receive", "status", "page", "fk"].includes(action) &&
        text.startsWith("Your worker restarted mid-request") && attempt < 3) {
      await setTimeout(250);
      continue;
    }
    let body;
    try { body = JSON.parse(text); }
    catch { throw Error(`${action}: HTTP ${response.status}: ${text.slice(0, 200)}`); }
    if (expectFailure) {
      assert.equal(response.status, 500, `Expected failure for ${action}`);
      return body;
    }
    assert.equal(response.status, 200, `${action}: ${JSON.stringify(body)}`);
    return body;
  }
  throw Error(`${action}: worker restart retries exhausted`);
}
async function snapshot(name) {
  const result = {};
  for (const table of tables) {
    let cursor = null;
    let count = 0;
    const digest = createHash("sha256");
    for (;;) {
      const page = await call(name, "page", { table, cursor });
      for (const row of page.rows) {
        digest.update(JSON.stringify(row));
        digest.update("\n");
      }
      count += page.rows.length;
      if (page.rows.length < 64) break;
      cursor = page.cursor;
    }
    result[table] = { count, digest: digest.digest("hex") };
  }
  return result;
}
try {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (server.exitCode !== null) throw Error("Wrangler exited before readiness");
    try {
      await fetch(`http://127.0.0.1:${port}/`, { method: "POST", body: "{}" });
      break;
    } catch {
      if (attempt === 99) throw Error("Wrangler did not become ready");
      await setTimeout(200);
    }
  }
  const seedStarted = performance.now();
  await call("source", "initialize");
  for (let start = 0; start < users; start += 128) await call("source", "users", { start, count: Math.min(128, users - start) });
  for (let start = 0; start < events; start += 256) await call("source", "events", { start, count: Math.min(256, events - start) });
  const manifest = await call("source", "finish");
  tables = manifest.tables;
  assert.equal(tables.length, 83);
  const seedSeconds = (performance.now() - seedStarted) / 1000;
  console.log(`Seeded ${users} users and ${events} events in ${seedSeconds.toFixed(2)} seconds.`);
  assert.ok((await call("source", "plan")).some((detail) => detail.includes("SEARCH") && detail.includes("INDEX")), "events keyset must seek on an index");
  await call("target", "begin", { manifest });
  const source = await snapshot("source");
  assert.equal(source.users.count, users);
  assert.equal(source.user_attributes.count, users + 1);
  assert.equal(source.user_passwords.count, users);
  assert.equal(source.events.count, events);
  await call("source", "chunk", { index: 0, fail: true }, true);
  assert.equal((await call("source", "status")).source.next_chunk, 0);
  await call("source", "evict", {}, true);
  const started = performance.now();
  let count = 0;
  let transferredBytes = 0;
  let interruptedWrite = false;
  let fragments = 0;
  let maxChunkBytes = 0;
  for (;;) {
    const part = await call("source", "chunk", { index: count });
    const payload = JSON.parse(part.content);
    const length = Buffer.byteLength(part.content);
    assert.ok(length <= 128 * 1024);
    maxChunkBytes = Math.max(maxChunkBytes, length);
    if (payload.fragment) fragments++;
    transferredBytes += length;
    if (!interruptedWrite && payload.rows.length > 0) {
      await call("target", "receive", { part, fail: 1 }, true);
      assert.equal((await call("target", "status")).destination.next_chunk, count);
      interruptedWrite = true;
    }
    await call("target", "receive", { part });
    if (count === 0) await call("target", "receive", { part });
    count++;
    if (large && count % 200 === 0) console.log(`Transferred ${count} chunks, ${transferredBytes} encoded bytes.`);
    if (count === 3) {
      await call("source", "evict", {}, true);
      await call("target", "evict", {}, true);
      assert.equal((await call("target", "status")).destination.next_chunk, count);
      assert.equal((await call("source", "status")).source.next_chunk, count);
    }
    if (payload.done) break;
  }
  const elapsedSeconds = (performance.now() - started) / 1000;
  assert.ok(interruptedWrite, 'fixture must inject an interrupted row write');
  assert.ok(fragments > 1, 'fixture must fragment the oversized user attribute');
  const target = await snapshot("target");
  assert.deepEqual(target, source);
  assert.equal(await call("source", "fk"), 0);
  assert.equal(await call("target", "fk"), 0);
  const sourceStatus = await call("source", "status");
  const targetStatus = await call("target", "status");
  assert.equal(sourceStatus.owner.digest, targetStatus.fence.digest);
  assert.equal(targetStatus.fence.state, "staged");
  await call("target", "reconcile", { manifest });
  let digestPages = 0;
  for (const table of tables) {
    let cursor = null;
    for (;;) {
      const left = await call('source', 'digest', { manifest, role: 'source', table, cursor });
      const right = await call('target', 'digest', { manifest, role: 'destination', table, cursor });
      assert.deepEqual(right, left, `reconciliation mismatch: ${table}`);
      digestPages++;
      if (left.done) break;
      cursor = left.cursor;
    }
  }
  if (large) assert.ok(transferredBytes >= 128 * 1024 * 1024, "large fixture encoded size");
  console.log(JSON.stringify({ large, users, events, seedSeconds, transferredBytes, chunks: count, maxChunkBytes, fragments, transferSeconds: elapsedSeconds, bytesPerSecond: transferredBytes / elapsedSeconds, rowsPerSecond: (users * 3 + events) / elapsedSeconds, digestPages, tables: source }, null, 2));
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
