import { DurableObject } from 'cloudflare:workers';
import wasm from '../worker/generated/egress-spike.wasm';
import { instantiateReactor } from '../worker/wasi.js';
const encoder = new TextEncoder(), decoder = new TextDecoder('utf-8', { fatal: true });
const maxBytes = 16 * 1024, timeoutMs = 1500;
function origin(value) { const u = new URL(value); if (u.protocol !== 'https:' || u.hostname !== '127.0.0.1' || !u.port || u.username || u.password || u.pathname !== '/' || u.search || u.hash) throw Error('denied'); return u.origin; }
async function digest(value) { return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',encoder.encode(value))), b=>b.toString(16).padStart(2,'0')).join(''); }
export class CallbackSpike extends DurableObject {
 constructor(ctx,env) { super(ctx,env); this.sql=ctx.storage.sql; this.sql.exec(`CREATE TABLE IF NOT EXISTS callback_spike(id TEXT PRIMARY KEY,binding_hash TEXT NOT NULL,lease TEXT NOT NULL,state TEXT NOT NULL, result TEXT)`); this.sql.exec(`CREATE TABLE IF NOT EXISTS callback_spike_audit(id TEXT PRIMARY KEY,event TEXT NOT NULL)`); }
 call(data) { let memory; const reactor=instantiateReactor(wasm,mem=>{memory=mem;return {};}); try {const encoded=encoder.encode(JSON.stringify(data));if(encoded.length>100000)throw Error('size');const ptr=reactor.mapi_alloc(encoded.length);new Uint8Array(memory(),ptr,encoded.length).set(encoded);const out=reactor.mapi_idp_callback(),offset=Number(out>>32n),length=Number(out&0xffffffffn);return JSON.parse(decoder.decode(new Uint8Array(memory(),offset,length)));} finally {reactor.mapi_release();} }
 status(id) { const row=this.sql.exec('SELECT state,result FROM callback_spike WHERE id=?',id).toArray()[0];if(!row)return null;return {...row,auditCount:this.sql.exec('SELECT count(*) AS n FROM callback_spike_audit WHERE id=?',id).one().n}; }
 async run(a) {
  if(this.env.MAPI_LOCAL_TEST!=='1'||!/^[-a-z0-9]{1,80}$/.test(a.id)||typeof a.binding!=='string'||a.binding.length<16||a.binding.length>128)return {error:'denied'};
  let base;try {base=origin(this.env.MAPI_EGRESS_ORIGIN);if(a.issuer!==base)throw Error();}catch{return {error:'denied'};}
  const binding=await digest(a.binding), lease=crypto.randomUUID();
  const reserve=this.ctx.storage.transactionSync(()=>{const row=this.sql.exec('SELECT * FROM callback_spike WHERE id=?',a.id).toArray()[0];if(row){if(row.binding_hash!==binding)return {error:'denied'};if(row.state==='done')return {done:JSON.parse(row.result)};return {error:row.state==='failed'?'failed':'restart_required'};}this.sql.exec("INSERT INTO callback_spike VALUES(?,?,?,'pending',NULL)",a.id,binding,lease);return {};});
  if(reserve.error||reserve.done)return reserve.done??reserve;
  await this.ctx.storage.sync();
  const responses=[]; let result, failure;
  try { for(let step=0;step<5;step++) {
   const resumed=this.call({issuer:base,responses,code:'synthetic-code',nonce:'synthetic-nonce',verifier:'synthetic-verifier-abcdefghijklmnopqrstuvwxyz0123456789',secret:'synthetic-secret'});
   if(resumed.subject){result=resumed;break;} if(!resumed.next)throw Error('callback_failed');
   const intent=resumed.next, expected=[['GET','/.well-known/openid-configuration'],['POST','/token'],['GET','/keys'],['GET','/userinfo']][step];
   const target=new URL(intent.url);if(!expected||target.origin!==base||target.pathname!==expected[1]||target.search||target.hash||intent.method!==expected[0]||encoder.encode(intent.body??'').length>8192)throw Error('denied');
   const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeoutMs);let response;
   try {response=await fetch(intent.url,{method:intent.method,redirect:'manual',headers:{...(intent.authorization?{authorization:intent.authorization}:{}),...(intent.contentType?{'content-type':intent.contentType}:{}),accept:'application/json'},...(intent.method==='POST'?{body:intent.body}:{}),signal:controller.signal});
    if(response.status>=300&&response.status<400)throw Error('redirect'); const length=response.headers.get('content-length');if(length&&(!/^\d+$/.test(length)||Number(length)>maxBytes))throw Error('oversized');
    const chunks=[];let size=0;if(response.body){const reader=response.body.getReader();for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>maxBytes){await reader.cancel();throw Error('oversized');}chunks.push(value);}}
    const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
    responses.push({request:intent,status:response.status,body:decoder.decode(bytes),contentType:response.headers.get('content-type')??''});
   } catch(e) { if(controller.signal.aborted) throw Error('timeout'); throw e; } finally {clearTimeout(timer);}
   if(a.failStage==='after-token'&&intent.method==='POST')this.ctx.abort('synthetic interruption');
  } if(!result)throw Error('callback_failed'); } catch(e) {failure=['redirect','oversized','denied','callback_failed','timeout'].includes(e.message)?e.message:'network';}
  return this.ctx.storage.transactionSync(()=>{const row=this.sql.exec('SELECT lease,state,binding_hash FROM callback_spike WHERE id=?',a.id).toArray()[0];if(!row||row.lease!==lease||row.binding_hash!==binding||row.state!=='pending')return {error:'stale'};if(failure){this.sql.exec("UPDATE callback_spike SET state='failed' WHERE id=?",a.id);return {error:failure};}this.sql.exec("UPDATE callback_spike SET state='done',result=? WHERE id=?",JSON.stringify(result),a.id);this.sql.exec("INSERT INTO callback_spike_audit(id,event) VALUES(?,'callback_succeeded')",a.id);if(a.failStage==='commit')throw Error('synthetic transaction failure');return result;});
 }
}
export default {async fetch(request,env){const url=new URL(request.url);if(env.MAPI_LOCAL_TEST!=='1'||!['localhost','127.0.0.1'].includes(url.hostname)||request.method!=='POST'||request.headers.get('x-local-test-key')!==env.MAPI_TEST_KEY)return new Response(null,{status:404});try{const a=await request.json(),o=env.CALLBACK_SPIKE.getByName('local');if(url.pathname==='/run')return Response.json(await o.run(a));if(url.pathname==='/status')return Response.json(await o.status(a.id));}catch{return new Response(null,{status:500});}return new Response(null,{status:404});}};
