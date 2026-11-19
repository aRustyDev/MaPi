import { NextgenProject } from '../worker/generated/events-test-object.js';
import fixture from '../worker/generated/events-fixture.json';
export { NextgenProject };
export default { async fetch(request, env) {
 const headers = {}; for (const [key, value] of request.headers) headers[key] = [value];
 const result = await env.NEXTGEN_PROJECT.getByName(fixture.projectId).handleRequest({ method: request.method, url: request.url, headers, body: '', peer: '127.0.0.1' });
 const outgoing = new Headers(); for (const [name, values] of Object.entries(result.headers ?? {})) for (const value of values) outgoing.append(name, value);
 return new Response(result.body && ![204, 205, 304].includes(result.status) ? Uint8Array.fromBase64(result.body) : null, { status: result.status, headers: outgoing });
}};
