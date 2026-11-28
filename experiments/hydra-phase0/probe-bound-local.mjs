import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { Readable, Writable } from "node:stream";
import { pathToFileURL } from "node:url";
import { join, resolve } from "node:path";
import { runHydra } from "./runtime.mjs";

const [build, secrets, port] = process.argv.slice(2);
assert(build && secrets && /^\d+$/.test(port || ""));
await import(pathToFileURL(join(resolve(build), "wasm_exec.js")));
const module = await WebAssembly.compile(await readFile(join(build, "hydra-phase0.wasm")));
const entries = (await readFile(join(secrets, "local-postgres.env"), "utf8")).trim().split("\n").map(line => line.split("="));
const credentials = Object.fromEntries(entries);
const systemSecret = (await readFile(join(secrets, "local-hydra-system-secret"), "utf8")).trim();
const clientSecret = (await readFile(join(secrets, "local-hydra-client-secret"), "utf8")).trim();
const dsn = new URL("postgres://127.0.0.1/mapi_spike?sslmode=disable");
dsn.port = port; dsn.username = credentials.POSTGRES_USER; dsn.password = credentials.POSTGRES_PASSWORD;
const issuer = "https://hydra-phase0.invalid/oauth/project-1";
const identity = { issuer, projectId: "project-1", userId: "user-1", sessionId: "session-1" };
let linkedGrant, live = true, admits = 0, releases = 0;
const fence = {
  async admit(value, grant) {
    assert.deepEqual(value, identity);
    if (!live || grant !== linkedGrant) return null;
    admits++;
    return `attempt-${admits}`;
  },
  async release(value) { assert.deepEqual(value, identity); releases++; return live; },
};
function dial(host, socketPort) {
  assert.equal(host, "127.0.0.1");
  const socket = createConnection({ host, port: socketPort });
  socket.on("error", () => {});
  return { opened: new Promise((done, fail) => { socket.once("connect", done); socket.once("error", fail); }),
    readable: Readable.toWeb(socket), writable: Writable.toWeb(socket), close: () => socket.destroy() };
}
const cookies = new Map();
function header(response, name) {
  return Object.entries(response.headers || {}).find(([key]) => key.toLowerCase() === name)?.[1] || [];
}
async function call(method, path, body = "", headers = {}) {
  const cookie = [...cookies].map(([key, value]) => `${key}=${value}`).join("; ");
  const response = await runHydra({ module, dsn: dsn.href, issuer, systemSecret, dial, fence, verifiedBindings: true,
    input: { method, path, body, headers: { ...headers, ...(cookie ? { Cookie: [cookie] } : {}) } } });
  for (const value of header(response, "set-cookie")) {
    const [pair] = value.split(";");
    const pos = pair.indexOf("=");
    cookies.set(pair.slice(0, pos), pair.slice(pos + 1));
  }
  return response;
}
const location = response => {
  assert(response.status >= 300 && response.status < 400, "expected Hydra redirect");
  return new URL(header(response, "location")[0], issuer);
};
const discovery = await call("GET", "/.well-known/openid-configuration");
assert.equal(discovery.status, 200, "path-based issuer discovery");
assert.equal(JSON.parse(discovery.body).token_endpoint, `${issuer}/oauth2/token`);
async function admin(path, body) {
  const response = await call(body ? "PUT" : "GET", "/admin/oauth2/auth/requests/" + path,
    body ? JSON.stringify(body) : "", { "Content-Type": ["application/json"] });
  assert.equal(response.status, 200, "Hydra challenge request");
  return JSON.parse(response.body);
}
const verifier = randomBytes(48).toString("base64url");
const challenge = createHash("sha256").update(verifier).digest("base64url");
const redirect = "https://rp.example/callback";
const query = new URLSearchParams({ client_id: "mapi-bound-rp", redirect_uri: redirect, response_type: "code",
  scope: "openid offline_access", state: randomBytes(24).toString("base64url"), nonce: randomBytes(24).toString("base64url"), code_challenge: challenge, code_challenge_method: "S256" });
let next = location(await call("GET", "/oauth2/auth?" + query));
const login = next.searchParams.get("login_challenge");
assert(login, `expected login challenge; authorization error=${next.searchParams.get("error") || "none"}, description=${next.searchParams.get("error_description") || "none"}`);
await admin("login?login_challenge=" + login);
next = new URL((await admin("login/accept?login_challenge=" + login, { subject: identity.userId, remember: false })).redirect_to);
next = location(await call("GET", next.pathname.slice(new URL(issuer).pathname.length) + next.search));
const consent = next.searchParams.get("consent_challenge");
assert(consent);
const details = await admin("consent?consent_challenge=" + consent);
assert.equal(details.subject, identity.userId);
next = new URL((await admin("consent/accept?consent_challenge=" + consent, { grant_scope: details.requested_scope, remember: false })).redirect_to);
next = location(await call("GET", next.pathname.slice(new URL(issuer).pathname.length) + next.search));
assert.equal(next.origin, "https://rp.example");
const code = next.searchParams.get("code");
assert(code);
await assert.rejects(call("POST", "/mapi/bind-code", JSON.stringify({ ...identity, userId: "other", code })));
const bound = await call("POST", "/mapi/bind-code", JSON.stringify({ ...identity, code }));
assert.equal(bound.status, 200);
linkedGrant = bound.body;
const authorization = "Basic " + Buffer.from(`mapi-bound-rp:${clientSecret}`).toString("base64");
async function token(fields) {
  return call("POST", "/oauth2/token", new URLSearchParams(fields).toString(),
    { Authorization: [authorization], "Content-Type": ["application/x-www-form-urlencoded"] });
}
const exchanged = await token({ grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: redirect });
assert.equal(exchanged.status, 200, "bound authorization code exchange");
const tokens = JSON.parse(exchanged.body);
assert(tokens.access_token && tokens.refresh_token && tokens.id_token);
assert.equal(admits, 1); assert.equal(releases, 1);
const refresh = await token({ grant_type: "refresh_token", refresh_token: tokens.refresh_token });
assert.equal(refresh.status, 200, "bound refresh");
live = false;
assert((await token({ grant_type: "refresh_token", refresh_token: JSON.parse(refresh.body).refresh_token })).status >= 400, "revoked session rejected");
assert((await token({ grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: redirect })).status >= 400, "code replay rejected");
console.log("Verified identity binding, code exchange, replay rejection, refresh, and revoked-session denial against local Postgres.");
