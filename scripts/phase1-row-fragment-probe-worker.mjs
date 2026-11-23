// Disposable local feasibility probe. Not production relocation code.
import {DurableObject} from 'cloudflare:workers';
import {allowsLocalProbe} from './phase1-row-fragment-policy.mjs';
const FRAME=80*1024, SIZE=8_388_520;
const digest=async text=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text)))).map(b=>b.toString(16).padStart(2,'0')).join('');
const first=(sql,query,...args)=>sql.exec(query,...args).toArray()[0];
export class Probe extends DurableObject {
  bootId=crypto.randomUUID();
  boot(){return this.bootId;}
  initSource() {
    const s=this.ctx.storage,sql=s.sql;
    s.transactionSync(()=>{
      sql.exec('CREATE TABLE original (id INTEGER PRIMARY KEY, large TEXT, minval INTEGER, maxval INTEGER, realval REAL, nullable TEXT, numbertext TEXT, binary BLOB)');
      sql.exec("INSERT INTO original VALUES (1, ?, CAST('-9223372036854775808' AS INTEGER), CAST('9223372036854775807' AS INTEGER), 0.5, NULL, '9223372036854775807', x'00ff1080')", 'x'.repeat(FRAME-1)+'🍩'+'x'.repeat(SIZE-FRAME-6)+'é\0');
    });
    return this.state();
  }
  metadata(){return this.ctx.storage.sql.exec("SELECT printf('%lld',minval) AS minval,printf('%lld',maxval) AS maxval,realval,nullable,numbertext,hex(binary) AS binary FROM original WHERE id=1").one();}
  initTarget(meta){const sql=this.ctx.storage.sql;this.ctx.storage.transactionSync(()=>{sql.exec('CREATE TABLE restored (id INTEGER PRIMARY KEY, large TEXT, minval INTEGER, maxval INTEGER, realval REAL, nullable TEXT, numbertext TEXT, binary BLOB)');sql.exec('CREATE TABLE frames (n INTEGER PRIMARY KEY, data BLOB NOT NULL, hash TEXT NOT NULL)');sql.exec('CREATE TABLE checkpoint (id INTEGER PRIMARY KEY, next INTEGER NOT NULL, complete INTEGER NOT NULL, meta TEXT NOT NULL)');sql.exec('INSERT INTO checkpoint VALUES (1,0,0,?)',JSON.stringify(meta));});}
  state() {const sql=this.ctx.storage.sql;return sql.exec("SELECT length(CAST(large AS BLOB)) AS bytes, typeof(large) AS largetype, printf('%lld',minval) AS minval, typeof(minval) AS mintype, printf('%lld',maxval) AS maxval, typeof(maxval) AS maxtype, realval, typeof(realval) AS realtype, typeof(nullable) AS nulltype, numbertext, typeof(numbertext) AS numbertype, hex(binary) AS binary, typeof(binary) AS binarytype, hex(substr(CAST(large AS BLOB),-7)) AS tail FROM original WHERE id=1").one();}
  targetState(){const sql=this.ctx.storage.sql;return sql.exec("SELECT length(CAST(large AS BLOB)) AS bytes, typeof(large) AS largetype, printf('%lld',minval) AS minval, typeof(minval) AS mintype, printf('%lld',maxval) AS maxval, typeof(maxval) AS maxtype, realval, typeof(realval) AS realtype, typeof(nullable) AS nulltype, numbertext, typeof(numbertext) AS numbertype, hex(binary) AS binary, typeof(binary) AS binarytype, hex(substr(CAST(large AS BLOB),-7)) AS tail FROM restored WHERE id=1").one();}
  async frame(n){if(!Number.isSafeInteger(n)||n<0||n>=Math.ceil(SIZE/FRAME))throw Error('bad frame');const bytes=this.ctx.storage.sql.exec('SELECT substr(CAST(large AS BLOB),?,?) AS part FROM original WHERE id=1',n*FRAME+1,FRAME).one().part; const content=JSON.stringify({n,data:new Uint8Array(bytes).toBase64()});return {content,digest:await digest(content)};}
  async restoredFrame(n){if(!Number.isSafeInteger(n)||n<0||n>=Math.ceil(SIZE/FRAME))throw Error('bad frame');const bytes=this.ctx.storage.sql.exec('SELECT substr(CAST(large AS BLOB),?,?) AS part FROM restored WHERE id=1',n*FRAME+1,FRAME).one().part;const content=JSON.stringify({n,data:new Uint8Array(bytes).toBase64()});return {digest:await digest(content)};}
  status(){return this.ctx.storage.sql.exec('SELECT next, complete FROM checkpoint WHERE id=1').one();}
  counts(){return {frames:this.ctx.storage.sql.exec('SELECT count(*) AS n FROM frames').one().n,rows:this.ctx.storage.sql.exec('SELECT count(*) AS n FROM restored').one().n};}
  async apply(envelope,fail=false){
    if(typeof envelope.content!=='string'||new TextEncoder().encode(envelope.content).length>128*1024||await digest(envelope.content)!==envelope.digest)throw Error('bad digest');
    const {n,data}=JSON.parse(envelope.content);const raw=Uint8Array.fromBase64(data);
    return this.ctx.storage.transactionSync(()=>{const sql=this.ctx.storage.sql,c=this.status();if(n<c.next){if(first(sql,'SELECT hash FROM frames WHERE n=?',n)?.hash!==envelope.digest)throw Error('conflicting replay');return c;}
      if(c.complete||n!==c.next||raw.byteLength===0||raw.byteLength>FRAME)throw Error('bad cursor');
      sql.exec('INSERT INTO frames VALUES (?,?,?)',n,raw.buffer,envelope.digest);if(fail)throw Error('injected rollback');sql.exec('UPDATE checkpoint SET next=next+1 WHERE id=1');return this.status();});
  }
  finish(fail=false){return this.ctx.storage.transactionSync(()=>{const sql=this.ctx.storage.sql,c=this.status(),n=Math.ceil(SIZE/FRAME);if(c.complete)return this.targetState();if(c.next!==n)throw Error('not complete');const meta=JSON.parse(sql.exec('SELECT meta FROM checkpoint WHERE id=1').one().meta);
    sql.exec(`WITH RECURSIVE assembly(i,data) AS (SELECT 0,x'' UNION ALL SELECT i+1,CAST(data || (SELECT data FROM frames WHERE n=i) AS BLOB) FROM assembly WHERE i < ?) INSERT INTO restored SELECT 1,CAST(data AS TEXT),CAST(? AS INTEGER),CAST(? AS INTEGER),CAST(? AS REAL),?,?,? FROM assembly WHERE i=?`,n,meta.minval,meta.maxval,meta.realval,meta.nullable,meta.numbertext,Uint8Array.fromHex(meta.binary).buffer,n);
    if(fail)throw Error('injected commit rollback');sql.exec('UPDATE checkpoint SET complete=1 WHERE id=1');return this.targetState();});}
  evict(){this.ctx.abort('injected object eviction');}
}
export default {async fetch(request,env){if(!allowsLocalProbe(request,env))return new Response(null,{status:404});try{const b=await request.json(),source=env.OBJECT.getByName('source'),target=env.OBJECT.getByName('target');let value;
  if(b.action==='init'){const st=await source.initSource();await target.initTarget(await source.metadata());value=st;}
  else if(b.action==='frame')value=await source.frame(b.n);
  else if(b.action==='apply')value=await target.apply(b.envelope,b.fail);
  else if(b.action==='status')value=await target.status();
  else if(b.action==='counts')value=await target.counts();
  else if(b.action==='boot')value=await (b.object==='source'?source:target).boot();
  else if(b.action==='finish')value=await target.finish(b.fail);
  else if(b.action==='source')value=await source.state();
  else if(b.action==='target-frame')value=await target.restoredFrame(b.n);
  else if(b.action==='evict')value=await (b.object==='source'?source:target).evict();
  else throw Error('bad action');return Response.json(value??true);
}catch(e){return Response.json({error:String(e)},{status:500});}}};
