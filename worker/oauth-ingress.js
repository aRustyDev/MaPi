import { readBoundedBody } from './request-body.js';
// Narrow ingress for the opt-in local issuer. Discovery stays unavailable
// until the advertised profile has passed its conformance and security gates.
const noStore = { "cache-control": "no-store" };
const LIMIT = 65_536;
const operations = new Map([
  ["authorize", new Set(["GET"])], ["token", new Set(["POST"])],
  ["jwks", new Set(["GET"])], ["userinfo", new Set(["GET", "POST"])],
  ["revoke", new Set(["POST"])], ["end_session", new Set(["GET", "POST"])],
]);

export function isOAuthRoute(method, pathname, projectId) {
  if (pathname === "/oauth/continue") return method === "GET" || method === "POST";
  const prefix = `/oauth/${projectId}/`;
  if (!pathname.startsWith(prefix)) return false;
  return operations.get(pathname.slice(prefix.length))?.has(method) ?? false;
}

export async function handleOAuthIngress(request, object, projectId, origin, route) {
  const url = new URL(request.url);
  if (!isOAuthRoute(request.method, url.pathname, projectId)) return new Response(null, { status: 404, headers: noStore });
  if (url.origin !== origin || url.search.length > 8192) return new Response(null, { status: 403, headers: noStore });
  const suppliedOrigin = request.headers.get("origin");
  // Cross-origin navigations to authorize are expected. Session-bound writes
  // require Origin, and all other browser-origin writes are same-origin only.
  if ((request.method === "POST" && ["/oauth/continue", `/oauth/${projectId}/end_session`].includes(url.pathname) && suppliedOrigin !== origin) ||
      (request.method === "POST" && suppliedOrigin && suppliedOrigin !== origin)) return new Response(null, { status: 403, headers: noStore });
  const body = await readBoundedBody(request, LIMIT);
  if (body === null) return new Response(null, { status: 413, headers: noStore });
  const headers = {};
  for (const name of ["accept", "authorization", "content-type", "cookie", "origin", "referer", "user-agent"]) {
    if (request.headers.has(name)) headers[name] = [request.headers.get(name)];
  }
  const result = await object.oauthRequest({ method: request.method, url: request.url, headers, body: body.toBase64(), peer: request.headers.get("cf-connecting-ip") ?? "127.0.0.1" }, route ?? { projectId, origin });
  const outgoing = new Headers(noStore);
  const accepted = new Set(["content-type", "content-security-policy", "referrer-policy", "x-content-type-options", "location", "set-cookie", "www-authenticate", "retry-after"]);
  for (const [name, values] of Object.entries(result.headers)) if (accepted.has(name.toLowerCase())) for (const value of values) outgoing.append(name, value);
  outgoing.set("cache-control", "no-store");
  return new Response(result.body ? Uint8Array.fromBase64(result.body) : null, { status: result.status, headers: outgoing });
}
