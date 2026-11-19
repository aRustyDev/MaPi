import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

const base = process.env.MAPI_URL ?? "http://localhost:8799";
const origin = process.env.MAPI_APP_ORIGIN ?? new URL(base).origin;
const operator = process.env.MAPI_OPERATOR_TOKEN;
if (!operator) throw new Error("MAPI_OPERATOR_TOKEN is required");
const auth = { authorization: `Bearer ${operator}` };
const email = `test-${randomUUID()}@example.com`;
const password = `Example-${randomUUID()}!`;
async function send(path, { method = "GET", headers = {}, body } = {}) {
  return fetch(new URL(path, base), { method, headers, body, redirect: "manual" });
}
async function admin(path, data) {
  return send(path, { method: data ? "POST" : "GET", headers: { ...auth, "content-type": "application/json" }, body: data ? JSON.stringify(data) : undefined });
}
assert.equal((await send("/_mapi/admin/status")).status, 404);
if (process.env.MAPI_TEST_FRESH === "1") {
  const before = await admin("/_mapi/admin/status");
  assert.equal((await before.json()).ready, false);
  const emptyCounts = await (await admin("/_mapi/admin/test/counts")).json();
  for (let position = 1; position <= 7; position++) {
    const fault = await send("/_mapi/admin/test/fail-audit", { method: "POST", headers: auth, body: JSON.stringify({ after: position }) });
    assert.equal(fault.status, 204);
    assert.equal((await admin("/_mapi/admin/init", { name: "MaPi prototype" })).status, 503);
    const after = await admin("/_mapi/admin/status");
    assert.equal((await after.json()).ready, false);
    assert.deepEqual(await (await admin("/_mapi/admin/test/counts")).json(), emptyCounts);
  }
}
const init = await admin("/_mapi/admin/init", { name: "MaPi prototype" });
assert.equal(init.status, 200);
const firstProject = (await init.json()).projectId;
const retry = await admin("/_mapi/admin/init", { name: "MaPi prototype" });
assert.equal((await retry.json()).projectId, firstProject);
assert.equal((await admin("/_mapi/admin/status")).status, 200);
if (process.env.MAPI_LOCAL_TEST === "1") {
  const counts = await (await admin("/_mapi/admin/test/counts")).json();
  const fault = await send("/_mapi/admin/test/fail-audit", { method: "POST", headers: auth });
  assert.equal(fault.status, 204);
  assert.equal((await admin("/_mapi/admin/users", { email, password })).status, 400);
  assert.deepEqual(await (await admin("/_mapi/admin/test/counts")).json(), counts);
}
assert.equal((await admin("/_mapi/admin/users", { email, password })).status, 200);
assert.equal((await admin("/_mapi/admin/users", { email, password: `changed-${password}` })).status, 409);
const form = (candidate) => new URLSearchParams({ email, password: candidate });
const loginHeaders = { origin, "content-type": "application/x-www-form-urlencoded" };
assert.equal((await send("/login", { method: "POST", headers: { ...loginHeaders, origin: "https://foreign.example" }, body: form(password) })).status, 403);
const wrong = await send("/login", { method: "POST", headers: loginHeaders, body: form("wrong") });
assert.equal(wrong.status, 401);
const unknown = await send("/login", { method: "POST", headers: loginHeaders, body: new URLSearchParams({ email: `unknown-${randomUUID()}@example.com`, password }) });
assert.equal(unknown.status, 401);
assert.equal(await wrong.text(), await unknown.text());
const login = await send("/login", { method: "POST", headers: loginHeaders, body: form(password) });
assert.equal(login.status, 303);
const cookie = login.headers.get("set-cookie")?.split(";", 1)[0];
assert.ok(cookie);
if (process.env.MAPI_LOCAL_TEST === "1") {
  assert.equal((await send("/_mapi/admin/test/evict", { method: "POST", headers: auth })).status, 500);
}
const protectedPage = await send("/app", { headers: { cookie } });
assert.equal(protectedPage.status, 200);
const csrf = (await protectedPage.text()).match(/name="csrf" value="([A-Za-z0-9_-]+)"/)?.[1];
assert.ok(csrf);
assert.equal((await send("/logout", { method: "POST", headers: { cookie, origin: "https://foreign.example" } })).status, 403);
assert.equal((await send("/logout", { method: "POST", headers: { cookie, origin } })).status, 403);
assert.equal((await send("/logout", { method: "POST", headers: { cookie, origin }, body: new URLSearchParams({ csrf: "invalid" }) })).status, 403);
assert.equal((await send("/logout", { method: "POST", headers: { cookie, origin }, body: new URLSearchParams({ csrf }) })).status, 303);
if (process.env.MAPI_LOCAL_TEST === "1") {
  assert.equal((await send("/_mapi/admin/test/evict", { method: "POST", headers: auth })).status, 500);
}
const replay = await send("/app", { headers: { cookie } });
assert.equal(replay.status, 303);
assert.equal(replay.headers.get("location"), "/login");
if (process.env.MAPI_LOCAL_TEST === "1") {
  const recovery = await admin("/_mapi/admin/test/recovery", { email, password });
  assert.equal(recovery.status, 200);
  assert.ok((await recovery.json()).status >= 400, "Recovery must expire an outstanding handoff");
}
console.log("Application provisioning, sign-in and revocation checks passed.");
