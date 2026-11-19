import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { performance } from "node:perf_hooks";

const base = process.env.MAPI_URL;
const operator = process.env.MAPI_OPERATOR_TOKEN;
if (!base || !operator || !process.env.CLOUDFLARE_ACCOUNT_ID) throw new Error("MAPI_URL, MAPI_OPERATOR_TOKEN and CLOUDFLARE_ACCOUNT_ID are required");
const email = `cold-${randomUUID()}@example.com`;
const password = `Example-${randomUUID()}!`;
const user = await fetch(new URL("/_mapi/admin/users", base), { method: "POST", headers: { authorization: `Bearer ${operator}`, "content-type": "application/json" }, body: JSON.stringify({ email, password }) });
assert.equal(user.status, 200);
execFileSync("npx", ["wrangler", "deploy", "--config", "wrangler.app.jsonc", "--env", "staging"], { stdio: "inherit" });
const before = await fetch(new URL("/_mapi/admin/status", base), { headers: { authorization: `Bearer ${operator}` } }).then((r) => r.json());
assert.equal(before.wasmMemoryBytes, 0, "Expected an uninitialized reactor after deployment");
const started = performance.now();
const login = await fetch(new URL("/login", base), { method: "POST", headers: { origin: new URL(base).origin }, body: new URLSearchParams({ email, password }), redirect: "manual" });
assert.equal(login.status, 303);
console.log(JSON.stringify({ coldSignInMs: performance.now() - started }));
