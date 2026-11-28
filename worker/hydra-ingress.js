import { renderLogin } from "./login-ui.js";
import { readBoundedText } from "./request-body.js";

const noStore = { "cache-control": "no-store" };
// Hydra's encrypted login and consent challenges can exceed 1 KiB.
const challengePattern = /^(?=.{1,8192}$)[A-Za-z0-9_-]+={0,2}$/;
const escapeHTML = value => value.replace(/[&<>"']/g, char => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
})[char]);

export function isHydraRoute(method, pathname, projectId) {
  const prefix = `/oauth/${projectId}`;
  if (pathname === `${prefix}/phase0/consent`) return method === "GET" || method === "POST";
  return new Map([
    [`${prefix}/authorize`, "GET"], [`${prefix}/token`, "POST"],
    [`${prefix}/jwks`, "GET"], [`${prefix}/.well-known/openid-configuration`, "GET"],
    [`${prefix}/oauth2/auth`, "GET"], [`${prefix}/oauth2/token`, "POST"],
    [`${prefix}/.well-known/jwks.json`, "GET"],
    [`${prefix}/phase0/login`, "GET"], [`${prefix}/phase0/continue`, "GET"],
    [`${prefix}/phase0/accept`, "POST"],
  ]).get(pathname) === method;
}

async function currentSession(request, object, ownerRoute, issuer) {
  const cookie = request.headers.get("cookie") ?? "";
  const result = await object.session(cookie, "read", "", ownerRoute);
  if (result.status !== 200 || result.data?.project_id !== ownerRoute.projectId ||
      typeof result.data?.user_id !== "string" || typeof result.data?.session_id !== "string") {
    throw new Error("session unavailable");
  }
  return {
    cookie, identity: { issuer, projectId: ownerRoute.projectId, userId: result.data.user_id, sessionId: result.data.session_id },
  };
}

async function admin(env, method, path, body) {
  const result = await env.HYDRA_ISSUER_WORKER.admin(method, path, body ? JSON.stringify(body) : "");
  if (result.status !== 200) throw new Error(`Hydra challenge status ${Number(result.status) || 0}`);
  return JSON.parse(result.body);
}

function challenge(url, name) {
  const values = url.searchParams.getAll(name);
  return values.length === 1 && challengePattern.test(values[0]) ? values[0] : null;
}

function redirectToHydra(target, origin, prefix) {
  const url = new URL(target);
  if (url.origin !== origin || url.username || url.password || url.hash) throw new Error("invalid Hydra redirect");
  if (url.pathname === `${prefix}/oauth2/auth`) url.pathname = `${prefix}/authorize`;
  if (![ `${prefix}/authorize`, `${prefix}/phase0/login`, `${prefix}/phase0/consent` ].includes(url.pathname)) {
    throw new Error("unexpected Hydra redirect path");
  }
  return Response.redirect(url.toString(), 303);
}

async function csrfFor(object, session, route) {
  const result = await object.session(session.cookie, "csrf", "", route);
  if (result.status !== 200 || !/^[A-Za-z0-9_-]+$/.test(result.data?.csrf_token ?? "")) throw new Error("csrf unavailable");
  return result.data.csrf_token;
}

function relyingPartyOrigin(requestURL) {
  const authorization = new URL(requestURL);
  const redirects = authorization.searchParams.getAll("redirect_uri");
  if (redirects.length !== 1) throw new Error("invalid relying-party redirect");
  const redirect = new URL(redirects[0]);
  if (!(redirect.protocol === "https:" || (redirect.protocol === "http:" && redirect.hostname === "127.0.0.1")) ||
      redirect.username || redirect.password || !/^[A-Za-z0-9.:[\]-]+$/.test(redirect.host)) {
    throw new Error("invalid relying-party origin");
  }
  return redirect.origin;
}

function formPage(action, fields, label, relyingParty) {
  const inputs = Object.entries(fields).map(([name, value]) =>
    `<input type="hidden" name="${escapeHTML(name)}" value="${escapeHTML(value)}">`).join("");
  return new Response(`<!doctype html><html><head><meta charset="utf-8"><title>Continue</title></head><body><form method="post" action="${escapeHTML(action)}">${inputs}<button>${escapeHTML(label)}</button></form></body></html>`, {
    headers: { ...noStore, "content-type": "text/html; charset=utf-8", "content-security-policy": `default-src 'none'; form-action 'self' ${relyingParty}; base-uri 'none'; frame-ancestors 'none'`, "referrer-policy": "strict-origin" },
  });
}

export async function handleHydraIngress(request, env, object, route) {
  const url = new URL(request.url);
  const prefix = `/oauth/${route.projectId}`;
  const issuer = route.origin + prefix;
  if (url.origin !== route.origin || env.HYDRA_ISSUER !== issuer || url.search.length > 8192 ||
      !isHydraRoute(request.method, url.pathname, route.projectId)) return new Response(null, { status: 404, headers: noStore });
  const path = url.pathname.slice(prefix.length);
  let stage = "public";
  try {
    if (["/authorize", "/token", "/jwks", "/oauth2/auth", "/oauth2/token", "/.well-known/jwks.json", "/.well-known/openid-configuration"].includes(path)) {
      const mapped = new Map([["/authorize", "/oauth2/auth"], ["/token", "/oauth2/token"], ["/jwks", "/.well-known/jwks.json"]]).get(path) ?? path;
      const response = await env.HYDRA_ISSUER_WORKER.fetch(new Request(new URL(mapped + url.search, route.origin), request));
      if ((path === "/authorize" || path === "/oauth2/auth") && response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location) return new Response(null, { status: 503, headers: noStore });
        const destination = new URL(location, route.origin);
        const codes = destination.searchParams.getAll("code");
        if (codes.length > 1) return new Response(null, { status: 503, headers: noStore });
        if (codes.length === 1) {
          const session = await currentSession(request, object, route, issuer);
          if (await env.HYDRA_ISSUER_WORKER.bindCode(session.identity, codes[0]) !== true) throw new Error("grant binding unavailable");
        }
      }
      return response;
    }
    if (path === "/phase0/login") {
      const value = challenge(url, "login_challenge");
      if (!value || !await object.admitLogin(route)) return new Response(null, { status: 403, headers: noStore });
      const response = renderLogin(route.projectId);
      const html = (await response.text()).replace('post-sign-in-url="/app"', `post-sign-in-url="${prefix}/phase0/continue?challenge=${value}"`);
      return new Response(html, { status: response.status, headers: response.headers });
    }
    stage = "session";
    const session = await currentSession(request, object, route, issuer);
    if (path === "/phase0/continue") {
      const value = challenge(url, "challenge");
      if (!value) return new Response(null, { status: 400, headers: noStore });
      stage = "login-challenge";
      const login = await admin(env, "GET", "/admin/oauth2/auth/requests/login?login_challenge=" + encodeURIComponent(value));
      stage = "login-form";
      return formPage(`${prefix}/phase0/accept`, { challenge: value, csrf: await csrfFor(object, session, route) }, "Continue", relyingPartyOrigin(login.request_url));
    }
    if (path === "/phase0/consent" && request.method === "GET") {
      const value = challenge(url, "consent_challenge");
      if (!value) return new Response(null, { status: 400, headers: noStore });
      const consent = await admin(env, "GET", "/admin/oauth2/auth/requests/consent?consent_challenge=" + encodeURIComponent(value));
      if (consent.subject !== session.identity.userId || !Array.isArray(consent.requested_scope) ||
          consent.requested_scope.length > 32 || consent.requested_scope.some(scope => typeof scope !== "string" || scope.length > 256)) {
        return new Response(null, { status: 403, headers: noStore });
      }
      return formPage(`${prefix}/phase0/consent`, { challenge: value, csrf: await csrfFor(object, session, route) }, "Allow " + consent.requested_scope.join(", "), relyingPartyOrigin(consent.request_url));
    }
    if (request.method === "POST" && (path === "/phase0/accept" || path === "/phase0/consent")) {
      if (request.headers.get("origin") !== route.origin ||
          request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/x-www-form-urlencoded") {
        return new Response(null, { status: 403, headers: noStore });
      }
      const form = new URLSearchParams(await readBoundedText(request, 16384));
      const values = form.getAll("challenge"), tokens = form.getAll("csrf");
      if (values.length !== 1 || tokens.length !== 1 || !challengePattern.test(values[0]) ||
          tokens[0] !== await csrfFor(object, session, route)) return new Response(null, { status: 403, headers: noStore });
      const value = encodeURIComponent(values[0]);
      if (path === "/phase0/accept") {
        const accepted = await admin(env, "PUT", "/admin/oauth2/auth/requests/login/accept?login_challenge=" + value, { subject: session.identity.userId, remember: false });
        return redirectToHydra(accepted.redirect_to, route.origin, prefix);
      }
      const query = "?consent_challenge=" + value;
      const consent = await admin(env, "GET", "/admin/oauth2/auth/requests/consent" + query);
      if (consent.subject !== session.identity.userId || !Array.isArray(consent.requested_scope) ||
          consent.requested_scope.length > 32 || consent.requested_scope.some(scope => typeof scope !== "string" || scope.length > 256)) {
        return new Response(null, { status: 403, headers: noStore });
      }
      const accepted = await admin(env, "PUT", "/admin/oauth2/auth/requests/consent/accept" + query, { grant_scope: consent.requested_scope, remember: false });
      return redirectToHydra(accepted.redirect_to, route.origin, prefix);
    }
    return new Response(null, { status: 404, headers: noStore });
  } catch (error) {
    const status = /^Hydra challenge status \d+$/.test(error?.message ?? "") ? error.message : "unavailable";
    console.error(JSON.stringify({ event: "mapi.hydra.ingress", stage, status }));
    return new Response(null, { status: 503, headers: noStore });
  }
}
