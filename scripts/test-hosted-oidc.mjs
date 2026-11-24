// A loopback relying party tests the isolated staging issuer without sending
// credentials or authorization codes to any third-party backend.
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID, X509Certificate } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { once } from "node:events";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright";
import { assertRpCallback } from "./phase1-rp-callback.mjs";
import { assertRpClaims } from "./phase1-rp-claims.mjs";
import { parseRpIdToken, assertRpIdTokenSignature } from "./phase1-rp-token.mjs";
import { benchmarkExpectedIdentity } from "./phase1-benchmark-identity.mjs";
import { assertRuntimeStatus, classifyJourneyFailure } from "./phase1-benchmark-report.mjs";
import { assertExpectedReplay, rpFailure, rpFetch } from "./phase1-rp-evidence.mjs";
import { drainBounded, jsonBounded } from "./rehearsal-body.mjs";
import { requireBenchmarkProvenance } from "./phase1-benchmark-provenance.mjs";
import { requestFailure, requestJson } from "./phase1-request.mjs";
import { createRpOperations } from "./phase1-rp-operations.mjs";
import { hostedOrigin } from "./phase1-urls.mjs";
import { observeBrowser } from "./phase1-browser-observation.mjs";
import { beginObservedWave } from "./phase1-wave-start.mjs";
import { classifyFlowSubmission } from "../worker/flow-diagnostics.js";

const base = process.env.MAPI_URL;
const operator = process.env.MAPI_OPERATOR_TOKEN;
if (!base || !operator || !process.env.MAPI_TEST_USER_FILE) throw new Error("MAPI_URL, MAPI_OPERATOR_TOKEN and MAPI_TEST_USER_FILE are required");
// Standalone use also registers a client and therefore requires provenance.
await requireBenchmarkProvenance();
const origin = hostedOrigin(base);
let user;
try { user = JSON.parse(await readFile(process.env.MAPI_TEST_USER_FILE, "utf8")); }
catch { throw new Error("Invalid hosted user fixture"); }
const expectedUserId = benchmarkExpectedIdentity(user, process.env);
const adminHeaders = { authorization: `Bearer ${operator}`, "content-type": "application/json" };
async function admin(path, body) {
  const operation = path.endsWith('/init') ? 'oidc-init' : 'oidc-client';
  return requestJson(new URL(path, origin), { method: "POST", headers: adminHeaders, body: JSON.stringify(body) }, { operation, expectedStatus: 200 });
}
const temp = await mkdtemp(resolve(tmpdir(), "mapi-hosted-rp-"));
let rp, browser;
try {
  const keyPath = resolve(temp, "key.pem"), certPath = resolve(temp, "cert.pem");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", keyPath, "-out", certPath, "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1"], { stdio: "ignore" });
  const cert = await readFile(certPath), key = await readFile(keyPath);
  const spki = createHash("sha256").update(new X509Certificate(cert).publicKey.export({ type: "spki", format: "der" })).digest("base64");
  let callback, client, replays = 0, replayAttempts = 0;
  const transactions = new Map();
  const rpOperations = createRpOperations();
  const timings = new Map();
  rp = createServer({ cert, key }, async (req, res) => {
    let state = null, rpStage = 'callback', rpSignal = null, nodeTimeout = null, rpStatus = null;
    try {
      const url = new URL(req.url, callback);
      if (url.pathname === "/start") {
        const state = url.searchParams.get('state'), nonce = randomBytes(24).toString("base64url"), verifier = randomBytes(48).toString("base64url");
        if (!state || !rpOperations.canStart(state) || transactions.has(state)) throw new Error('Invalid RP state');
        transactions.set(state, { nonce, verifier });
        const params = new URLSearchParams({ client_id: client.id, redirect_uri: `${callback}/callback`, response_type: "code", scope: "openid", state, nonce, code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256" });
        res.writeHead(302, { location: `${origin}/oauth/${user.projectId}/authorize?${params}` }); res.end(); return;
      }
      state = url.searchParams.get("state");
      const code = url.searchParams.get("code"), tx = transactions.get(state);
      if (url.pathname !== "/callback" || !tx || !code) throw new Error("Invalid RP callback");
      transactions.delete(state);
      rpSignal = rpOperations.begin(state);
      const body = new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: `${callback}/callback`, code_verifier: tx.verifier });
      const headers = { "content-type": "application/x-www-form-urlencoded", authorization: `Basic ${Buffer.from(`${encodeURIComponent(client.id)}:${encodeURIComponent(client.secret)}`).toString("base64")}` };
      rpStage = 'token';
      const tokenController = new AbortController();
      nodeTimeout = AbortSignal.timeout(60000);
      const token = await rpFetch(`${origin}/oauth/${user.projectId}/token`, { method: "POST", headers, body, signal: AbortSignal.any([tokenController.signal, nodeTimeout, rpSignal]) }, 'token');
      rpStatus = token.status;
      if (!token.ok) { await drainBounded(token, tokenController); throw rpFailure('token', token.status, 'http'); }
      const result = await jsonBounded(token, tokenController);
      const parsedToken = parseRpIdToken(result.id_token);
      rpStage = 'jwks';
      rpStatus = null;
      const jwksController = new AbortController();
      nodeTimeout = AbortSignal.timeout(60000);
      const jwks = await rpFetch(`${origin}/oauth/${user.projectId}/jwks`, { signal: AbortSignal.any([jwksController.signal, nodeTimeout, rpSignal]) }, 'jwks');
      rpStatus = jwks.status;
      if (!jwks.ok) { await drainBounded(jwks, jwksController); throw rpFailure('jwks', jwks.status, 'http'); }
      const keys = (await jsonBounded(jwks, jwksController)).keys;
      rpStage = 'claims';
      rpStatus = null;
      assertRpIdTokenSignature(parsedToken, keys);
      assertRpClaims(parsedToken.claims, { origin, projectId: user.projectId, nonce: tx.nonce, clientId: client.id, expectedUserId });
      rpStage = 'replay'; replayAttempts++;
      rpStatus = null;
      const replayController = new AbortController();
      nodeTimeout = AbortSignal.timeout(60000);
      const replay = await rpFetch(`${origin}/oauth/${user.projectId}/token`, { method: "POST", headers, body, signal: AbortSignal.any([replayController.signal, nodeTimeout, rpSignal]) }, 'replay');
      rpStatus = replay.status;
      await assertExpectedReplay(replay, replayController);
      replays++;
      rpOperations.complete(state);
      res.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" }); res.end("<!doctype html><h1>Authenticated by the independent RP</h1>");
    } catch (error) {
      const kind = rpSignal?.aborted ? (rpSignal.reason === 'timeout' ? 'timeout' : 'aborted') : nodeTimeout?.aborted ? 'timeout' : error?.phase1RpFailure?.kind ?? 'internal';
      const failure = { stage: rpStage, kind, status: error?.phase1RpFailure?.status ?? rpStatus };
      if (state && rpSignal) rpOperations.complete(state, failure);
      if (!res.destroyed) { res.writeHead(500); res.end("RP test failed"); }
    }
  });
  rp.listen(0, "127.0.0.1"); await once(rp, "listening"); callback = `https://127.0.0.1:${rp.address().port}`;
  await admin("/_mapi/admin/oidc/init", {});
  const registered = await admin("/_mapi/admin/oidc/clients", { document: { slug: `hosted-${randomUUID()}`, name: "Synthetic hosted test RP", clients: [{ slug: "web", type: "confidential", grant_types: ["authorization_code", "refresh_token"], redirect_uris: [`${callback}/callback`] }] } });
  const secret = registered.Secrets?.[0]; assert.ok(secret?.ClientID && secret?.Secret);
  client = { id: secret.ClientID, secret: secret.Secret };
  browser = await chromium.launch({ headless: true, args: [`--ignore-certificate-errors-spki-list=${spki}`] });
  async function journey(onFirstRequest = () => {}) {
    const started = performance.now(), context = await browser.newContext(), page = await context.newPage();
    const journeyState = randomBytes(24).toString("base64url");
    rpOperations.register(journeyState);
    let stage = "start";
    let contextClosed = false, firstRequestStarted;
    const observation = observeBrowser(context, { primaryPage: page, issuerOrigin: origin, rpOrigin: callback, projectId: user.projectId, journeyState, timings, classifyFlowSubmission, onFirstRequest: at => { firstRequestStarted = at; onFirstRequest(at); } });
    try {
      page.setDefaultTimeout(30000); page.setDefaultNavigationTimeout(30000);
      await page.goto(`${callback}/start?state=${journeyState}`);
      stage = "identifier";
      await page.getByLabel("Email").fill(user.email); await page.getByRole("button", { name: "Continue", exact: true }).click();
      stage = "password";
      await page.getByTestId("zitadel-input-password").fill(user.password); await page.getByRole("button", { name: "Sign in", exact: true }).click();
      stage = "oauth_continue";
      await page.waitForURL("**/oauth/continue?request=*");
      stage = "rp_callback";
      const callbackResponse = page.waitForResponse(response => response.url().startsWith(`${callback}/callback`) && response.request().method() === "GET");
      await page.getByRole("button", { name: "Continue", exact: true }).click();
      assertRpCallback(await callbackResponse);
      await page.waitForURL(`${callback}/callback**`); await page.getByRole("heading", { name: "Authenticated by the independent RP" }).waitFor();
      assert.ok(observation.callbackStarted());
      assert.ok(firstRequestStarted !== undefined);
      const callbackStarted = observation.callbackStarted();
      const result = { signInMs: callbackStarted - started, journeyMs: performance.now() - started, signInInterval: { startedAtMs: performance.timeOrigin + firstRequestStarted, endedAtMs: performance.timeOrigin + callbackStarted }, latencyInterval: { startedAtMs: performance.timeOrigin + started, endedAtMs: performance.timeOrigin + callbackStarted } };
      const rpResult = await rpOperations.finish(journeyState);
      if (rpResult) { const error = new Error('Independent RP callback failed'); error.phase1RpFailure = rpResult; throw error; }
      // Preserve the original callback/heading timing while observing any
      // already-issued requests through completion before declaring success.
      stage = 'browser_settle';
      await observation.settle();
      await context.close(); contextClosed = true;
      await observation.settle({ quietMs: 0 });
      observation.assertNetworkClean(); observation.assertHttpClean();
      return result;
    } catch (error) {
      error.phase1Stage = stage;
      if (firstRequestStarted !== undefined) error.phase1SignInInterval = { startedAtMs: performance.timeOrigin + firstRequestStarted, endedAtMs: performance.timeOrigin + (observation.callbackStarted() ?? performance.now()) };
      error.phase1RpFailure ??= await rpOperations.finish(journeyState, { abort: true, reason: error?.name === 'TimeoutError' ? 'timeout' : 'aborted' });
      if (!contextClosed) {
        observation.beginCleanup();
        try { await context.close(); } catch { error.phase1BrowserFailure ??= observation.snapshot('cleanup'); }
        contextClosed = true;
      }
      error.phase1HttpFailure = observation.lastHttpFailure();
      error.phase1UnexpectedHttp = observation.unexpectedHttp();
      const browser = observation.snapshot();
      if (!error.phase1BrowserFailure && (browser.pendingRequests || browser.networkFailures || browser.cleanupAborts || browser.unexpectedOrigins || browser.stateMismatches || browser.extraPages || browser.serviceWorkers || browser.unattributedRequests)) error.phase1BrowserFailure = observation.snapshot('network');
      throw error;
    } finally { if (!contextClosed) { try { await context.close(); } catch {} } transactions.delete(journeyState); }
  }
  const safeJourney = async () => {
    try { return { result: await journey() }; }
    catch (error) { return { failure: classifyJourneyFailure(error) }; }
  };
  const coldIdleMs = Number(process.env.MAPI_COLD_IDLE_MS ?? 0);
  if (!Number.isSafeInteger(coldIdleMs) || coldIdleMs < 0 || coldIdleMs > 600000) throw new Error("Invalid cold idle duration");
  let beforeIdleBootId = null;
  if (coldIdleMs && process.env.MAPI_COLD_COMPARE_BOOT === "1") {
    const before = await requestJson(new URL("/_mapi/admin/status", origin), { headers: { authorization: `Bearer ${operator}` } }, { operation: 'pre-idle-status', expectedStatus: 200 });
    if (!before.bootId || !before.reactorInitializations) throw requestFailure('pre-idle-status', 'response', 200);
    beforeIdleBootId = before.bootId;
  }
  const coldIdleStart = coldIdleMs ? new Date().toISOString() : null;
  if (coldIdleMs) await delay(coldIdleMs);
  const coldJourneyStart = coldIdleMs ? new Date().toISOString() : null;
  const childMode = process.env.MAPI_PHASE1_CHILD === "1";
  const first = childMode ? await safeJourney() : await journey(), samples = [];
  if (childMode) {
    if (!process.send) throw new Error("Phase 1 benchmark requires an IPC parent");
    process.send({ type: 'setup-progress', stage: 'first', outcome: first });
    const warmup = await safeJourney();
    process.send({ type: 'setup-progress', stage: 'warmup', outcome: warmup });
    process.send({ type: "ready", first, warmup });
    for (let wave = 0; wave < 5; wave++) {
      const childReceivedAtMs = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("Benchmark barrier timed out")), 120000);
        process.once("message", message => {
          clearTimeout(timeout);
          if (message?.type !== "start" || message.wave !== wave) reject(new Error("Unexpected benchmark barrier"));
          else resolve(performance.timeOrigin + performance.now());
        });
      });
      const observed = await beginObservedWave(Array.from({ length: 4 }, () => onFirstRequest => journey(onFirstRequest)));
      process.send({ type: 'wave-start', wave, attempts: observed.attempts, started: observed.started, childReceivedAtMs, childAcknowledgedAtMs: observed.childAcknowledgedAtMs });
      const outcomes = await observed.settled;
      samples.push(...outcomes.filter(item => item.status === "fulfilled").map(item => item.value));
      const failureCategories = outcomes.filter(item => item.status === "rejected").map(item => classifyJourneyFailure(item.reason));
      process.send({ type: "wave", wave, attempts: outcomes.length, failures: failureCategories.length, failureCategories, signInIntervals: outcomes.map(item => item.status === 'fulfilled' ? item.value.signInInterval : item.reason?.phase1SignInInterval ?? null), latencyIntervals: outcomes.map(item => item.status === 'fulfilled' ? item.value.latencyInterval : null) });
    }
  } else if (process.env.MAPI_TEST_BURST === "1") {
    for (let i = 0; i < 5; i++) samples.push(...await Promise.all(Array.from({ length: 4 }, journey)));
  }
  const status = await requestJson(new URL("/_mapi/admin/status", origin), { headers: { authorization: `Bearer ${operator}` } }, { operation: 'owner-status', expectedStatus: 200 });
  try { assertRuntimeStatus(status); } catch { throw requestFailure('owner-status', 'response', 200); }
  const p95 = (name) => samples.length ? samples.map((sample) => sample[name]).sort((a, b) => a - b)[Math.ceil(samples.length * .95) - 1] : null;
  const requestP95Ms = Object.fromEntries([...timings].map(([name, values]) => [name, values.sort((a, b) => a - b)[Math.ceil(values.length * .95) - 1]]));
  const result = { first, journeys: 1 + samples.length, measuredJourneys: samples.length, concurrency: samples.length ? 4 : 1, signInSamplesMs: samples.map(sample => sample.signInMs), signInP95Ms: p95("signInMs"), journeySamplesMs: samples.map(sample => sample.journeyMs), journeyP95Ms: p95("journeyMs"), requestP95Ms, replayAttempts, replayRejections: replays, serviceWorkerPolicy: 'allow', wasmMemoryBytes: status.wasmMemoryBytes, wasmHighWaterBytes: status.wasmHighWaterBytes, wasmHighWaterPages: status.wasmHighWaterPages, ownerBootId: status.bootId, reactorInitializations: status.reactorInitializations, ...(coldIdleMs ? { coldIdleMs, coldIdleStart, coldJourneyStart, beforeIdleBootId } : {}) };
  if (process.env.MAPI_PHASE1_CHILD === "1") process.send({ type: "result", result });
  else console.log(JSON.stringify(result, null, 2));
} catch (error) {
  if (process.env.MAPI_PHASE1_CHILD === '1' && process.send) await new Promise(resolve => {
    try { process.send({ type: 'child-failure', failure: error?.phase1Failure ?? { operation: 'child', kind: 'internal', status: null } }, () => resolve()); }
    catch { resolve(); }
  });
  throw new Error('Hosted benchmark child failed');
} finally {
  if (browser) await browser.close();
  if (rp) { rp.closeAllConnections(); await new Promise((done) => rp.close(done)); }
  await rm(temp, { recursive: true, force: true });
}
