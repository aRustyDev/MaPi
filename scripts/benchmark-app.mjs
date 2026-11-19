import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { writeFile } from "node:fs/promises";

const base = process.env.MAPI_URL;
const operator = process.env.MAPI_OPERATOR_TOKEN;
if (!base || !operator) throw new Error("MAPI_URL and MAPI_OPERATOR_TOKEN are required");
const origin = new URL(base).origin;
const email = `load-${randomUUID()}@example.com`;
const password = `Example-${randomUUID()}!`;
const auth = { authorization: `Bearer ${operator}` };
const user = await fetch(new URL("/_mapi/admin/users", base), {
  method: "POST", headers: { ...auth, "content-type": "application/json" },
  body: JSON.stringify({ email, password }),
});
assert.equal(user.status, 200);
async function journey() {
  const started = performance.now();
  const login = await fetch(new URL("/login", base), {
    method: "POST", headers: { origin, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ email, password }), redirect: "manual",
  });
  assert.equal(login.status, 303);
  const signInMs = performance.now() - started;
  const cookie = login.headers.get("set-cookie")?.split(";", 1)[0];
  assert.ok(cookie);
  const session = await fetch(new URL("/app", base), { headers: { cookie }, redirect: "manual" });
  assert.equal(session.status, 200);
  const csrf = (await session.text()).match(/name="csrf" value="([A-Za-z0-9_-]+)"/)?.[1];
  assert.ok(csrf);
  const logout = await fetch(new URL("/logout", base), { method: "POST", headers: { cookie, origin }, body: new URLSearchParams({ csrf }), redirect: "manual" });
  assert.equal(logout.status, 303);
  return { signInMs, journeyMs: performance.now() - started };
}
const first = await journey();
const results = [];
for (let i = 0; i < 5; i++) results.push(...await Promise.all(Array.from({ length: 4 }, journey)));
const percentile = (field, p) => results.map((row) => row[field]).sort((a, b) => a - b)[Math.ceil(results.length * p) - 1];
const state = await fetch(new URL("/_mapi/admin/status", base), { headers: auth }).then((r) => r.json());
const output = { first, count: results.length, concurrency: 4, signInMedianMs: percentile("signInMs", .5), signInP95Ms: percentile("signInMs", .95), journeyMedianMs: percentile("journeyMs", .5), journeyP95Ms: percentile("journeyMs", .95), wasmMemoryBytes: state.wasmMemoryBytes };
await writeFile(".mapi/app-benchmark.json", JSON.stringify(output, null, 2));
console.log(JSON.stringify(output, null, 2));
