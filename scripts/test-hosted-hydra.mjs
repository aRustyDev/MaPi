import assert from "node:assert/strict";
import { createHash, createPublicKey, randomBytes, verify } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { once } from "node:events";
import { chromium } from "playwright";

const [fixtureDirectory] = process.argv.slice(2);
assert(fixtureDirectory, "usage: node scripts/test-hosted-hydra.mjs <private staging fixture directory>");
const user = JSON.parse(await readFile(`${fixtureDirectory}/app/.mapi/test-user.json`, "utf8"));
const secret = (await readFile(`${fixtureDirectory}/client-secret`, "utf8")).trim();
const appConfig = JSON.parse(await readFile(`${fixtureDirectory}/app/wrangler.json`, "utf8"));
const origin = new URL(appConfig.vars.MAPI_APP_ORIGIN).origin;
assert(origin.startsWith("https://"), "staging origin must use HTTPS");
const issuer = `${origin}/oauth/${user.projectId}`;
const client = "mapi-hydra-132-rp", redirect = "http://127.0.0.1:46346/callback";
const state = randomBytes(24).toString("base64url"), nonce = randomBytes(24).toString("base64url");
const verifier = randomBytes(48).toString("base64url");
const challenge = createHash("sha256").update(verifier).digest("base64url");
const authorization = "Basic " + Buffer.from(client + ":" + secret).toString("base64");
let callbackResult, currentRefresh;
async function token(fields) {
  return fetch(`${issuer}/oauth2/token`, { method: "POST", headers: { authorization }, body: new URLSearchParams(fields) });
}
const rp = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, redirect);
    if (url.pathname === "/start") {
      const params = new URLSearchParams({ client_id: client, redirect_uri: redirect, response_type: "code",
        scope: "openid offline_access", state, nonce, code_challenge: challenge, code_challenge_method: "S256" });
      response.writeHead(302, { location: `${issuer}/oauth2/auth?${params}` }); response.end(); return;
    }
    if (url.pathname === "/favicon.ico") { response.writeHead(204); response.end(); return; }
    assert.equal(url.pathname, "/callback", "relying-party callback path");
    assert.equal(url.searchParams.get("state"), state, "relying-party state");
    const code = url.searchParams.get("code"); assert(code, `authorization code missing (OAuth error ${url.searchParams.get("error") || "none"})`);
    const fields = { grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: redirect };
    const result = await token(fields); assert.equal(result.status, 200, "authorization-code exchange");
    const tokens = await result.json();
    const [head, body, signature] = tokens.id_token.split(".");
    const header = JSON.parse(Buffer.from(head, "base64url")), claims = JSON.parse(Buffer.from(body, "base64url"));
    const jwksResponse = await fetch(`${issuer}/.well-known/jwks.json`); assert.equal(jwksResponse.status, 200, `JWKS response status ${jwksResponse.status}`);
    const jwks = await jwksResponse.json();
    const key = jwks.keys.find(candidate => candidate.kid === header.kid);
    assert(key && header.alg === "RS256", `matching RSA signing key missing (algorithm ${header.alg}, JWKS keys ${jwks.keys.length})`);
    assert(verify("RSA-SHA256", Buffer.from(`${head}.${body}`), createPublicKey({ key, format: "jwk" }), Buffer.from(signature, "base64url")), "ID token signature verification");
    assert.equal(claims.iss, issuer, "ID token issuer"); assert.equal(claims.sub, user.userId, "ID token subject");
    assert(Array.isArray(claims.aud) ? claims.aud.includes(client) : claims.aud === client, "ID token audience");
    assert.equal(claims.nonce, nonce, "ID token nonce");
    const refreshed = await token({ grant_type: "refresh_token", refresh_token: tokens.refresh_token });
    assert.equal(refreshed.status, 200, "refresh"); currentRefresh = (await refreshed.json()).refresh_token;
    // Hydra invalidates the whole grant on code replay; check replay after logout.
    callbackResult = { fields };
    response.writeHead(200, { "content-type": "text/plain" }); response.end("Authenticated");
  } catch (error) {
    callbackResult = { error: error.message.split("\n")[0] };
    response.writeHead(500); response.end("Relying party failed");
  }
});
rp.listen(46346, "127.0.0.1"); await once(rp, "listening");
const browser = await chromium.launch({ headless: true });
const observed = [];
let page;
let initialChallengeDigest;
try {
  page = await browser.newPage();
  page.on("response", response => {
    const url = new URL(response.url());
    if (url.origin === origin) {
      const challenge = url.searchParams.get("login_challenge");
      if (challenge) initialChallengeDigest = createHash("sha256").update(challenge).digest("hex");
      const continued = url.pathname.endsWith("/phase0/continue") ? url.searchParams.get("challenge") : null;
      observed.push({ path: url.pathname, status: response.status(), ...(challenge ? { challengeLength: challenge.length, challengeFormatValid: /^[A-Za-z0-9_-]+={0,2}$/.test(challenge) } : {}), ...(continued ? { continuationLength: continued.length, challengePreserved: initialChallengeDigest === createHash("sha256").update(continued).digest("hex") } : {}) });
    }
  });
  await page.goto("http://127.0.0.1:46346/start");
  await page.getByLabel("Email").fill(user.email, { timeout: 30000 });
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByTestId("zitadel-input-password").fill(user.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL("**/phase0/continue?challenge=*", { timeout: 30000 });
  await page.waitForLoadState("domcontentloaded");
  assert.equal(await page.getByRole("button", { name: "Continue", exact: true }).count(), 1, "login continuation form");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.waitForURL("**/phase0/consent?consent_challenge=*", { timeout: 30000 });
  await page.waitForLoadState("domcontentloaded");
  assert.equal(await page.getByRole("button", { name: /^Allow / }).count(), 1, "consent form");
  await page.getByRole("button", { name: /^Allow / }).click();
  await page.waitForURL("http://127.0.0.1:46346/callback**", { timeout: 30000 });
  await page.waitForLoadState("domcontentloaded");
  assert(!callbackResult?.error, callbackResult?.error);
  await page.getByText("Authenticated", { exact: true }).waitFor({ timeout: 30000 });
  assert(!callbackResult.error, callbackResult.error);
  if (process.argv.includes("--prepare-unavailable")) {
    await writeFile(`${fixtureDirectory}/unavailable-refresh-token`, currentRefresh, { mode: 0o600, flag: "wx" });
    console.log("Hosted journey obtained a refresh token for the private session-authority failure probe.");
  } else {
  await page.goto(`${origin}/app`);
  await page.getByRole("button", { name: "Sign out" }).click();
  const revoked = await token({ grant_type: "refresh_token", refresh_token: currentRefresh });
  assert.equal(revoked.status, 400, "refresh after logout status");
  assert.equal((await revoked.json()).error, "invalid_grant", "refresh after logout error");
  const replay = await token(callbackResult.fields);
  assert.equal(replay.status, 400, "code replay status");
  assert.equal((await replay.json()).error, "invalid_grant", "code replay error");
  console.log("Hosted independent RP passed login, consent, S256 exchange, signed ID token, refresh, logout denial and code replay denial.");
  }
} catch (error) {
  console.error("Hosted RP failed:", error.message.split("\n")[0], "RP:", callbackResult?.error ?? "not reached");
  console.error("Observed issuer statuses:", JSON.stringify(observed));
  throw error;
} finally {
  await browser.close(); rp.close();
}
