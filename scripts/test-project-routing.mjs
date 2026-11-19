import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import http from "node:http";

const address = new URL(process.env.MAPI_URL ?? "http://127.0.0.1:8811");
const operator = process.env.MAPI_OPERATOR_TOKEN;
if (!operator || address.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]"].includes(address.hostname)) {
  throw new Error("A local MAPI_URL and MAPI_OPERATOR_TOKEN are required");
}
const primary = process.env.MAPI_APP_ORIGIN ?? `http://localhost:${address.port}`;
const secondary = `http://localhost:${Number(address.port) + 1}`;
const email = `routing-${randomUUID()}@example.com`;
const passwordA = `A-${randomUUID()}!`;
const passwordB = `B-${randomUUID()}!`;

function request(origin, path, { method = "GET", body, authorization = operator, form = false, cookie } = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(origin);
    const headers = { host: target.host };
    if (authorization) headers.authorization = `Bearer ${authorization}`;
    if (cookie) headers.cookie = cookie;
    if (body) headers["content-type"] = form ? "application/x-www-form-urlencoded" : "application/json";
    if (form) headers.origin = origin;
    const req = http.request({ hostname: address.hostname, port: address.port, path, method, headers }, (response) => {
      let text = "";
      response.on("data", (chunk) => { text += chunk; });
      response.on("end", () => resolve({ status: response.statusCode, body: text, headers: response.headers }));
    });
    req.on("error", reject);
    if (body) req.write(form ? new URLSearchParams(body).toString() : JSON.stringify(body));
    req.end();
  });
}

const init = await request(primary, "/_mapi/admin/init", { method: "POST", body: { name: "Primary routing test" } });
assert.equal(init.status, 200);
const primaryId = JSON.parse(init.body).projectId;
const create = () => request(primary, "/_mapi/admin/projects", { method: "POST", body: { name: "Secondary routing test", origin: secondary } });
const created = await Promise.all(Array.from({ length: 3 }, create));
assert.ok(created.every((result) => result.status === 200));
const ids = created.map((result) => JSON.parse(result.body).projectId);
assert.equal(new Set(ids).size, 1);
assert.notEqual(ids[0], primaryId);
for (const [origin, password] of [[primary, passwordA], [secondary, passwordB]]) {
  assert.equal((await request(origin, "/_mapi/admin/users", { method: "POST", body: { email, password } })).status, 200);
}
const first = await request(primary, "/login", { method: "POST", body: { email, password: passwordA }, authorization: "", form: true });
const second = await request(secondary, "/login", { method: "POST", body: { email, password: passwordB }, authorization: "", form: true });
assert.equal(first.status, 303);
assert.equal(second.status, 303);
const cookieA = first.headers["set-cookie"]?.[0]?.split(";", 1)[0];
const cookieB = second.headers["set-cookie"]?.[0]?.split(";", 1)[0];
assert.ok(cookieA && cookieB);
assert.equal((await request(primary, "/app", { authorization: "", cookie: cookieA })).status, 200);
assert.equal((await request(secondary, "/app", { authorization: "", cookie: cookieB })).status, 200);
assert.equal((await request(primary, "/app", { authorization: "", cookie: cookieB })).status, 303);
assert.equal((await request(secondary, "/app", { authorization: "", cookie: cookieA })).status, 303);
for (const [origin, password] of [[primary, passwordB], [secondary, passwordA]]) {
  assert.equal((await request(origin, "/login", { method: "POST", body: { email, password }, authorization: "", form: true })).status, 401);
}
assert.equal((await request(secondary, "/_mapi/admin/status", { authorization: "incorrect" })).status, 404);
console.log("Two projects provisioned concurrently with isolated password authentication.");
