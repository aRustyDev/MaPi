import assert from "node:assert/strict";
import { handleFlowProxy } from "../worker/flow-proxy.js";

const origin = "https://project.example";
const projectId = "proj_test";
let calls = 0;
let last;
const object = { async flowRequest(input) {
  calls++;
  last = input;
  return { status: 200, headers: { "content-type": ["application/json"], "set-cookie": ["_zflow=test; HttpOnly; Path=/", "session=test; HttpOnly; Path=/"] }, body: new TextEncoder().encode("{}").toBase64() };
} };
async function proxy(path, options = {}) {
  return handleFlowProxy(new Request(`${origin}${path}`, options), object, projectId, origin);
}
let response = await proxy("/__nextgen/flows", { method: "POST", headers: { origin, "content-type": "application/json", authorization: "Bearer attacker" }, body: JSON.stringify({ project_id: projectId }) });
assert.equal(response.status, 200);
assert.equal(new URL(last.url).pathname, "/api/v1/flows");
assert.equal(last.headers.authorization, undefined);
assert.equal(response.headers.getSetCookie().length, 2);
assert.equal(response.headers.get("cache-control"), "no-store");
response = await proxy("/__nextgen/api/v1/flows/flow_ABC");
assert.equal(response.status, 200);
response = await proxy("/__nextgen/sessions/exchange?project_id=proj_test", { method: "POST", headers: { origin }, body: "{}" });
assert.equal(response.status, 200);
assert.equal(new URL(last.url).pathname, "/api/v1/sessions/exchange");
const before = calls;
assert.equal((await proxy("/__nextgen/flows", { method: "POST", headers: { origin: "https://evil.example" }, body: "{}" })).status, 403);
assert.equal((await proxy("/__nextgen/flows", { method: "POST", headers: { origin }, body: JSON.stringify({ project_id: "proj_other" }) })).status, 403);
assert.equal((await proxy("/__nextgen/sessions/exchange?project_id=proj_other", { method: "POST", headers: { origin }, body: "{}" })).status, 403);
assert.equal((await proxy("/__nextgen/sessions/exchange?project_id=proj_test&project_id=proj_test", { method: "POST", headers: { origin }, body: "{}" })).status, 403);
assert.equal((await proxy("/__nextgen/users", { method: "POST", headers: { origin }, body: "{}" })).status, 404);
assert.equal((await proxy("/__nextgen/flows", { method: "POST", headers: { origin }, body: "x".repeat(65_537) })).status, 413);
assert.equal(calls, before);
console.log("Flow proxy tests passed.");
