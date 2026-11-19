import { NextgenProject } from '../worker/generated/session-extra-test-object.js';
import fixture from '../worker/generated/fixture.json';
import wasm from '../worker/generated/session-extra-test.wasm';
import { instantiateReactor } from '../worker/wasi.js';
export { NextgenProject };
export default { async fetch(request, env) {
  if (new URL(request.url).pathname === '/__mapi/init-probe') {
    if (env.MAPI_LOCAL_TEST !== '1' || !['localhost', '127.0.0.1'].includes(new URL(request.url).hostname)) return new Response(null, { status: 404 });
    let memory;
    const reactor = instantiateReactor(wasm, getMemory => { memory = getMemory; return { sql() { throw Error('unexpected SQL'); }, result() { throw Error('unexpected result'); }, transaction() { throw Error('unexpected transaction'); } }; });
    const encoder = new TextEncoder(), decoder = new TextDecoder();
    const run = input => {
      const bytes = encoder.encode(JSON.stringify(input)); const ptr = reactor.mapi_alloc(bytes.length); new Uint8Array(memory(), ptr, bytes.length).set(bytes);
      const result = reactor.mapi_init(), offset = Number(result >> 32n), size = Number(result & 0xffffffffn);
      const value = JSON.parse(decoder.decode(new Uint8Array(memory(), offset, size))); reactor.mapi_release(); return value.error;
    };
    const values = [null, 123, true, {}, []], out = { omitted: run({}) };
    for (const name of ['sessionDefaultTTL', 'sessionMaxTTL']) out[name] = values.map(value => run({ [name]: value }));
    return Response.json(out);
  }
  if (new URL(request.url).pathname === '/__mapi/ttl-binding-type') {
    if (env.MAPI_LOCAL_TEST !== '1' || !['localhost', '127.0.0.1'].includes(new URL(request.url).hostname)) return new Response(null, { status: 404 });
    const kind = value => value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
    return Response.json({ MAPI_SESSION_DEFAULT_TTL: kind(env.MAPI_SESSION_DEFAULT_TTL), MAPI_SESSION_MAX_TTL: kind(env.MAPI_SESSION_MAX_TTL) });
  }
  if (new URL(request.url).pathname === '/__mapi/test') {
    if (env.MAPI_LOCAL_TEST !== '1' || !['localhost', '127.0.0.1'].includes(new URL(request.url).hostname)) return new Response(null, { status: 404 });
    const { command, id } = await request.json();
    return Response.json(await env.NEXTGEN_PROJECT.getByName(fixture.projectId).test(command, id));
  }
  const headers = {};
  for (const [name, value] of request.headers) headers[name] = [value];
  const result = await env.NEXTGEN_PROJECT.getByName(fixture.projectId).handleRequest({ method: request.method, url: request.url, headers, body: new Uint8Array(await request.arrayBuffer()).toBase64(), peer: '127.0.0.1' });
  const outgoing = new Headers();
  for (const [name, values] of Object.entries(result.headers)) for (const value of values) outgoing.append(name, value);
  return new Response(result.body && request.method !== 'HEAD' && ![204, 304].includes(result.status) ? Uint8Array.fromBase64(result.body) : null, { status: result.status, headers: outgoing, encodeBody: 'manual' });
} };
