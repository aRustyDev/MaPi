import assert from "node:assert/strict";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout } from "node:timers/promises";
import { client, runParity } from "./parity.mjs";

const fixture = JSON.parse(await readFile(".mapi/fixture.json", "utf8"));
let processHandle;
let baseUrl = process.env.MAPI_WORKER_URL;
const gate = process.env.MAPI_GATE_KEY ??
  (baseUrl ? JSON.parse(await readFile(".mapi/staging-secrets.json", "utf8")).MAPI_GATE_KEY : undefined);

async function listenPort() {
  const socket = createServer().listen(0, "127.0.0.1");
  await once(socket, "listening");
  const { port } = socket.address();
  await new Promise((done, reject) => socket.close((error) => error ? reject(error) : done()));
  return port;
}

async function stop() {
  if (!processHandle || processHandle.exitCode !== null || processHandle.signalCode !== null) return;
  const done = once(processHandle, "exit");
  processHandle.kill("SIGTERM");
  await done;
}

async function start(state, port) {
  processHandle = spawn(process.execPath, [
    resolve("node_modules/wrangler/bin/wrangler.js"), "dev", "--local", "--ip", "127.0.0.1",
    "--port", String(port), "--persist-to", state, "--env-file", ".dev.vars.poc",
  ], {
    stdio: ["ignore", "ignore", "inherit"],
    env: { ...process.env, WRANGLER_LOG_PATH: resolve(".mapi/wrangler.log"), WRANGLER_SEND_METRICS: "false" },
  });
  for (let attempt = 0; attempt < 100; attempt++) {
    if (processHandle.exitCode !== null) throw new Error("Local Wrangler exited before readiness");
    try {
      const result = await fetch(baseUrl + "/_mapi/ready");
      if (result.status === 404) return;
    } catch { /* workerd is still starting */ }
    await setTimeout(200);
  }
  throw new Error("Local Wrangler did not become ready");
}

async function test(command, id) {
  const result = await fetch(baseUrl + "/_mapi/test", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ command, id }),
  });
  assert.equal(result.status, 200, "Local test operation " + command);
  return result.json();
}

async function hosted() {
  const api = client(baseUrl, fixture, gate);
  async function signIn() {
    const start = performance.now();
    const session = api.session(await api.exchange(await api.mint()));
    api.ok(await api.read(session));
    assert.equal((await api.revoke(session)).status, 204);
    return performance.now() - start;
  }
  const firstSignInMs = await signIn();
  const result = await runParity(baseUrl, fixture, { gate });
  const latency = [];
  for (let i = 0; i < 5; i++) {
    latency.push(...await Promise.all(Array.from({ length: 4 }, signIn)));
  }
  latency.sort((a, b) => a - b);
  const probe = await fetch(baseUrl + "/_mapi/probe", { headers: { "x-mapi-test-key": gate } });
  assert.equal(probe.status, 200);
  const data = {
    firstSignInMs, warmSignInMedianMs: latency[Math.floor(latency.length / 2)],
    warmSignInP95Ms: latency[Math.ceil(latency.length * 0.95) - 1],
    concurrentJourneys: latency.length, signInMs: result.signInMs, probe: await probe.json(),
  };
  await writeFile(".mapi/staging-result.json", JSON.stringify(data, null, 2));
  console.log(JSON.stringify(data, null, 2));
}

if (baseUrl) {
  await hosted();
} else {
  const state = await mkdtemp(resolve(".mapi/worker-test-"));
  const port = await listenPort();
  baseUrl = "http://127.0.0.1:" + port;
  try {
    await start(state, port);
    const probeResponse = await fetch(baseUrl + "/_mapi/probe");
    assert.equal(probeResponse.status, 200, "Go/Wasm probe");
    const probe = await probeResponse.json();
    assert.equal(probe.transaction, true);
    assert.equal(probe.password, true);
    assert.equal(probe.clock, true);
    assert.ok(probe.wasmMemoryBytes < 128 * 1024 * 1024, "Go/Wasm probe must fit in Workers' isolate memory budget");

    const baseline = JSON.parse(await readFile(".mapi/baseline.json", "utf8"));
    const result = await runParity(baseUrl, fixture, {
      expireHandoff: () => test("expire_handoff"),
      expireSession: (id) => test("expire_session", id),
      beforeConcurrentExchange: async (api, token) => {
        const before = await test("events");
        await test("fail_audit");
        assert.equal((await api.exchange(token)).status, 500);
        assert.deepEqual(await test("events"), before, "Failed exchange must leave session and audit state unchanged");
      },
    });
    assert.deepEqual(result.wire, baseline.wire);
    const events = await test("events");
    assert.deepEqual(events.events, baseline.events);
    assert.equal(events.sessions, 2);
    assert.equal(events.seeded, 1);

    const api = client(baseUrl, fixture);
    const crossProject = await api.send("POST", "/auth_attempts", {
      token: fixture.otherProjectSecret, body: { project_id: fixture.otherProjectId },
    });
    assert.equal(crossProject.status, 403);
    const evicted = await fetch(baseUrl + "/_mapi/test", {
      method: "POST", headers: { "content-type": "application/json" }, body: '{"command":"evict"}',
    });
    assert.equal(evicted.status, 500);
    await evicted.body?.cancel();
    assert.equal((await api.read(result.active)).status, 200);
    assert.equal((await api.read(result.revoked)).status, 401);
    assert.deepEqual(await test("events"), events);

    await stop();
    await start(state, port);
    assert.equal((await api.read(result.active)).status, 200);
    assert.equal((await api.read(result.revoked)).status, 401);
    assert.deepEqual(await test("events"), events);
    const report = { probe, signInMs: result.signInMs, events: events.events, objectReset: "passed", storeRestart: "passed" };
    await writeFile(".mapi/local-result.json", JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await stop();
  }
}
