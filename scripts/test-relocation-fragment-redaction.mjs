// Distinct synthetic parse-error check: no real owner, registry, history,
// platform limit, nonfinite-value, cursor-stress or hosted action is used.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

const source = `import { DurableObject } from 'cloudflare:workers';
import { beginChunkImport, importChunk } from './relocation-chunks.js';
const marker='synthetic-private-marker';
const hex=b=>[...new Uint8Array(b)].map(v=>v.toString(16).padStart(2,'0')).join('');
async function envelope(fragment) {
 const content=JSON.stringify({projectId:'p',generation:1,moveId:'m',index:0,prev:'',table:'users',columns:['id'],offset:0,rows:[],last:false,done:false,cursor:[{integer:'7'}],fragment});
 return {content,digest:hex(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(content)))};
}
export class Probe extends DurableObject {
 async run() {
  const s=this.ctx.storage;
  s.sql.exec('CREATE TABLE users (id INTEGER PRIMARY KEY)');
  beginChunkImport(s,'p',1,'m','destination',['users']);
  const cursor=[{integer:'7'}];
  const badBase64=await envelope({offset:0,total:3,data:marker,cursor});
  const invalidJSON=new TextEncoder().encode(marker+'"');
  const badRow=await envelope({offset:0,total:invalidJSON.length,data:invalidJSON.toBase64(),cursor});
  const badText=new TextEncoder().encode(JSON.stringify([{text:marker}]));
  const badTextRow=await envelope({offset:0,total:badText.length,data:badText.toBase64(),cursor});
  const badBlob=new TextEncoder().encode(JSON.stringify([{blob:marker}]));
  const badBlobRow=await envelope({offset:0,total:badBlob.length,data:badBlob.toBase64(),cursor});
  const invalidUtf8=new Uint8Array([0xff]);
  const badUTF8=await envelope({offset:0,total:1,data:invalidUtf8.toBase64(),cursor});
  const errors=[];
  for (const value of [badBase64,badRow,badTextRow,badBlobRow,badUTF8]) {
   try { await importChunk(s,'p',value); throw Error('unexpected success'); }
   catch(e) { errors.push({message:e.message,leaked:String(e.stack).includes(marker),cause:e.cause!==undefined}); }
  }
  const before={users:s.sql.exec('SELECT count(*) AS n FROM users').one().n,
   fragments:s.sql.exec('SELECT count(*) AS n FROM mapi_chunk_import_fragment_data').one().n,
   next:s.sql.exec('SELECT next_chunk FROM mapi_chunk_import WHERE project_id=?','p').one().next_chunk};
  const bytes=new TextEncoder().encode(JSON.stringify([{integer:'7'}]));
  const valid=await envelope({offset:0,total:bytes.length,data:bytes.toBase64(),cursor});
  await importChunk(s,'p',valid);
  await importChunk(s,'p',valid);
  return {errors,before,after:{users:s.sql.exec('SELECT count(*) AS n FROM users').one().n,
   fragments:s.sql.exec('SELECT count(*) AS n FROM mapi_chunk_import_fragment_data').one().n,
   next:s.sql.exec('SELECT next_chunk FROM mapi_chunk_import WHERE project_id=?','p').one().next_chunk}};
 }
}
export default { async fetch(request,env){return Response.json(await env.PROBE.getByName('redaction').run());} };`;

const modules = [{type:'ESModule',path:'worker.mjs',contents:source}];
for (const file of ['relocation-chunks.js','relocation.js','relocation-values.js','sql.js','foreign-keys.js']) {
  modules.push({type:'ESModule',path:file,contents:await readFile(`worker/${file}`,'utf8')});
}
const mf = new Miniflare(convertV4MiniflareOptions({host:'127.0.0.1',port:0,telemetry:{enabled:false},workers:[{
  name:'relocation-fragment-redaction',compatibilityDate:'2026-11-18',
  durableObjects:{PROBE:{className:'Probe',useSQLite:true}},modules,
}]}));
try {
  const response=await mf.dispatchFetch('http://localhost/');
  assert.equal(response.status,200);
  const result=await response.json();
  assert.deepEqual(result.errors.map(e=>e.message),['Invalid fragment data','Invalid fragment row','Invalid fragment row','Invalid fragment blob','Invalid fragment row']);
  assert.ok(result.errors.every(e=>!e.leaked && !e.cause));
  assert.deepEqual(result.before,{users:0,fragments:0,next:0});
  assert.deepEqual(result.after,{users:1,fragments:0,next:1});
  console.log('Private relocation fragment errors are redacted and roll back');
} finally { await mf.dispose(); }
