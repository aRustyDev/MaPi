import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";

const base = process.env.MAPI_URL;
const operator = process.env.MAPI_OPERATOR_TOKEN;
if (!base || !operator) throw new Error("MAPI_URL and MAPI_OPERATOR_TOKEN are required");
const origin = process.env.MAPI_APP_ORIGIN ?? new URL(base).origin;
const statePath = ".mapi/app-deployment-check.json";
async function send(path, options = {}) { return fetch(new URL(path, base), { ...options, redirect: "manual" }); }
if (process.argv[2] === "prepare") {
  const email = `deploy-${randomUUID()}@example.com`;
  const password = `Example-${randomUUID()}!`;
  const user = await send("/_mapi/admin/users", { method: "POST", headers: { authorization: `Bearer ${operator}`, "content-type": "application/json" }, body: JSON.stringify({ email, password }) });
  assert.equal(user.status, 200);
  async function login() {
    const response = await send("/login", { method: "POST", headers: { origin }, body: new URLSearchParams({ email, password }) });
    assert.equal(response.status, 303);
    const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
    assert.ok(cookie);
    return cookie;
  }
  const active = await login();
  const revoked = await login();
  const page = await send("/app", { headers: { cookie: revoked } });
  const csrf = (await page.text()).match(/name="csrf" value="([A-Za-z0-9_-]+)"/)?.[1];
  assert.ok(csrf);
  assert.equal((await send("/logout", { method: "POST", headers: { origin, cookie: revoked }, body: new URLSearchParams({ csrf }) })).status, 303);
  await writeFile(statePath, JSON.stringify({ active, revoked }), { mode: 0o600 });
  console.log("Prepared active and revoked sessions.");
} else if (process.argv[2] === "verify") {
  const state = JSON.parse(await readFile(statePath, "utf8"));
  assert.equal((await send("/app", { headers: { cookie: state.active } })).status, 200);
  assert.equal((await send("/app", { headers: { cookie: state.revoked } })).status, 303);
  console.log("Active and revoked sessions survived deployment.");
} else if (process.argv[2] === "clean") {
  await rm(statePath, { force: true });
} else throw new Error("Use prepare, verify, or clean");
