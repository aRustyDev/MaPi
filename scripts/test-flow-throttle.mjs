import assert from "node:assert/strict";

const base = process.env.MAPI_URL;
const token = process.env.MAPI_OPERATOR_TOKEN;
if (!base || !token) throw new Error("MAPI_URL and MAPI_OPERATOR_TOKEN are required");
const origin = new URL(base).origin;
const init = await fetch(new URL("/_mapi/admin/init", origin), {
  method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  body: JSON.stringify({ name: "Throttle test" }),
});
assert.equal(init.status, 200);
async function submit(fromOrigin) {
  return fetch(new URL("/__nextgen/flows/flow_missing/submit", origin), {
    method: "POST", headers: { origin: fromOrigin, "content-type": "application/json" }, body: "{}",
  });
}
for (let i = 0; i < 65; i++) assert.equal((await submit("https://attacker.invalid")).status, 403);
for (let i = 0; i < 60; i++) assert.notEqual((await submit(origin)).status, 429);
assert.equal((await submit(origin)).status, 429);
console.log("Flow throttle rejects cross-origin requests without charging the budget and limits same-origin submissions.");
