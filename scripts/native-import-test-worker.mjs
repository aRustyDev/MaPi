// Test-only local harness. The imported native snapshot and master key are synthetic.
import { NextgenProject } from '../worker/generated/native-import-object.js';
import fixture from '../worker/generated/native-import-fixture.json';
export { NextgenProject };

export default { async fetch(request, env) {
  const url = new URL(request.url);
  if (env.MAPI_LOCAL_TEST !== '1' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) return new Response(null, { status: 404 });
  const project = env.PROJECT.getByName(fixture.projectId);
  if (url.pathname === '/__test/import' && request.method === 'POST') {
    const { failAfter, projectId } = await request.json();
    try { await project.importNative(projectId, failAfter); return Response.json({ ok: true }); }
    catch { return Response.json({ ok: false }, { status: 409 }); }
  }
  if (url.pathname === '/__test/state' && request.method === 'GET') return Response.json(await project.importState());
  if (url.pathname === '/__test/evict' && request.method === 'POST') {
    try { await project.evictImport(); } catch { return new Response(null, { status: 503 }); }
    return new Response(null, { status: 500 });
  }
  const headers = {};
  for (const [name, value] of request.headers) headers[name] = [value];
  const result = await project.handleRequest({ method: request.method, url: request.url, headers,
    body: new Uint8Array(await request.arrayBuffer()).toBase64(), peer: '127.0.0.1' });
  const outgoing = new Headers({ 'cache-control': 'no-store' });
  for (const [name, values] of Object.entries(result.headers ?? {})) for (const value of values) outgoing.append(name, value);
  return new Response(result.body && request.method !== 'HEAD' && ![204, 304].includes(result.status) ? Uint8Array.fromBase64(result.body) : null,
    { status: result.status, headers: outgoing, encodeBody: 'manual' });
} };
