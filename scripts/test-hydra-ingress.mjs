import test from "node:test";
import assert from "node:assert/strict";
import { handleHydraIngress, isHydraRoute } from "../worker/hydra-ingress.js";

const origin = "https://issuer.example";
const route = { origin, projectId: "project-1", objectName: "owner", generation: 1 };
const issuer = `${origin}/oauth/${route.projectId}`;
const identity = { issuer, projectId: route.projectId, userId: "user-1", sessionId: "session-1" };
const requestURL = `${issuer}/oauth2/auth?redirect_uri=${encodeURIComponent("https://rp.example/callback")}`;

function fixture(overrides = {}) {
  const calls = [];
  const object = {
    async session(cookie, action) {
      assert.equal(cookie, "session=private");
      return action === "read" ? { status: 200, data: { project_id: route.projectId, user_id: identity.userId, session_id: identity.sessionId } } :
        { status: 200, data: { csrf_token: "csrf-1" } };
    },
    async admitLogin() { return true; },
    ...overrides.object,
  };
  const worker = {
    async fetch(request) { calls.push(["fetch", new URL(request.url).pathname]); return new Response(null, { status: 302, headers: { location: "https://rp.example/callback?code=signed.code&state=state" } }); },
    async bindCode(value, code) { calls.push(["bind", value, code]); return true; },
    async admin(method, path, body) {
      calls.push(["admin", method, path, body]);
      if (method === "GET") return { status: 200, body: JSON.stringify({ subject: identity.userId, requested_scope: ["openid", "profile"], request_url: requestURL }) };
      return { status: 200, body: JSON.stringify({ redirect_to: `${issuer}/oauth2/auth?resume=1` }) };
    },
    ...overrides.worker,
  };
  return { calls, object, env: { HYDRA_ISSUER: issuer, HYDRA_ISSUER_WORKER: worker } };
}

function req(path, options = {}) {
  const headers = new Headers(options.headers);
  headers.set("cookie", "session=private");
  return new Request(issuer + path, { ...options, headers });
}

test("discovery endpoints and exact method routing", () => {
  for (const [method, path] of [["GET", "/oauth2/auth"], ["POST", "/oauth2/token"], ["GET", "/.well-known/jwks.json"], ["GET", "/.well-known/openid-configuration"]]) {
    assert.equal(isHydraRoute(method, `/oauth/project-1${path}`, route.projectId), true);
    assert.equal(isHydraRoute("DELETE", `/oauth/project-1${path}`, route.projectId), false);
  }
  assert.equal(isHydraRoute("GET", "/oauth/other/oauth2/auth", route.projectId), false);
});

test("authorization code is released only after verified binding", async () => {
  const f = fixture();
  const response = await handleHydraIngress(req("/oauth2/auth"), f.env, f.object, route);
  assert.equal(response.status, 302);
  assert.deepEqual(f.calls, [["fetch", "/oauth2/auth"], ["bind", identity, "signed.code"]]);
  const denied = fixture({ worker: { async bindCode() { return false; } } });
  const failed = await handleHydraIngress(req("/oauth2/auth"), denied.env, denied.object, route);
  assert.equal(failed.status, 503);
  assert.equal(failed.headers.get("location"), null);
});

test("consent checks subject and renders scopes and CSRF", async () => {
  const f = fixture();
  const response = await handleHydraIngress(req("/phase0/consent?consent_challenge=abc"), f.env, f.object, route);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /Allow openid, profile/);
  assert.match(response.headers.get("content-security-policy"), /https:\/\/rp\.example/);
  const foreign = fixture({ worker: { async admin() { return { status: 200, body: JSON.stringify({ subject: "other", requested_scope: ["openid"], request_url: requestURL }) }; } } });
  assert.equal((await handleHydraIngress(req("/phase0/consent?consent_challenge=abc"), foreign.env, foreign.object, route)).status, 403);
});

test("accepts Hydra-sized encrypted login challenges", async () => {
  const f = fixture();
  const challenge = "a".repeat(1298) + "==";
  const loginRoute = { ...route, projectId: "proj_1" };
  const loginIssuer = `${origin}/oauth/${loginRoute.projectId}`;
  const response = await handleHydraIngress(new Request(`${loginIssuer}/phase0/login?login_challenge=${challenge}`), { ...f.env, HYDRA_ISSUER: loginIssuer }, f.object, loginRoute);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /phase0\/continue\?challenge=/);
});

test("consent requires same origin, a single challenge and valid CSRF", async () => {
  const f = fixture();
  const post = (body, originHeader = origin) => req("/phase0/consent", { method: "POST", headers: { origin: originHeader, "content-type": "application/x-www-form-urlencoded" }, body });
  assert.equal((await handleHydraIngress(post("challenge=abc&csrf=csrf-1", "https://evil.example"), f.env, f.object, route)).status, 403);
  assert.equal((await handleHydraIngress(post("challenge=abc&challenge=def&csrf=csrf-1"), f.env, f.object, route)).status, 403);
  assert.equal((await handleHydraIngress(post("challenge=abc&csrf=wrong"), f.env, f.object, route)).status, 403);
  assert.equal(f.calls.length, 0);
  const accepted = await handleHydraIngress(post("challenge=abc&csrf=csrf-1"), f.env, f.object, route);
  assert.equal(accepted.status, 303);
  assert.equal(accepted.headers.get("location"), `${issuer}/authorize?resume=1`);
  assert.deepEqual(JSON.parse(f.calls.at(-1)[3]), { grant_scope: ["openid", "profile"], remember: false });
});

test("unavailable or wrong-project sessions fail closed", async () => {
  const f = fixture({ object: { async session() { return { status: 200, data: { project_id: "other", user_id: "user-1", session_id: "session-1" } }; } } });
  const response = await handleHydraIngress(req("/oauth2/auth"), f.env, f.object, route);
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("location"), null);
  assert.equal(f.calls.some(call => call[0] === "bind"), false);
});
