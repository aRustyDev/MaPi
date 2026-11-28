import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { Readable, Writable } from "node:stream";
import { pathToFileURL } from "node:url";
import { join, resolve } from "node:path";
import { runHydra } from "./runtime.mjs";

const [buildDirectory, secretDirectory, port, mode = "node"] = process.argv.slice(2);
assert(buildDirectory && secretDirectory && /^\d+$/.test(port || ""),
  "usage: node probe-local.mjs <build directory> <local secrets directory> <loopback Postgres port> [node|workerd]");
assert(["node", "workerd"].includes(mode));
const wasm = await readFile(join(buildDirectory, "hydra-phase0.wasm"));
let module;
if (mode === "node") {
  await import(pathToFileURL(join(resolve(buildDirectory), "wasm_exec.js")));
  module = await WebAssembly.compile(wasm);
}
const localEnv = Object.fromEntries(
  (await readFile(join(secretDirectory, "local-postgres.env"), "utf8")).trim().split("\n")
    .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
);
const [systemSecret, clientSecret] = await Promise.all(
  ["local-hydra-system-secret", "local-hydra-client-secret"]
    .map(async (file) => (await readFile(join(secretDirectory, file), "utf8")).trim()),
);
const issuer = "https://hydra-phase0.invalid";
const dsn = new URL("postgres://127.0.0.1/mapi_spike?sslmode=disable");
dsn.port = port;
dsn.username = localEnv.POSTGRES_USER;
dsn.password = localEnv.POSTGRES_PASSWORD;
assert.equal(dsn.hostname, "127.0.0.1");

let observedConnections = 0;
function dial(host, portNumber) {
  assert.equal(host, "127.0.0.1");
  observedConnections++;
  const socket = createConnection({ host, port: portNumber });
  socket.on("error", () => {});
  return {
    opened: new Promise((done, fail) => {
      socket.once("connect", done);
      socket.once("error", fail);
    }),
    readable: Readable.toWeb(socket),
    writable: Writable.toWeb(socket),
    close: () => socket.destroy(),
  };
}

let runtime;
if (mode === "workerd") {
  const { Miniflare, convertV4MiniflareOptions } = await import("miniflare");
  const paths = ["worker.mjs", "runtime.mjs", "session-fence.mjs", "wasm_exec.js"];
  const modules = await Promise.all(paths.map(async (path) => ({
    type: "ESModule", path, contents: await readFile(join(buildDirectory, path), "utf8"),
  })));
  runtime = new Miniflare(convertV4MiniflareOptions({
    host: "127.0.0.1", port: 0, telemetry: { enabled: false },
    workers: [
      {
        name: "hydra-probe-local-caller",
        compatibilityDate: "2026-11-25",
        modules: [{
          type: "ESModule",
          path: "caller.mjs",
          contents: "export default { fetch(request, env) { return env.HYDRA.fetch(request); } };",
        }],
        serviceBindings: { HYDRA: { name: "hydra-probe-local-engine", entrypoint: "HydraPhase0" } },
      },
      {
        name: "hydra-probe-local-engine",
        compatibilityDate: "2026-11-25",
        modules: [...modules, { type: "CompiledWasm", path: "hydra-phase0.wasm", contents: wasm }],
        hyperdrives: { SPIKE_POSTGRES: dsn.href },
        bindings: { SPIKE_ISSUER: issuer, SPIKE_SYSTEM_SECRET: systemSecret },
      },
    ],
  }));
}

async function dispatch(input) {
  if (!runtime) return runHydra({ module, dsn: dsn.href, issuer, systemSecret, dial, input });
  const headers = new Headers();
  for (const [name, values] of Object.entries(input.headers || {})) {
    for (const value of values) headers.append(name, value);
  }
  const response = await runtime.dispatchFetch("http://127.0.0.1" + input.path, {
    method: input.method, headers, body: input.body,
  });
  return { status: response.status, body: await response.text() };
}

const testTimeout = setTimeout(() => {
  console.error("Hydra Wasm local probe timed out after " + observedConnections + " connection attempts.");
  process.exitCode = 1;
  process.exit();
}, 120000);
testTimeout.unref();

try {
  const discovery = await dispatch({ method: "GET", path: "/.well-known/openid-configuration" });
  assert.equal(discovery.status, 200, "Hydra discovery status");
  assert.equal(JSON.parse(discovery.body).token_endpoint, issuer + "/oauth2/token");

  const token = await dispatch({
    method: "POST",
    path: "/oauth2/token",
    headers: {
      Authorization: ["Basic " + Buffer.from("mapi-phase0-local-cc:" + clientSecret).toString("base64")],
      "Content-Type": ["application/x-www-form-urlencoded"],
    },
    body: "grant_type=client_credentials&scope=probe",
  });
  assert.equal(token.status, 200, "Hydra client-credentials status");
  assert.equal(typeof JSON.parse(token.body).access_token, "string");
  if (mode === "node") assert(observedConnections > 0);
  console.log("Pinned Hydra Wasm served discovery and minted a synthetic client-credentials token through local Postgres in " + mode + ".");
} finally {
  clearTimeout(testTimeout);
  await runtime?.dispose();
}
