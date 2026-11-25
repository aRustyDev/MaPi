import { DurableObject } from 'cloudflare:workers';
import wasm from './typedrows.wasm';
import { instantiateReactor } from './wasi.js';

// Local, unmounted demonstration of a narrow typed SQL projection. The
// cursor is consumed synchronously and remains inside its transaction.
const assert=(v,m)=>{if(!v) throw Error(m)};
const chunk=32768, enc=new TextEncoder();
export class Probe extends DurableObject {
  run(commit,nested,fault) {
    assert(!fault || ['corrupt','truncated','extra','early'].includes(fault),'invalid test fault');
    assert(!commit || !fault,'fault probe must roll back');
    const s=this.ctx.storage,q=s.sql;
    q.exec('CREATE TABLE IF NOT EXISTS item(id INTEGER PRIMARY KEY,v)');
    q.exec('CREATE TABLE IF NOT EXISTS audit(n INTEGER NOT NULL)');
    q.exec('DELETE FROM item');q.exec('DELETE FROM audit');q.exec('INSERT INTO audit VALUES(0)');
    q.exec('CREATE TRIGGER IF NOT EXISTS item_delete AFTER DELETE ON item BEGIN UPDATE audit SET n=n+1; END');
    if(nested)q.exec('CREATE TRIGGER IF NOT EXISTS nested_delete AFTER DELETE ON item WHEN OLD.id=1 BEGIN DELETE FROM item WHERE id=2; END');
    const schema=()=>JSON.stringify(q.exec("SELECT type,name,sql FROM sqlite_schema WHERE type IN ('table','index','trigger','view') ORDER BY type,name").raw().toArray());
    const beforeSchema=schema();
    const size=8388530, blob=new Uint8Array(size);
    blob.set([255,0,0,0,0,0,0,0,0]);blob.set(enc.encode('@MaPiRun1'),9);
    for(let i=0;i<65;i++) blob[18+Math.floor((size-18-64)*(i+1)/66)]=i+1;
    let iterator, pending, column=0, rowIndex=0, offset=0, out, maxWire=0, maxPages=0, closed=0;
    const intBytes=n=>{const a=new Uint8Array(8);new DataView(a.buffer).setBigInt64(0,BigInt(n));return a};
    const cell=()=>{
      if(column===0) return {kind:1,data:intBytes(pending[0])};
      const kind=pending[1],value=pending[2];
      if(kind==='null') return {kind:0,data:new Uint8Array(0)};
      if(kind==='integer') return {kind:1,data:intBytes(value)};
      if(kind==='real') {const b=new Uint8Array(8);new DataView(b.buffer).setFloat64(0,value);return {kind:2,data:b};}
      if(kind==='text') return {kind:3,data:enc.encode(value)};
      if(kind==='blob') return {kind:4,data:new Uint8Array(value)};
      throw Error('unexpected SQLite kind');
    };
    let cellData;
    const next=()=>{
      if(fault==='truncated' && rowIndex===5 && !pending)return 0;
      if(!pending){const nextRow=iterator.next();if(nextRow.done)return 0;pending=nextRow.value;column=0;offset=0;}
      if(!cellData) cellData=cell();
      const end=Math.min(offset+chunk,cellData.data.length), final=end===cellData.data.length;
      const frame={Row:rowIndex,Column:column,Offset:offset,Total:cellData.data.length,Kind:cellData.kind,Final:final,Data:cellData.data.subarray(offset,end).toBase64()};
      if(fault==='corrupt' && rowIndex===0 && column===1)frame.Row++;
      out=enc.encode(JSON.stringify(frame));maxWire=Math.max(maxWire,out.length);
      if(final){offset=0;cellData=undefined;column++;if(column===2){column=0;pending=undefined;rowIndex++;}}else offset=end;
      return out.length;
    };
    const reactor=instantiateReactor(wasm,memory=>({
      next(){maxPages=Math.max(maxPages,memory().byteLength/65536);return next();},
      result(ptr,n){assert(out && out.length===n,'host result length mismatch');new Uint8Array(memory(),ptr,n).set(out);out=undefined;},
      close(){while(!iterator.next().done){};closed++;return 0;},
    }));
    const rollback='typed source rollback';let result;
    try {s.transactionSync(()=>{
      q.exec("INSERT INTO item(id,v) VALUES(1,9223372036854775807),(2,-9223372036854775808),(3,'9223372036854775807'),(4,X'00FF'),(5,3.5),(6,NULL),(7,X''),(8,''),(9,1e999)");
      q.exec('INSERT INTO item(id,v) VALUES(10,?)',blob);
      // Dynamic storage class is explicit, but this consumes an extra result
      // column and is therefore not a general 100-column RETURNING solution.
      iterator=q.exec("DELETE FROM item RETURNING id,typeof(v),CASE WHEN typeof(v)='integer' THEN printf('%lld',v) ELSE v END").raw()[Symbol.iterator]();
      result=reactor.mapi_typed_check((nested?1:0)|(fault==='extra'?2:0)|(fault==='early'?4:0));maxPages=Math.max(maxPages,reactor.memory.buffer.byteLength/65536);
      if(fault){assert((fault==='early'?result===0:result!==0) && closed===1,'unexpected stream result or cursor not drained');throw Error('test stream rollback');}
      assert(result===0,`Go typed consumer failed ${result}`);
      assert(rowIndex===(nested?9:10) && closed===1 && q.exec('SELECT n FROM audit').one().n===10,'unexpected row or audit count');
      if(!commit) throw Error(rollback);
    });if(!commit)throw Error('expected rollback');}catch(error){if(commit || error.message!==(fault?'test stream rollback':rollback))throw error;}
    assert(q.exec('SELECT count(*) AS n FROM item').one().n===0,'business row survived');
    assert(q.exec('SELECT n FROM audit').one().n===(commit?10:0),'audit result differs');
    assert(schema()===beforeSchema,'streaming changed schema');
    return {ok:true,commit,nested,fault,rows:rowIndex,closed,maxWire,maxPages};
  }
}
export default {async fetch(req,env){try{const p=new URL(req.url).searchParams;return Response.json(await env.PROBE.getByName(crypto.randomUUID()).run(p.has('commit'),p.has('nested'),p.get('fault')));}catch(error){return Response.json({error:String(error),stack:error.stack},{status:500});}}};
