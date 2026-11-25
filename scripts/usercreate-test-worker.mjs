import { NextgenProject as UserCreateProject } from '../worker/generated/usercreate-test-object.js';
import fixture from '../worker/generated/fixture.json';
export class NextgenProject extends UserCreateProject {
  test(command, id) {
    if (command === 'text_probe_bytes') {
      return this.ctx.storage.sql.exec("SELECT hex(value) AS bytes FROM user_attributes WHERE project_id = ? AND user_id = ? AND key = 'text_probe'", fixture.projectId, id).toArray()[0] ?? null;
    }
    return super.test(command, id);
  }
}
export default { async fetch(request, env) {
  if (new URL(request.url).pathname === '/__mapi/test') {
    if(env.MAPI_LOCAL_TEST!=='1' || !['localhost','127.0.0.1'].includes(new URL(request.url).hostname)) return new Response(null,{status:404});
    const {command,id}=await request.json();return Response.json(await env.NEXTGEN_PROJECT.getByName(fixture.projectId).test(command,id));
  }
  const headers = {};
  for (const [name, value] of request.headers) headers[name] = [value];
  const result = await env.NEXTGEN_PROJECT.getByName(fixture.projectId).handleRequest({ method: request.method, url: request.url, headers, body: new Uint8Array(await request.arrayBuffer()).toBase64(), peer: '127.0.0.1' });
  const outgoing = new Headers();
  for (const [name, values] of Object.entries(result.headers)) for (const value of values) outgoing.append(name, value);
  return new Response(result.body && request.method !== 'HEAD' && ![204, 304].includes(result.status) ? Uint8Array.fromBase64(result.body) : null, { status: result.status, headers: outgoing, encodeBody: "manual" });
}};
