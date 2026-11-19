import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const base = process.env.MAPI_FLOW_URL;
if (!base) throw new Error("MAPI_FLOW_URL is required");
const fixture = JSON.parse(await readFile(".mapi/fixture.json", "utf8"));
let cookie = "";
async function request(method, path, body) {
  const response = await fetch(new URL(path, base), {
    method,
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const flowCookie = response.headers.getSetCookie().find((value) => value.startsWith("_zflow="));
  if (flowCookie) cookie = flowCookie.split(";", 1)[0];
  const data = await response.json();
  return { response, data };
}

let result = await request("POST", "/flows", { project_id: fixture.projectId, purpose: "login" });
assert.equal(result.response.status, 201);
assert.ok(cookie);
const read = await request("GET", `/flows/${encodeURIComponent(result.data.id)}`);
assert.equal(read.response.status, 200);
assert.equal(read.data.id, result.data.id);
const wrongID = await request("GET", "/flows/flow_wrong");
assert.ok(wrongID.response.status >= 400 && wrongID.response.status < 500);
const crossProject = await request("POST", "/flows", { project_id: fixture.otherProjectId, purpose: "login" });
assert.ok(crossProject.response.status >= 400);
result = await request("POST", "/flows", { project_id: fixture.projectId, purpose: "login" });
assert.equal(result.response.status, 201);
for (let hop = 0; hop < 6 && !result.data.handoff_token; hop++) {
  const fields = {};
  for (const field of result.data.step.fields ?? []) {
    const key = field.name.split(/[#/.]/).at(-1).toLowerCase();
    if (!(key in fixture.user)) throw new Error(`Unrecognized flow field ${field.name}`);
    fields[field.name] = fixture.user[key];
  }
  result = await request("POST", `/flows/${encodeURIComponent(result.data.id)}/submit`, {
    action: "submit", fields,
    ...(result.data.session_token ? { session_token: result.data.session_token } : {}),
  });
  assert.equal(result.response.status, 200);
}
assert.ok(result.data.handoff_token, "Password flow must return a handoff");
const exchange = await fetch(new URL(`/sessions/exchange?project_id=${encodeURIComponent(fixture.projectId)}`, base), {
  method: "POST",
  headers: { "content-type": "application/json", authorization: `Bearer ${fixture.projectSecret}` },
  body: JSON.stringify({ handoff_token: result.data.handoff_token }),
});
assert.equal(exchange.status, 200);
assert.ok(exchange.headers.getSetCookie().length);
console.log("Upstream flow and session exchange passed.");
