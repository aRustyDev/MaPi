import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import http from "node:http";
import { once } from "node:events";
import { chromium } from "playwright";

const base = process.env.MAPI_URL;
const operator = process.env.MAPI_OPERATOR_TOKEN;
if (!base || !operator) throw new Error("MAPI_URL and MAPI_OPERATOR_TOKEN are required");
const primary = new URL(base);
if (primary.protocol !== "http:" || !["localhost", "127.0.0.1"].includes(primary.hostname)) {
  throw new Error("This synthetic origin test requires a local HTTP MAPI_URL");
}
// Give the second project a different real origin while routing both origins
// to the same local Worker. No DNS, deployed Worker, or backend is involved.
const proxy = http.createServer((incoming, outgoing) => {
  const upstream = http.request({ hostname: primary.hostname, port: primary.port, path: incoming.url, method: incoming.method, headers: incoming.headers }, (response) => {
    outgoing.writeHead(response.statusCode, response.headers);
    response.pipe(outgoing);
  });
  upstream.on("error", () => { if (!outgoing.headersSent) outgoing.writeHead(502); outgoing.end(); });
  incoming.pipe(upstream);
});
proxy.listen(0, "127.0.0.1");
await once(proxy, "listening");
const secondary = `http://127.0.0.1:${proxy.address().port}`;
const origins = [primary.origin, secondary];
const email = `projects-${randomUUID()}@example.com`;
const passwords = [`Project-A-${randomUUID()}!`, `Project-B-${randomUUID()}!`];

async function admin(origin, path, body) {
  return fetch(new URL(path, origin), { method: "POST", headers: { authorization: `Bearer ${operator}`, "content-type": "application/json" }, body: JSON.stringify(body) });
}
let browser;
try {
  const init = await admin(origins[0], "/_mapi/admin/init", { name: "Browser primary" });
  assert.equal(init.status, 200);
  const primaryId = (await init.json()).projectId;
  const create = await admin(origins[0], "/_mapi/admin/projects", { name: "Browser secondary", origin: secondary });
  assert.equal(create.status, 200);
  assert.notEqual((await create.json()).projectId, primaryId);
  for (let i = 0; i < 2; i++) assert.equal((await admin(origins[i], "/_mapi/admin/users", { email, password: passwords[i] })).status, 200);

  browser = await chromium.launch({ headless: true });
  const contexts = await Promise.all(origins.map(() => browser.newContext()));
  const pages = await Promise.all(contexts.map((context) => context.newPage()));
  async function reachPassword(page, origin) {
    await page.goto(`${origin}/login`);
    assert.equal(await page.locator("zitadel-login").count(), 1);
    await page.getByLabel("Email").fill(email);
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await page.getByTestId("zitadel-input-password").waitFor();
  }
  for (let i = 0; i < 2; i++) {
    await reachPassword(pages[i], origins[i]);
    await pages[i].getByTestId("zitadel-input-password").fill(passwords[1 - i]);
    await pages[i].getByRole("button", { name: "Sign in", exact: true }).click();
    await pages[i].getByRole("alert").getByText("Wrong email or password.").waitFor();
    assert.equal((await contexts[i].cookies()).some(({ name }) => name === "zitadel_session"), false);
  }
  await Promise.all(pages.map((page, i) => reachPassword(page, origins[i])));
  await Promise.all(pages.map(async (page, i) => {
    await page.getByTestId("zitadel-input-password").fill(passwords[i]);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await page.waitForURL("**/app");
    assert.equal(await page.getByRole("heading", { name: "Signed in" }).count(), 1);
  }));
  const cookies = await Promise.all(contexts.map(async (context) => {
    const cookie = (await context.cookies()).find(({ name }) => name === "zitadel_session");
    assert.ok(cookie?.httpOnly);
    return cookie;
  }));
  for (let i = 0; i < 2; i++) {
    const replay = await browser.newContext();
    await replay.addCookies([{ name: cookies[1 - i].name, value: cookies[1 - i].value, url: origins[i], httpOnly: true }]);
    const page = await replay.newPage();
    await page.goto(`${origins[i]}/app`);
    assert.equal(new URL(page.url()).pathname, "/login");
    await replay.close();
  }
  await pages[1].getByRole("button", { name: "Sign out" }).click();
  await pages[1].waitForURL("**/login");
  await pages[0].reload();
  assert.equal(new URL(pages[0].url()).pathname, "/app");
  assert.equal(await pages[0].getByRole("heading", { name: "Signed in" }).count(), 1);
  await Promise.all(contexts.map((context) => context.close()));
  console.log("Two official-component projects: separate passwords, concurrent sessions, cross-project cookie rejection and isolated logout passed.");
} finally {
  if (browser) await browser.close();
  proxy.closeAllConnections();
  await new Promise((resolve, reject) => proxy.close((error) => error ? reject(error) : resolve()));
}
