import { NextgenProject } from '../worker/index.js';
import fixture from '../worker/generated/fixture.json';
export { NextgenProject };
export default { async fetch(request, env) {
  const headers = {};
  for (const [name, value] of request.headers) headers[name] = [value];
  if (headers['x-mapi-test-accept-encoding']) headers['accept-encoding'] = headers['x-mapi-test-accept-encoding'];
  const result = await env.NEXTGEN_PROJECT.getByName(fixture.projectId).handleRequest({ method: request.method, url: request.url, headers, body: '', peer: '127.0.0.1' });
  const outgoing = new Headers();
  for (const [name, values] of Object.entries(result.headers)) for (const value of values) outgoing.append(name, value);
  return new Response(result.body && request.method !== 'HEAD' && ![204, 304].includes(result.status) ? Uint8Array.fromBase64(result.body) : null, { status: result.status, headers: outgoing, encodeBody: "manual" });
}};
