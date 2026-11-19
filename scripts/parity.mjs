import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";

export function client(baseUrl, fixture, gate) {
  const project = "?project_id=" + encodeURIComponent(fixture.projectId);
  const secret = fixture.projectSecret;
  const wire = [];
  async function send(method, path, { body, token = secret, cookie } = {}) {
    const headers = new Headers({ accept: "application/json" });
    if (body !== undefined) headers.set("content-type", "application/json");
    if (token) headers.set("authorization", "Bearer " + token);
    if (cookie) headers.set("cookie", cookie);
    if (gate) headers.set("x-mapi-test-key", gate);
    const response = await fetch(new URL(path, baseUrl), { method, headers, body: JSON.stringify(body) });
    const responseText = await response.text();
    let data;
    try { data = responseText ? JSON.parse(responseText) : null; }
    catch { throw new Error(method + " " + path + " returned non-JSON, HTTP " + response.status); }
    return { status: response.status, data, headers: response.headers };
  }
  function record(result) {
    const entry = { status: result.status };
    if (result.status >= 400 && result.data?.code) entry.code = result.data.code;
    if (result.data !== null) entry.fields = Object.keys(result.data).sort();
    if (result.data?.session) entry.sessionFields = Object.keys(result.data.session).sort();
    wire.push(entry);
    return result;
  }
  function ok(result) {
    assert.ok(result.status >= 200 && result.status < 300,
      "Expected success, got " + result.status + " " + (result.data?.code ?? ""));
    return result.data;
  }
  async function start() {
    const result = record(await send("POST", "/auth_attempts", { body: { project_id: fixture.projectId } }));
    const id = ok(result).attempt_id;
    assert.ok(id);
    return id;
  }
  async function proof(attempt, method, body) {
    const path = "/auth_attempts/" + attempt + "/challenges";
    const challenge = ok(record(await send("POST", path, { body: { method } })));
    assert.ok(challenge.challenge_id);
    return record(await send("POST", path + "/" + challenge.challenge_id + "/verify", { body }));
  }
  async function attempt(password = fixture.user.password) {
    const id = await start();
    ok(await proof(id, "identifier", { login_name: fixture.user.email }));
    return { id, passwordResult: await proof(id, "password", { password }) };
  }
  async function handoff(id) {
    return record(await send("POST", "/auth_attempts/" + id + "/handoff"));
  }
  async function mint() {
    const { id, passwordResult } = await attempt();
    ok(passwordResult);
    const token = ok(await handoff(id)).handoff_token;
    assert.ok(token);
    return token;
  }
  const exchange = (token, ttl) => send("POST", "/sessions/exchange" + project,
    { body: { handoff_token: token, ...(ttl ? { ttl } : {}) } });
  const read = (session) => send("GET", "/sessions/me" + project,
    { token: null, cookie: session.cookie });
  const revoke = (session) => send("DELETE", "/sessions/" + session.id);
  function session(result) {
    const data = ok(result);
    const cookie = result.headers.getSetCookie()[0]?.split(";", 1)[0];
    assert.ok(cookie, "Session exchange must send a session cookie");
    assert.equal(data.session.user_id, fixture.user.id);
    return { id: data.session.session_id, cookie };
  }
  return { wire, record, ok, send, start, proof, attempt, handoff, mint, exchange, read, revoke, session };
}

export async function runParity(baseUrl, fixture, { gate, expireHandoff, expireSession, beforeConcurrentExchange } = {}) {
  const api = client(baseUrl, fixture, gate);
  const rejects = (result) => assert.ok(result.status >= 400 && result.status < 500,
    "Expected rejection, got " + result.status + " " + (result.data?.code ?? ""));
  const started = performance.now();
  const session = api.session(api.record(await api.exchange(await api.mint())));
  const signInMs = performance.now() - started;
  api.ok(api.record(await api.read(session)));

  const incomplete = await api.start();
  api.ok(await api.proof(incomplete, "identifier", { login_name: fixture.user.email }));
  rejects(await api.handoff(incomplete));

  const wrong = await api.attempt(fixture.user.password + "-wrong");
  rejects(await api.handoff(wrong.id));
  assert.ok(wrong.passwordResult.status < 500);

  const mismatch = api.record(await api.send("POST", "/auth_attempts", {
    body: { project_id: fixture.projectId }, token: fixture.otherProjectSecret,
  }));
  rejects(mismatch);

  const token = await api.mint();
  await beforeConcurrentExchange?.(api, token);
  const results = await Promise.all(Array.from({ length: 10 }, () => api.exchange(token)));
  const winners = results.filter(({ status }) => status === 200);
  assert.equal(winners.length, 1, "Exactly one handoff exchange succeeds");
  const active = api.session(winners[0]);
  for (const failed of results.filter(({ status }) => status !== 200)) rejects(failed);
  api.record(results.find(({ status }) => status !== 200));

  if (expireHandoff) {
    const expired = await api.mint();
    await expireHandoff(expired);
    rejects(api.record(await api.exchange(expired)));
  }
  if (expireSession) {
    const expired = api.session(await api.exchange(await api.mint()));
    await expireSession(expired.id);
    assert.equal(api.record(await api.read(expired)).status, 401);
  }
  assert.equal(api.record(await api.revoke(session)).status, 204);
  assert.equal(api.record(await api.read(session)).status, 401);
  api.ok(await api.read(active));
  return { wire: api.wire, signInMs, active, revoked: session };
}
