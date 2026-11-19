import { DurableObject } from 'cloudflare:workers';
import wasm from '../worker/generated/dpop-spike.wasm';
import { instantiateReactor } from '../worker/wasi.js';
import { execute, sqliteError } from '../worker/sql.js';
const encoder = new TextEncoder(), decoder = new TextDecoder(), rejected = Symbol('Go transaction failed');
export class DPoPTest extends DurableObject {
 #reactor() {
  let reactor, output, memory;
  reactor = instantiateReactor(wasm, getMemory => { memory = getMemory; return {
   sql: (pointer,size) => { const query=JSON.parse(decoder.decode(new Uint8Array(memory(),pointer,size))); let result; try { result=execute(this.ctx.storage,query); } catch (error) { result={error:sqliteError(error)}; } output=encoder.encode(JSON.stringify(result)); return output.length; },
   result: (pointer,size) => { new Uint8Array(memory(),pointer,size).set(output); output=undefined; },
   transaction: () => { try { this.ctx.storage.transactionSync(() => { if (reactor.mapi_transaction_body() !== 0) throw rejected; }); return 0; } catch (error) { return error===rejected ? 1 : 2; } },
  }; });
  return { reactor, memory };
 }
 run() { const {reactor,memory}=this.#reactor(); const packed=reactor.run_dpop_tests(); return JSON.parse(decoder.decode(new Uint8Array(memory(),Number(packed>>32n),Number(packed&0xffffffffn)))); }
 verify(data) { const {reactor,memory}=this.#reactor(); const buf=encoder.encode(JSON.stringify(data)),ptr=reactor.mapi_alloc(buf.length); new Uint8Array(memory(),ptr,buf.length).set(buf); const packed=reactor.verify_dpop(); const result=JSON.parse(decoder.decode(new Uint8Array(memory(),Number(packed>>32n),Number(packed&0xffffffffn)))); reactor.mapi_release(); return result; }
 counts() { return { nonce: this.ctx.storage.sql.exec('SELECT COUNT(*) AS n FROM mapi_dpop_nonces').one().n, audit: this.ctx.storage.sql.exec('SELECT COUNT(*) AS n FROM mapi_dpop_nonce_audit').one().n }; }
 evict() { this.ctx.abort('synthetic DPoP test eviction'); }
}
export default { async fetch(request,env) {
 const u=new URL(request.url), object=env.DPOP_TEST.getByName('dpop-test');
 if (u.pathname==='/verify' && request.method==='POST') return Response.json(await object.verify(await request.json()));
 if (u.pathname==='/counts') return Response.json(await object.counts());
 if (u.pathname==='/evict') { try { await object.evict(); } catch { return new Response(null,{status:500}); } }
 return Response.json(await object.run());
}};
