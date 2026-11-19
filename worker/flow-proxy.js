// Browser-facing, same-origin subset of the SDK proxy. Project authority is
// added by the Durable Object for the exchange only, never by the browser.
const PREFIX = "/__nextgen";
const LIMIT = 65_536;
const noStore = { "cache-control": "no-store" };

function allowed(method, pathname) {
  return (method === "POST" && (pathname === "/api/v1/flows" || pathname === "/api/v1/sessions/exchange")) ||
    (method === "GET" && /^\/api\/v1\/flows\/flow_[A-Za-z0-9_-]+$/.test(pathname)) ||
    (method === "POST" && /^\/api\/v1\/flows\/flow_[A-Za-z0-9_-]+\/submit$/.test(pathname));
}

async function readBody(request) {
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.length;
    if (length > LIMIT) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.length; }
  return body;
}

/** Route only the login SDK calls to the project's Durable Object.
 * `expectedOrigin` is the canonical registered origin chosen by the registry;
 * the caller must resolve the object and projectId from that registry first.
 */
export async function handleFlowProxy(request, object, projectId, expectedOrigin) {
  const url = new URL(request.url);
  if (!url.pathname.startsWith(`${PREFIX}/`)) return new Response(null, { status: 404, headers: noStore });
  let pathname = url.pathname.slice(PREFIX.length);
  if (!pathname.startsWith("/api/v1/")) pathname = `/api/v1${pathname}`;
  if (!allowed(request.method, pathname)) return new Response(null, { status: 404, headers: noStore });

  const origin = request.headers.get("origin");
  if (url.origin !== expectedOrigin || (request.method !== "GET" && origin !== expectedOrigin) || (origin && origin !== expectedOrigin)) {
    return new Response(null, { status: 403, headers: noStore });
  }
  const queryProjects = url.searchParams.getAll("project_id");
  if (queryProjects.some((value) => value !== projectId) || queryProjects.length > 1 ||
      (pathname === "/api/v1/sessions/exchange" && queryProjects.length !== 1)) {
    return new Response(null, { status: 403, headers: noStore });
  }
  const body = await readBody(request);
  if (body === null) return new Response(null, { status: 413, headers: noStore });
  if (pathname === "/api/v1/flows") {
    try {
      if (JSON.parse(new TextDecoder().decode(body)).project_id !== projectId) return new Response(null, { status: 403, headers: noStore });
    } catch {
      return new Response(null, { status: 400, headers: noStore });
    }
  }

  const headers = {};
  for (const name of ["accept", "content-type", "cookie", "idempotency-key", "origin", "referer", "user-agent", "x-zitadel-csrf"]) {
    if (request.headers.has(name)) headers[name] = [request.headers.get(name)];
  }
  url.pathname = pathname;
  const result = await object.flowRequest({
    method: request.method, url: url.toString(), headers, body: body.toBase64(),
    peer: request.headers.get("cf-connecting-ip") ?? "127.0.0.1",
  });
  const outgoing = new Headers(noStore);
  for (const [name, values] of Object.entries(result.headers)) {
    // Do not pass hop-by-hop headers, redirects, or upstream cache policy.
    if (["content-type", "set-cookie", "retry-after", "www-authenticate"].includes(name.toLowerCase())) {
      for (const value of values) outgoing.append(name, value);
    }
  }
  outgoing.set("cache-control", "no-store");
  return new Response(result.body ? Uint8Array.fromBase64(result.body) : null, { status: result.status, headers: outgoing });
}
