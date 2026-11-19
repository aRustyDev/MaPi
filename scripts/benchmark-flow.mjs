import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";

const base = process.env.MAPI_URL;
const token = process.env.MAPI_OPERATOR_TOKEN;
if (!base || !token) throw new Error("MAPI_URL and MAPI_OPERATOR_TOKEN are required");
const origin = new URL(base).origin;
const authorization = `Bearer ${token}`;
const admin = async (path, body) => fetch(new URL(path, origin), {
  method: "POST", headers: { authorization, "content-type": "application/json" }, body: JSON.stringify(body),
});
const init = await admin("/_mapi/admin/init", { name: "Flow benchmark" });
assert.equal(init.status, 200);
const { projectId } = await init.json();
const email = `flow-load-${randomUUID()}@example.com`;
const password = `Example-${randomUUID()}!`;
assert.equal((await admin("/_mapi/admin/users", { email, password })).status, 200);

async function journey() {
  const started = performance.now();
  let flowCookie = "";
  async function flow(method, path, body) {
    const response = await fetch(new URL(`/__nextgen${path}`, origin), {
      method, headers: { origin, "content-type": "application/json", ...(flowCookie ? { cookie: flowCookie } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const cookie = response.headers.getSetCookie().find((value) => value.startsWith("_zflow="));
    if (cookie) flowCookie = cookie.split(";", 1)[0];
    assert.ok(response.ok, `Flow request failed: ${response.status}`);
    return response.json();
  }
  let result = await flow("POST", "/flows", { project_id: projectId, purpose: "login" });
  for (let hop = 0; hop < 6 && !result.handoff_token; hop++) {
    const fields = {};
    for (const field of result.step.fields ?? []) {
      const name = field.name.split(/[#/.]/).at(-1).toLowerCase();
      if (name === "email" || name === "login_name" || name === "identifier") fields[field.name] = email;
      else if (name === "password") fields[field.name] = password;
      else throw new Error(`Unexpected flow field ${field.name}`);
    }
    result = await flow("POST", `/flows/${encodeURIComponent(result.id)}/submit`, {
      action: "submit", fields, ...(result.session_token ? { session_token: result.session_token } : {}),
    });
  }
  assert.ok(result.handoff_token);
  const exchange = await fetch(new URL(`/__nextgen/sessions/exchange?project_id=${encodeURIComponent(projectId)}`, origin), {
    method: "POST", headers: { origin, "content-type": "application/json", cookie: flowCookie },
    body: JSON.stringify({ handoff_token: result.handoff_token }),
  });
  assert.equal(exchange.status, 200);
  const cookie = exchange.headers.getSetCookie().find((value) => /^(?:__Host-)?zitadel_session=/.test(value))?.split(";", 1)[0];
  assert.ok(cookie);
  const signInMs = performance.now() - started;
  const app = await fetch(new URL("/app", origin), { headers: { cookie }, redirect: "manual" });
  assert.equal(app.status, 200);
  const csrf = (await app.text()).match(/name="csrf" value="([A-Za-z0-9_-]+)"/)?.[1];
  assert.ok(csrf);
  const logout = await fetch(new URL("/logout", origin), { method: "POST", headers: { origin, cookie }, body: new URLSearchParams({ csrf }), redirect: "manual" });
  assert.equal(logout.status, 303);
  return { signInMs, journeyMs: performance.now() - started };
}

const first = await journey();
const samples = [];
for (let batch = 0; batch < 5; batch++) samples.push(...await Promise.all(Array.from({ length: 4 }, journey)));
const percentile = (key, fraction) => samples.map((sample) => sample[key]).sort((a, b) => a - b)[Math.ceil(samples.length * fraction) - 1];
const status = await fetch(new URL("/_mapi/admin/status", origin), { headers: { authorization } }).then((response) => response.json());
console.log(JSON.stringify({ first, samples: samples.length, concurrency: 4, signInMedianMs: percentile("signInMs", .5), signInP95Ms: percentile("signInMs", .95), journeyP95Ms: percentile("journeyMs", .95), wasmMemoryBytes: status.wasmMemoryBytes }, null, 2));
