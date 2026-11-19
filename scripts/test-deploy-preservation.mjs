import assert from "node:assert/strict";
import { readFile, writeFile, rm } from "node:fs/promises";

const base = process.env.MAPI_URL, userFile = process.env.MAPI_TEST_USER_FILE, stateFile = process.env.MAPI_TEST_STATE_FILE;
if (!base || !userFile || !stateFile || !["prepare", "verify"].includes(process.argv[2])) throw new Error("Set MAPI_URL, MAPI_TEST_USER_FILE and MAPI_TEST_STATE_FILE; pass prepare or verify");
const origin = new URL(base).origin;
async function readSession(cookie) { return fetch(new URL("/app", origin), { headers: { cookie }, redirect: "manual" }); }
async function logout(cookie) {
  const page = await readSession(cookie); assert.equal(page.status, 200);
  const csrf = (await page.text()).match(/name="csrf" value="([A-Za-z0-9_-]+)"/)?.[1]; assert.ok(csrf);
  const response = await fetch(new URL("/logout", origin), { method: "POST", headers: { origin, cookie }, body: new URLSearchParams({ csrf }), redirect: "manual" });
  assert.equal(response.status, 303);
}
if (process.argv[2] === "prepare") {
  const user = JSON.parse(await readFile(userFile, "utf8"));
  async function createSession() {
    let flowCookie = "";
    async function flow(path, body) {
      const response = await fetch(new URL(`/__nextgen${path}`, origin), { method: "POST", headers: { origin, "content-type": "application/json", ...(flowCookie ? { cookie: flowCookie } : {}) }, body: JSON.stringify(body) });
      assert.ok(response.ok, `Flow HTTP ${response.status}`);
      const cookie = response.headers.getSetCookie().find((value) => value.startsWith("_zflow="));
      if (cookie) flowCookie = cookie.split(";", 1)[0];
      return response.json();
    }
    let result = await flow("/flows", { project_id: user.projectId, purpose: "login" });
    for (let hop = 0; hop < 6 && !result.handoff_token; hop++) {
      const fields = {};
      for (const field of result.step.fields ?? []) {
        const name = field.name.split(/[#/.]/).at(-1).toLowerCase();
        if (["email", "identifier", "login_name"].includes(name)) fields[field.name] = user.email;
        else if (name === "password") fields[field.name] = user.password;
        else throw new Error(`Unexpected flow field ${field.name}`);
      }
      result = await flow(`/flows/${encodeURIComponent(result.id)}/submit`, { action: "submit", fields, ...(result.session_token ? { session_token: result.session_token } : {}) });
    }
    assert.ok(result.handoff_token);
    const exchange = await fetch(new URL(`/__nextgen/sessions/exchange?project_id=${encodeURIComponent(user.projectId)}`, origin), { method: "POST", headers: { origin, "content-type": "application/json", cookie: flowCookie }, body: JSON.stringify({ handoff_token: result.handoff_token }) });
    assert.equal(exchange.status, 200);
    const cookie = exchange.headers.getSetCookie().find((value) => value.startsWith("__Host-zitadel_session="))?.split(";", 1)[0]; assert.ok(cookie);
    return cookie;
  }
  const active = await createSession(), revoked = await createSession();
  await logout(revoked);
  assert.equal((await readSession(revoked)).status, 303);
  await writeFile(stateFile, JSON.stringify({ active, revoked }), { mode: 0o600, flag: "wx" });
  console.log("Prepared one active and one revoked synthetic session.");
} else {
  const { active, revoked } = JSON.parse(await readFile(stateFile, "utf8"));
  assert.equal((await readSession(active)).status, 200, "Active session must survive deployment");
  assert.equal((await readSession(revoked)).status, 303, "Revoked session must remain rejected");
  await logout(active);
  assert.equal((await readSession(active)).status, 303);
  await rm(stateFile);
  console.log("Active and revoked sessions survived deployment with the correct state.");
}
