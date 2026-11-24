// Local, disposable platform capability check only. It does not exercise the
// audit handler, transfer, real owners or any hosted service.
import assert from 'node:assert/strict';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
const source = `import { DurableObject } from 'cloudflare:workers';
export class Probe extends DurableObject {
  inspect() { return this.ctx.storage.sql.exec("SELECT COUNT(*) AS n FROM sqlite_temp_schema").one().n; }
}
export default {async fetch(req,env) { return new Response(JSON.stringify(await env.PROBE.getByName('test').inspect())); }};`;
let mf;
try {
  mf=new Miniflare(convertV4MiniflareOptions({host:'127.0.0.1',port:0,telemetry:{enabled:false},workers:[{
    name:'temp-schema-inspection',compatibilityDate:'2026-11-18',durableObjects:{PROBE:{className:'Probe',useSQLite:true}},modules:[{type:'ESModule',path:'worker.mjs',contents:source}],
  }]}));
  const response=await mf.dispatchFetch('http://localhost/');
  const body=await response.text();
  assert.equal(response.status,200,`TEMP schema inspection failed: ${body}`);
  assert.equal(JSON.parse(body),0);
  console.log('Local Workerd SQLite TEMP schema read returned an empty schema');
} finally { if(mf) await mf.dispose(); }
