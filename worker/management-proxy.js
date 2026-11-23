import { logOverload } from './runtime-diagnostics.js';
import { readBoundedBody } from './request-body.js';
// Opt-in proxy for the experimental upstream user read/query adapter. It is
// deliberately not mounted by app.js. Routing and credentials remain separate.
const noStore = { 'cache-control': 'no-store' };
const maxBody = 65_536;
const acceptedHeaders = [
  'accept', 'authorization', 'content-type', 'cookie', 'idempotency-key',
  'origin', 'referer', 'sec-fetch-site', 'user-agent', 'x-zitadel-csrf',
];
const responseHeaders = new Set(['content-type', 'www-authenticate', 'retry-after', 'link', 'deprecation', 'set-cookie']);

export function isManagementRoute(method, path) {
  const normalized = path.replace(/^\/api\/v1(?=\/)/, '');
  return (method === 'POST' && normalized === '/users/query') ||
    (method === 'GET' && /^\/users\/user_[A-Za-z0-9_-]+$/.test(normalized));
}

export function isValidManagementRoute(route, origin) {
  return !!route && route.origin === origin &&
    typeof route.object_name === 'string' && !!route.object_name &&
    typeof route.project_id === 'string' && /^proj_[A-Za-z0-9_-]+$/.test(route.project_id);
}

// Existing projects under route maintenance return a retryable response;
// absent, mismatched and pending routes retain their normal 404 behavior.
export function isManagementRouteUnavailable(route) {
  return ["moving", "recovering", "migrating"].includes(route?.state);
}

/**
 * Registry and namespace are trusted bindings, not caller-supplied identifiers.
 * The caller selects this function only when the management feature is enabled.
 * A fresh authoritative registry lookup precedes every request.
 */
export async function handleManagementIngress(request, registry, namespace) {
  const url = new URL(request.url);
  if (!isManagementRoute(request.method, url.pathname)) return new Response(null, { status: 404, headers: noStore });
  try {
    const route = await registry.resolve(url.origin);
    if (!isValidManagementRoute(route, url.origin)) {
      return new Response(null, { status: 404, headers: noStore });
    }
    if (isManagementRouteUnavailable(route)) return new Response(null, { status: 503, headers: noStore });
    if (route.state !== 'active') return new Response(null, { status: 404, headers: noStore });
    const object = namespace.getByName(route.object_name);
    if (await object.identity() !== route.project_id) return new Response(null, { status: 503, headers: noStore });
    const origin = request.headers.get('origin');
    if ((origin && origin !== route.origin) ||
        (request.method !== 'GET' && request.headers.get('sec-fetch-site') === 'cross-site')) {
      return new Response(null, { status: 403, headers: noStore });
    }
    const projects = url.searchParams.getAll('project_id');
    if (projects.length > 1 || projects.some((project) => project !== route.project_id)) {
      return new Response(null, { status: 403, headers: noStore });
    }
    const body = await readBoundedBody(request, maxBody);
    if (body === null) return new Response(null, { status: 413, headers: noStore });
    const headers = {};
    for (const name of acceptedHeaders) if (request.headers.has(name)) headers[name] = [request.headers.get(name)];
    // Never forward Forwarded or X-Forwarded-* from the client; the trusted URL
    // and registry-bound origin are the only authority for the Go request host.
    const target = new URL(url.pathname + url.search, route.origin);
    const result = await object.handleRequest({
      method: request.method, url: target.toString(), headers,
      body: body.toBase64(), peer: request.headers.get('cf-connecting-ip') ?? '127.0.0.1',
    }, {
      projectId: route.project_id, origin: route.origin,
      objectName: route.object_name, generation: route.generation,
    });
    const outgoing = new Headers(noStore);
    for (const [name, values] of Object.entries(result.headers ?? {})) {
      if (responseHeaders.has(name.toLowerCase())) for (const value of values) outgoing.append(name, value);
    }
    const responseBody = result.body && ![204, 205, 304].includes(result.status) ? Uint8Array.fromBase64(result.body) : null;
    return new Response(responseBody, { status: result.status, headers: outgoing });
  } catch (error) {
    logOverload(error, 'management');
    // Do not log requests, user data, credentials, or upstream exceptions.
    return new Response(null, { status: 503, headers: noStore });
  }
}
