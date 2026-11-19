import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chromium } from "playwright";

const base = process.env.MAPI_URL;
const operator = process.env.MAPI_OPERATOR_TOKEN;
if (!base || !operator) throw new Error("MAPI_URL and MAPI_OPERATOR_TOKEN are required");
const email = `browser-${randomUUID()}@example.com`;
const password = `Example-${randomUUID()}!`;
const provision = await fetch(new URL("/_mapi/admin/users", base), {
  method: "POST", headers: { authorization: `Bearer ${operator}`, "content-type": "application/json" },
  body: JSON.stringify({ email, password }),
});
assert.equal(provision.status, 200);

const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(new URL("/login", base).href);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL("**/app");
  assert.equal(await page.getByRole("heading", { name: "Signed in" }).count(), 1);
  await page.reload();
  const cookies = await context.cookies();
  const session = cookies.find(({ name }) => name === (new URL(base).protocol === "https:" ? "__Host-zitadel_session" : "zitadel_session"));
  assert.ok(session?.httpOnly);
  if (new URL(base).protocol === "https:") assert.ok(session.secure);
  await page.getByRole("button", { name: "Sign out" }).click();
  await page.waitForURL("**/login");
  await context.addCookies([session]);
  const response = await page.goto(new URL("/app", base).href);
  assert.equal(response.status(), 200);
  assert.equal(new URL(page.url()).pathname, "/login");
  await context.close();
  console.log("Browser sign-in, reload, sign-out and revoked-cookie replay passed.");
} finally { await browser.close(); }
