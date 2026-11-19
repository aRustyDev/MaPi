// Isolated local-only spike. Do not route this service to public traffic.
import wasm from '../worker/generated/argon-spike.wasm';
import { instantiateReactor } from '../worker/wasi.js';
const enc=new TextEncoder(),dec=new TextDecoder();
let reactor,memory;
function call(name,value) {
 if(!reactor){reactor=instantiateReactor(wasm,get=>{memory=get;return {};}); const r=reactor.mapi_init(); const result=JSON.parse(dec.decode(new Uint8Array(memory(),Number(r>>32n),Number(r&0xffffffffn)))); if(!result.ok)throw Error('initialization failed'); reactor.mapi_release();}
 const bytes=enc.encode(JSON.stringify(value));const ptr=reactor.mapi_alloc(bytes.length);new Uint8Array(memory(),ptr,bytes.length).set(bytes);bytes.fill(0);
 try { const packed=reactor[name]();const out=JSON.parse(dec.decode(new Uint8Array(memory(),Number(packed>>32n),Number(packed&0xffffffffn))));return {...out,wasmBytes:memory().byteLength}; } finally { reactor.mapi_release(); }
}
function authorize(request,secret) {
 if(typeof secret!=='string'||secret.length<32)return false;
 const a=enc.encode(request.headers.get('authorization')??''),b=enc.encode(`Bearer ${secret}`);
 if(a.length!==b.length)return false; let diff=0; for(let i=0;i<a.length;i++)diff|=a[i]^b[i];return diff===0;
}
async function readBounded(request,limit) {
 const reader=request.body?.getReader();if(!reader)return null;let total=0;const chunks=[];
 while(true){const {done,value}=await reader.read();if(done)break;total+=value.length;if(total>limit){await reader.cancel();return null;}chunks.push(value);}
 const bytes=new Uint8Array(total);let offset=0;for(const c of chunks){bytes.set(c,offset);offset+=c.length;}try{return JSON.parse(dec.decode(bytes));}catch{return null;}finally{bytes.fill(0);for(const c of chunks)c.fill(0);}
}
export default {async fetch(request,env){
 if(!authorize(request,env.ARGON_SPIKE_SECRET))return new Response(null,{status:401,headers:{'cache-control':'no-store'}});
 const path=new URL(request.url).pathname;if(request.method!=='POST'||!['/verify','/test-only/hash'].includes(path))return new Response(null,{status:404});
 const data=await readBounded(request,4096);if(!data||typeof data.password!=='string'||enc.encode(data.password).length>1024||!data.password)return new Response(null,{status:400});
 if(path==='/verify'&&(typeof data.hash!=='string'||data.hash.length>512||!/^\$argon2id\$v=19\$m=65536,t=3,p=4\$[A-Za-z0-9+/]+\$[A-Za-z0-9+/]+$/.test(data.hash)))return new Response(null,{status:400});
 const out=call(path==='/verify'?'mapi_verify':'mapi_hash',data);return Response.json(out,{headers:{'cache-control':'no-store'}});
}};
