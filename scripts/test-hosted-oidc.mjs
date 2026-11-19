// A loopback relying party tests the isolated staging issuer without sending
// credentials or authorization codes to any third-party backend.
import assert from "node:assert/strict";
import { createHash, createPublicKey, randomBytes, randomUUID, verify, X509Certificate } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { once } from "node:events";
import { performance } from "node:perf_hooks";
import { chromium } from "playwright";

const base = process.env.MAPI_URL;
const operator = process.env.MAPI_OPERATOR_TOKEN;
if (!base || !operator || !process.env.MAPI_TEST_USER_FILE) throw new Error("MAPI_URL, MAPI_OPERATOR_TOKEN and MAPI_TEST_USER_FILE are required");
const origin = new URL(base).origin;
if (!origin.startsWith("https://")) throw new Error("A hosted HTTPS issuer is required");
const user = JSON.parse(await readFile(process.env.MAPI_TEST_USER_FILE, "utf8"));
const adminHeaders = { authorization: `Bearer ${operator}`, "content-type": "application/json" };
async function admin(path, body) {
  const response = await fetch(new URL(path, origin), { method: "POST", headers: adminHeaders, body: JSON.stringify(body) });
  assert.equal(response.status, 200, `Operator ${path}`);
  return response.json();
}
const temp = await mkdtemp(resolve(tmpdir(), "mapi-hosted-rp-"));
let rp, browser;
try {
  const keyPath = resolve(temp, "key.pem"), certPath = resolve(temp, "cert.pem");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", keyPath, "-out", certPath, "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1"], { stdio: "ignore" });
  const cert = await readFile(certPath), key = await readFile(keyPath);
  const spki = createHash("sha256").update(new X509Certificate(cert).publicKey.export({ type: "spki", format: "der" })).digest("base64");
  let callback, client, callbackError, replays = 0;
  const transactions = new Map();
  const timings = new Map();
  rp = createServer({ cert, key }, async (req, res) => {
    try {
      const url = new URL(req.url, callback);
      if (url.pathname === "/start") {
        const state = randomBytes(24).toString("base64url"), nonce = randomBytes(24).toString("base64url"), verifier = randomBytes(48).toString("base64url");
        transactions.set(state, { nonce, verifier });
        const params = new URLSearchParams({ client_id: client.id, redirect_uri: `${callback}/callback`, response_type: "code", scope: "openid", state, nonce, code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256" });
        res.writeHead(302, { location: `${origin}/oauth/${user.projectId}/authorize?${params}` }); res.end(); return;
      }
      const state = url.searchParams.get("state"), code = url.searchParams.get("code"), tx = transactions.get(state);
      if (url.pathname !== "/callback" || !tx || !code) throw new Error("Invalid RP callback");
      transactions.delete(state);
      const body = new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: `${callback}/callback`, code_verifier: tx.verifier });
      const headers = { "content-type": "application/x-www-form-urlencoded", authorization: `Basic ${Buffer.from(`${encodeURIComponent(client.id)}:${encodeURIComponent(client.secret)}`).toString("base64")}` };
      const token = await fetch(`${origin}/oauth/${user.projectId}/token`, { method: "POST", headers, body });
      if (!token.ok) throw new Error(`Token exchange HTTP ${token.status}`);
      const result = await token.json(), [header, payload, signature] = result.id_token.split(".");
      const metadata = JSON.parse(Buffer.from(header, "base64url")), claims = JSON.parse(Buffer.from(payload, "base64url"));
      const jwks = await fetch(`${origin}/oauth/${user.projectId}/jwks`);
      const publicKey = (await jwks.json()).keys.find((entry) => entry.kid === metadata.kid);
      if (!jwks.ok || !publicKey || !verify("RSA-SHA256", Buffer.from(`${header}.${payload}`), createPublicKey({ key: publicKey, format: "jwk" }), Buffer.from(signature, "base64url"))) throw new Error("Invalid ID-token signature");
      if (claims.iss !== `${origin}/oauth/${user.projectId}` || claims.nonce !== tx.nonce || !(Array.isArray(claims.aud) ? claims.aud : [claims.aud]).includes(client.id) || !claims.sub || claims.exp <= Date.now() / 1000) throw new Error("Invalid ID-token claims");
      const replay = await fetch(`${origin}/oauth/${user.projectId}/token`, { method: "POST", headers, body });
      if (replay.status < 400) throw new Error("Authorization code replay accepted");
      replays++;
      res.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" }); res.end("<!doctype html><h1>Authenticated by the independent RP</h1>");
    } catch (error) { callbackError = error; res.writeHead(500); res.end("RP test failed"); }
  });
  rp.listen(0, "127.0.0.1"); await once(rp, "listening"); callback = `https://127.0.0.1:${rp.address().port}`;
  await admin("/_mapi/admin/oidc/init", {});
  const registered = await admin("/_mapi/admin/oidc/clients", { document: { slug: `hosted-${randomUUID()}`, name: "Synthetic hosted test RP", clients: [{ slug: "web", type: "confidential", grant_types: ["authorization_code", "refresh_token"], redirect_uris: [`${callback}/callback`] }] } });
  const secret = registered.Secrets?.[0]; assert.ok(secret?.ClientID && secret?.Secret);
  client = { id: secret.ClientID, secret: secret.Secret };
  browser = await chromium.launch({ headless: true, args: [`--ignore-certificate-errors-spki-list=${spki}`] });
  async function journey() {
    const started = performance.now(), context = await browser.newContext(), page = await context.newPage();
    const unexpected = [], failures = [];
    let callbackStarted;
    const requestStarts = new WeakMap();
    page.on("request", (request) => { const url = new URL(request.url()); requestStarts.set(request, performance.now()); if (url.origin !== origin && url.origin !== callback) unexpected.push(url.origin); if (url.origin === callback && url.pathname === "/callback") callbackStarted = performance.now(); });
    page.on("response", (response) => {
      const request = response.request(), url = new URL(request.url()), startedAt = requestStarts.get(request);
      if (url.origin !== origin || startedAt === undefined) return;
      const path = url.pathname.replace(/flow_[A-Za-z0-9_-]+/g, ":flow").replace(user.projectId, ":project");
      const key = `${request.method()} ${path}`;
      if (!timings.has(key)) timings.set(key, []);
      timings.get(key).push(performance.now() - startedAt);
    });
    page.on("requestfailed", (request) => failures.push(new URL(request.url()).pathname));
    try {
      page.setDefaultTimeout(30000); page.setDefaultNavigationTimeout(30000);
      await page.goto(`${callback}/start`);
      await page.getByLabel("Email").fill(user.email); await page.getByRole("button", { name: "Continue", exact: true }).click();
      await page.getByTestId("zitadel-input-password").fill(user.password); await page.getByRole("button", { name: "Sign in", exact: true }).click();
      await page.waitForURL("**/oauth/continue?request=*"); await page.getByRole("button", { name: "Continue", exact: true }).click();
      await page.waitForURL(`${callback}/callback**`); await page.getByRole("heading", { name: "Authenticated by the independent RP" }).waitFor();
      if (callbackError) throw callbackError;
      assert.deepEqual(unexpected, []); assert.deepEqual(failures, []);
      assert.ok(callbackStarted);
      return { signInMs: callbackStarted - started, journeyMs: performance.now() - started };
    } finally { await context.close(); }
  }
  const first = await journey(), samples = [];
  if (process.env.MAPI_TEST_BURST === "1") for (let i = 0; i < 5; i++) samples.push(...await Promise.all(Array.from({ length: 4 }, journey)));
  const status = await fetch(new URL("/_mapi/admin/status", origin), { headers: { authorization: `Bearer ${operator}` } }).then((response) => response.json());
  const p95 = (name) => samples.length ? samples.map((sample) => sample[name]).sort((a, b) => a - b)[Math.ceil(samples.length * .95) - 1] : null;
  const requestP95Ms = Object.fromEntries([...timings].map(([name, values]) => [name, values.sort((a, b) => a - b)[Math.ceil(values.length * .95) - 1]]));
  console.log(JSON.stringify({ first, journeys: 1 + samples.length, concurrency: samples.length ? 4 : 1, signInP95Ms: p95("signInMs"), journeyP95Ms: p95("journeyMs"), requestP95Ms, replayRejections: replays, wasmMemoryBytes: status.wasmMemoryBytes }, null, 2));
} finally {
  if (browser) await browser.close();
  if (rp) { rp.closeAllConnections(); await new Promise((done) => rp.close(done)); }
  await rm(temp, { recursive: true, force: true });
}
