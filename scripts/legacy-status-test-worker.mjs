import app, { NextgenApplication } from "../worker/generated-legacy-status-app.js";
import { ProjectRegistry } from "../worker/registry.js";

export class TestRegistry extends ProjectRegistry {}
export class TestOwner extends NextgenApplication {}

function check(value, message) { if (!value) throw Error(message); }
export default {
  async fetch(_request, env) {
    try {
      const origin = "https://legacy.example", objectName = "legacy";
      const registry = env.PROJECT_REGISTRY.getByName("projects");
      const owner = env.NEXTGEN_APPLICATION.getByName(objectName);
      await registry.reserve(origin, objectName);
      const { projectId } = await owner.provision("Legacy", origin, { projectId: null, origin, objectName, generation: 1 });
      await registry.activate(origin, objectName, projectId);
      const route = { projectId, origin, objectName, generation: 1 };
      const email = "status@example.test", password = "Synthetic-password-123!";
      await owner.addUser(email, password, route);
      let attempt = 0;
      const login = (secret, loginEmail = email, ip = `192.0.2.${++attempt}`) => app.fetch(new Request(`${origin}/login`, {
        method: "POST", headers: { origin, "content-type": "application/x-www-form-urlencoded", "cf-connecting-ip": ip },
        body: new URLSearchParams({ email: loginEmail, password: secret }),
      }), env);
      check((await login(password)).status === 303, "Valid login failed");
      const beforeInvalid = await owner.testSessionCount();
      const invalid = await login("incorrect-password");
      check(invalid.status === 401 && !invalid.headers.has("set-cookie") && await owner.testSessionCount() === beforeInvalid, "Invalid password should remain 401 without a session");
      const invalidBody = await invalid.text();
      const unknown = await login("incorrect-password", "unknown@example.test");
      check(unknown.status === 401 && await unknown.text() === invalidBody && !unknown.headers.has("set-cookie"), "Unknown identifier and wrong password must have the same generic response");
      const limitedIp = "198.51.100.42";
      await owner.testThrottle(limitedIp);
      const knownLimited = await login("incorrect-password", email, limitedIp);
      const unknownLimited = await login("incorrect-password", "unknown@example.test", limitedIp);
      check(knownLimited.status === 429 && unknownLimited.status === 429 && await knownLimited.text() === await unknownLimited.text(), "IP admission must precede identifier lookup");
      const stages = ["start", "identifier challenge", "identifier verify", "password challenge", "password verify", "handoff", "session exchange"];
      for (let index = 0; index < stages.length; index++) {
        for (const injected of [401, 429, 408, 500, 503, 302]) {
          const sessionCount = await owner.testSessionCount();
          await owner.testFault(index, injected);
          const response = await login(password);
          check(response.status === 401, `${stages[index]} upstream ${injected} returned ${response.status}, expected generic 401`);
          check(response.headers.get("cache-control") === "no-store", `${stages[index]} response was cacheable`);
          check(!response.headers.has("set-cookie") && await owner.testSessionCount() === sessionCount, `${stages[index]} failed login created a session`);
          check(await response.text() === invalidBody, `${stages[index]} response differed from a wrong password`);
          check(await owner.testFaultHit(), `${stages[index]} injection was not reached`);
        }
      }
      const signedIn = await login(password);
      check(signedIn.status === 303, "Valid login after injected failures failed");
      const cookie = signedIn.headers.get("set-cookie")?.split(";", 1)[0];
      check(cookie, "Login returned no session cookie");
      const appPage = () => app.fetch(new Request(`${origin}/app`, { headers: { cookie } }), env);
      check((await appPage()).status === 200, "Valid session failed");
      const csrfPage = await appPage();
      const csrf = (await csrfPage.text()).match(/name="csrf" value="([A-Za-z0-9_-]+)"/)?.[1];
      check(csrf, "Session returned no CSRF token");
      const logout = () => app.fetch(new Request(`${origin}/logout`, { method: "POST", headers: { origin, cookie, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ csrf }) }), env);
      for (const [stage, index, request] of [["session read", 0, appPage], ["session csrf", 1, appPage], ["session logout", 0, logout]]) {
        for (const [injected, expected] of [[429, 429], [408, 503], [500, 503], [503, 503], [302, 503]]) {
          await owner.testFault(index, injected);
          const response = await request();
          check(response.status === expected, `${stage} upstream ${injected} returned ${response.status}, expected ${expected}`);
          check(response.headers.get("cache-control") === "no-store", `${stage} response was cacheable`);
          check(!(await response.text()).includes("sensitive upstream details"), `${stage} leaked upstream body`);
          check(await owner.testFaultHit(), `${stage} injection was not reached`);
        }
      }
      await owner.testFault(0, 401);
      check((await appPage()).status === 303 && await owner.testFaultHit(), "Unauthenticated session should redirect");
      await owner.testFault(0, 403);
      check((await logout()).status === 403 && await owner.testFaultHit(), "Forbidden logout should remain 403");
      check((await appPage()).status === 200, "Injected session failures changed the active session");
      return Response.json({ ok: true, cases: stages.length * 6 + 20 });
    } catch (error) { return Response.json({ error: String(error), stack: error.stack }, { status: 500 }); }
  }
};
