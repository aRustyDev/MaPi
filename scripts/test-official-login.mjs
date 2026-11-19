import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chromium } from "playwright";

const base = process.env.MAPI_URL;
const operator = process.env.MAPI_OPERATOR_TOKEN;
if (!base || !operator) throw new Error("MAPI_URL and MAPI_OPERATOR_TOKEN are required");
const origin = new URL(base).origin;
const email = `official-${randomUUID()}@example.com`;
const password = `Example-${randomUUID()}!`;
async function admin(path, body) {
  return fetch(new URL(path, origin), { method: "POST", headers: { authorization: `Bearer ${operator}`, "content-type": "application/json" }, body: JSON.stringify(body) });
}
assert.equal((await admin("/_mapi/admin/init", { name: "Official login browser test" })).status, 200);
assert.equal((await admin("/_mapi/admin/users", { email, password })).status, 200);
const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext();
  const page = await context.newPage();
  const navigateToPassword = async () => {
    await page.goto(new URL("/login", origin).href);
    assert.equal(await page.locator("zitadel-login").count(), 1);
    await page.getByLabel("Email").fill(email);
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await page.getByTestId("zitadel-input-password").waitFor();
  };
  await navigateToPassword();
  await page.getByTestId("zitadel-input-password").fill("wrong-password");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByRole("alert").getByText("Wrong email or password.").waitFor();
  assert.equal(new URL(page.url()).pathname, "/login");
  assert.equal((await context.cookies()).some(({ name }) => name === "zitadel_session" || name === "__Host-zitadel_session"), false);

  await navigateToPassword();
  await page.getByTestId("zitadel-input-password").fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL("**/app");
  assert.equal(await page.getByRole("heading", { name: "Signed in" }).count(), 1);
  await page.reload();
  assert.equal(await page.getByRole("heading", { name: "Signed in" }).count(), 1);
  const session = (await context.cookies()).find(({ name }) => name === (new URL(origin).protocol === "https:" ? "__Host-zitadel_session" : "zitadel_session"));
  assert.ok(session?.httpOnly);
  if (new URL(origin).protocol === "https:") assert.ok(session.secure);

  const crossFlow = await context.request.post(new URL("/__nextgen/flows", origin).href, { headers: { origin: "https://attacker.invalid" }, data: {} });
  assert.equal(crossFlow.status(), 403);
  const crossLogout = await context.request.post(new URL("/logout", origin).href, { headers: { origin: "https://attacker.invalid" }, form: { csrf: "invalid" } });
  assert.equal(crossLogout.status(), 403);
  const badCsrf = await context.request.post(new URL("/logout", origin).href, { headers: { origin }, form: { csrf: "invalid" } });
  assert.ok([401, 403].includes(badCsrf.status()));
  await page.getByRole("button", { name: "Sign out" }).click();
  await page.waitForURL("**/login");
  await context.addCookies([session]);
  await page.goto(new URL("/app", origin).href);
  assert.equal(new URL(page.url()).pathname, "/login");
  await context.close();
  console.log("Official component: wrong password, login, reload, CSRF/origin rejection, logout and revoked-cookie replay passed.");
} finally { await browser.close(); }
