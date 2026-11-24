import { DurableObject } from 'cloudflare:workers';
import { execute } from '../../worker/sql.js';

// Feasibility experiment only. This is not an authenticated production spill
// service, is not exported by the application, and uses a throwaway key.
const FRAME_BYTES = 32768;
const assert = (condition, message) => { if (!condition) throw Error(message); };
const aad = (context, seq, offset, total, kind='blob') => new TextEncoder().encode(JSON.stringify([
  'mapi-result-spill-test-v1', context.project, context.owner, context.generation,
  context.handle, 'row', 0, 'column', 0, kind, seq, offset, total,
]));
function nonce(prefix, seq) {
  const result = new Uint8Array(12); result.set(prefix);
  new DataView(result.buffer).setBigUint64(4, BigInt(seq));
  return result;
}
function equal(a, b) {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false;
  return true;
}
// Chain ciphertext rather than plaintext so ordering and exact stored bytes
// can be checked without materializing the complete result in the spill.
async function chain(previous, encrypted) {
  const joined=new Uint8Array(previous.length+encrypted.byteLength);
  joined.set(previous);joined.set(new Uint8Array(encrypted),previous.length);
  return new Uint8Array(await crypto.subtle.digest('SHA-256',joined));
}
export class Spill extends DurableObject {
  async put(seq, encrypted) {
    const s = this.ctx.storage, bytes = new Uint8Array(encrypted);
    assert(Number.isSafeInteger(seq) && seq >= 0 && bytes.length <= FRAME_BYTES + 16, 'invalid frame');
    return s.transactionSync(() => {
      const q = s.sql;
      q.exec('CREATE TABLE IF NOT EXISTS frames(seq INTEGER PRIMARY KEY, value BLOB NOT NULL)');
      q.exec('CREATE TABLE IF NOT EXISTS progress(id INTEGER PRIMARY KEY CHECK(id=1), next INTEGER NOT NULL, seal BLOB)');
      q.exec('INSERT OR IGNORE INTO progress VALUES(1,0,NULL)');
      const existing = q.exec('SELECT value FROM frames WHERE seq=?', seq).raw().toArray();
      if (existing.length) {
        assert(equal(new Uint8Array(existing[0][0]), bytes), 'conflicting replay');
        return 'replayed';
      }
      const progress=q.exec('SELECT next,seal FROM progress WHERE id=1').one();
      assert(progress.seal===null && progress.next===seq, 'sealed or out-of-order frame');
      q.exec('INSERT INTO frames VALUES (?,?)', seq, bytes);
      q.exec('UPDATE progress SET next=next+1 WHERE id=1');
      return 'stored';
    });
  }
  async seal(seq, encrypted) {
    const s=this.ctx.storage, bytes=new Uint8Array(encrypted);
    assert(Number.isSafeInteger(seq) && seq>=0 && bytes.length<=1024,'invalid seal');
    return s.transactionSync(()=>{
      const q=s.sql, progress=q.exec('SELECT next,seal FROM progress WHERE id=1').one();
      assert(progress.next===seq,'incomplete spill');
      if(progress.seal!==null) {assert(equal(new Uint8Array(progress.seal),bytes),'conflicting seal');return 'replayed';}
      q.exec('UPDATE progress SET seal=? WHERE id=1',bytes);return 'sealed';
    });
  }
  async readSeal() {
    const row=this.ctx.storage.sql.exec('SELECT seal FROM progress WHERE id=1').one();
    assert(row.seal!==null,'unsealed spill');return row.seal;
  }
  // Fault injection exists only in this disposable experiment.
  async swapFirstFrames() {
    this.ctx.storage.transactionSync(()=>{
      const q=this.ctx.storage.sql, rows=q.exec('SELECT seq,value FROM frames WHERE seq IN(0,1) ORDER BY seq').raw().toArray();
      assert(rows.length===2,'missing swap frames');
      q.exec('UPDATE frames SET value=? WHERE seq=0',rows[1][1]);
      q.exec('UPDATE frames SET value=? WHERE seq=1',rows[0][1]);
    });
  }
  async deleteFrame(seq) {this.ctx.storage.sql.exec('DELETE FROM frames WHERE seq=?',seq);}
  async get(seq) {
    const result = this.ctx.storage.sql.exec('SELECT value FROM frames WHERE seq=?', seq).raw().toArray();
    assert(result.length === 1, 'missing frame');
    return result[0][0];
  }
  async clear() { this.ctx.storage.transactionSync(()=>{this.ctx.storage.sql.exec('DELETE FROM frames');this.ctx.storage.sql.exec('UPDATE progress SET next=0,seal=NULL WHERE id=1');}); }
  async count() { return this.ctx.storage.sql.exec('SELECT COUNT(*) AS n FROM frames').one().n; }
  async restart() { this.ctx.abort('intentional synthetic spill restart'); }
}
export class Owner extends DurableObject {
  async multirow(nested, ctas, commit) {
    assert(!commit || ctas,'commit probe requires CTAS');
    const s=this.ctx.storage, q=s.sql;
    q.exec('CREATE TABLE IF NOT EXISTS batch(id INTEGER PRIMARY KEY,v)');
    q.exec('CREATE TABLE IF NOT EXISTS batch_audit(n INTEGER NOT NULL)');
    q.exec('CREATE TABLE IF NOT EXISTS sentinel(id INTEGER PRIMARY KEY)');
    q.exec('CREATE TABLE IF NOT EXISTS stage(seq INTEGER PRIMARY KEY,payload TEXT NOT NULL) WITHOUT ROWID');
    q.exec('CREATE TRIGGER IF NOT EXISTS batch_deleted AFTER DELETE ON batch BEGIN UPDATE batch_audit SET n=n+1; END');
    if(nested) q.exec('CREATE TRIGGER IF NOT EXISTS batch_nested AFTER DELETE ON batch WHEN OLD.id=1 BEGIN DELETE FROM batch WHERE id=2; END');
    q.exec('DELETE FROM batch');q.exec('DELETE FROM stage');q.exec('DELETE FROM batch_audit');q.exec('INSERT INTO batch_audit VALUES(0)');q.exec('DELETE FROM sentinel');
    const statement="DELETE FROM batch RETURNING id,typeof(v),CASE WHEN typeof(v)='integer' THEN printf('%lld',v) ELSE v END,changes(),last_insert_rowid(),total_changes()";
    function seed() {
      q.exec("INSERT INTO batch(id,v) VALUES(1,9223372036854775807),(2,-9223372036854775808),(3,'9007199254740993'),(4,X'00FF'),(5,3.5),(6,NULL),(7,X''),(8,''),(9,1e999)");
      q.exec('INSERT INTO sentinel VALUES(424242)');
    }
    function normalize(row,baseTotal) {
      const [id,kind,value,changes,lastId,total]=row;
      let encoded=value;
      if(kind==='blob') encoded=new Uint8Array(value).toBase64();
      if(kind==='real') {const bits=new DataView(new ArrayBuffer(8));bits.setFloat64(0,value);encoded=bits.getBigUint64(0).toString(16).padStart(16,'0');}
      return JSON.stringify([id,kind,encoded,changes,lastId,total-baseTotal]);
    }
    function counters() {return q.exec('SELECT changes() AS n,last_insert_rowid() AS id,total_changes() AS total').one();}
    function stageObjects() {return q.exec("SELECT COUNT(*) AS n FROM sqlite_schema WHERE type='table' AND name GLOB 'mapi_probe_stage_*'").one().n;}
    let baseline, baselineCounters, baselineStart, baselineSchema;
    try {s.transactionSync(()=>{
      seed();baselineStart=counters().total;baseline=q.exec(statement).raw().toArray().map(row=>normalize(row,baselineStart));baselineCounters=counters();baselineSchema=stageObjects();
      assert(baseline.length===(nested?8:9),'direct multirow baseline differs');
      throw Error('baseline rollback');
    });}catch(error){if(error.message!=='baseline rollback') throw error;}
    const baselineAfterRollback=counters();
    assert(q.exec('SELECT COUNT(*) AS n FROM batch').one().n===0 && q.exec('SELECT n FROM batch_audit').one().n===0,'baseline rollback changed data');
    const expectedValues=[[1,'integer','9223372036854775807'],[2,'integer','-9223372036854775808'],[3,'text','9007199254740993'],[4,'blob','AP8='],[5,'real','400c000000000000'],[6,'null',null],[7,'blob',''],[8,'text',''],[9,'real','7ff0000000000000']].filter(row=>!nested || row[0]!==2);
    const basic=baseline.map(row=>JSON.parse(row).slice(0,3)).sort((a,b)=>a[0]-b[0]);
    assert(JSON.stringify(basic)===JSON.stringify(expectedValues),'direct mixed types do not match expected values');
    const handle=crypto.randomUUID(), spill=this.env.SPILL.getByName(handle);
    const context={project:'synthetic-project',owner:'synthetic-owner',generation:1,handle};
    const key=await crypto.subtle.generateKey({name:'AES-GCM',length:256},false,['encrypt','decrypt']);
    const prefix=crypto.getRandomValues(new Uint8Array(4));let seq=0, observedCounters, observedSchema, stageStart, digest=new Uint8Array(32);const stagedOrder=[];
    try {await s.transaction(async()=>{
      seed();stageStart=counters().total;const cursor=q.exec(statement).raw()[Symbol.iterator]();
      while(true){const result=cursor.next();if(result.done) break;const payload=normalize(result.value,stageStart);assert(new TextEncoder().encode(payload).length<1024,'test row exceeds bound');stagedOrder.push(payload);if(ctas) q.exec(`CREATE TABLE mapi_probe_stage_${seq} AS SELECT ? AS payload`,payload);else q.exec('INSERT INTO stage VALUES (?,?)',seq,payload);seq++;}
      const beforeRepair=counters();
      if(ctas) {
        observedCounters=beforeRepair;
        assert(observedCounters.n===baselineCounters.n && observedCounters.id===baselineCounters.id && observedCounters.total-stageStart===baselineCounters.total-baselineStart,'CTAS changed connection-local counters');
      } else {
        assert(beforeRepair.n!==baselineCounters.n && beforeRepair.id===baselineCounters.id,'expected changes() difference or unexpected last_insert_rowid()');
        // Restore changes() for this one known statement by updating exactly one
        // private WITHOUT ROWID stage row per returned row. This intentionally
        // adds writes and cannot restore total_changes().
        q.exec('UPDATE stage SET payload=payload');
        observedCounters=counters();
        assert(observedCounters.n===baselineCounters.n && observedCounters.id===baselineCounters.id,'repair did not restore connection-local counters');
        assert(observedCounters.total-stageStart>baselineCounters.total-baselineStart,'expected total_changes() divergence');
      }
      assert(seq===(nested?8:9) && q.exec('SELECT n FROM batch_audit').one().n===9,'staged mutation count differs');
      observedSchema=stageObjects();
      assert(observedSchema===baselineSchema+(ctas?seq:0),'unexpected visible stage-table count');
      // The source cursor is exhausted before the first await. Each staging
      // lookup is fully consumed before its corresponding spill RPC.
      for(let i=0;i<seq;i++){
        const payload=ctas?q.exec(`SELECT payload FROM mapi_probe_stage_${i}`).one().payload:q.exec('SELECT payload FROM stage WHERE seq=?',i).one().payload;
        const bytes=new TextEncoder().encode(payload);
        const encrypted=await crypto.subtle.encrypt({name:'AES-GCM',iv:nonce(prefix,i),additionalData:aad(context,i,0,bytes.length)},key,bytes);
        assert(await spill.put(i,encrypted)==='stored','multirow spill failed');digest=await chain(digest,encrypted);
      }
      const manifest=new TextEncoder().encode(JSON.stringify({frames:seq,chain:digest.toBase64()}));
      const sealed=await crypto.subtle.encrypt({name:'AES-GCM',iv:nonce(prefix,seq),additionalData:aad(context,seq,0,0,'seal')},key,manifest);
      assert(await spill.seal(seq,sealed)==='sealed','multirow seal failed');
      if(commit) {
        for(let i=0;i<seq;i++) q.exec(`DROP TABLE mapi_probe_stage_${i}`);
        const cleaned=counters();
        assert(cleaned.n===baselineCounters.n && cleaned.id===baselineCounters.id && cleaned.total-stageStart===baselineCounters.total-baselineStart,'committed CTAS cleanup changed connection counters');
        assert(stageObjects()===baselineSchema,'CTAS tables survived commit cleanup');
      } else throw Error('multirow rollback');
    });assert(commit,'rollback was not triggered');}catch(error){if(commit || error.message!=='multirow rollback') throw error;}
    const afterTransaction=counters();
    assert(afterTransaction.n===baselineAfterRollback.n && afterTransaction.id===baselineAfterRollback.id,'post-transaction connection counters differ');
    assert(afterTransaction.total>=observedCounters.total,'transaction unexpectedly restored total_changes()');
    assert(q.exec('SELECT COUNT(*) AS n FROM batch').one().n===0 && q.exec('SELECT COUNT(*) AS n FROM stage').one().n===0 && q.exec('SELECT n FROM batch_audit').one().n===(commit?9:0),'multirow transaction state differs');
    assert(stageObjects()===baselineSchema,'CTAS tables survived transaction');
    const sealed=await spill.readSeal();const manifest=JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({name:'AES-GCM',iv:nonce(prefix,seq),additionalData:aad(context,seq,0,0,'seal')},key,sealed)));
    assert(manifest.frames===seq,'multirow seal count changed');let readDigest=new Uint8Array(32);const actual=[];
    for(let i=0;i<seq;i++){
      const ciphertext=await spill.get(i);readDigest=await chain(readDigest,ciphertext);
      const length=new Uint8Array(ciphertext).length-16;
      actual.push(new TextDecoder().decode(await crypto.subtle.decrypt({name:'AES-GCM',iv:nonce(prefix,i),additionalData:aad(context,i,0,length)},key,ciphertext)));
    }
    const byId=rows=>rows.map(row=>JSON.parse(row)).sort((a,b)=>a[0]-b[0]);
    assert(readDigest.toBase64()===manifest.chain && JSON.stringify(actual)===JSON.stringify(stagedOrder) && JSON.stringify(byId(actual))===JSON.stringify(byId(baseline)),'multirow result changed after rollback');
    await spill.clear();assert(await spill.count()===0,'multirow cleanup failed');
    return {ok:true,mode:'multirow',nested,ctas,commit,rows:seq,changes:observedCounters.n,lastInsert:observedCounters.id,extraTotalChanges:(observedCounters.total-stageStart)-(baselineCounters.total-baselineStart),visibleStageTables:observedSchema-baselineSchema};
  }
  async run(mode) {
    const commit = mode==='commit', injectFailure = mode==='fail';
    const s = this.ctx.storage, q = s.sql;
    const names = Array.from({length:99}, (_, i) => `column_identifier_for_test_${i}${'_'.repeat(512)}`);
    q.exec(`CREATE TABLE IF NOT EXISTS fixture (value BLOB NOT NULL CHECK(typeof(value)='blob'),${names.join(',')})`);
    q.exec('CREATE TABLE IF NOT EXISTS audit (n INTEGER NOT NULL)');
    q.exec('DELETE FROM fixture'); q.exec('DELETE FROM audit'); q.exec('INSERT INTO audit VALUES(0)');
    q.exec('CREATE TRIGGER IF NOT EXISTS deleted AFTER DELETE ON fixture BEGIN UPDATE audit SET n=n+1; END');
    q.exec('CREATE TABLE IF NOT EXISTS type_probe(value)');
    try { s.transactionSync(()=>{
      q.exec('INSERT INTO type_probe VALUES(9007199254740992),(9007199254740993)');
      const raw=q.exec('DELETE FROM type_probe RETURNING value').raw().toArray();
      assert(raw.length===2 && typeof raw[0][0]==='number' && raw[0][0]===raw[1][0],'expected direct integer precision collision');
      q.exec("INSERT INTO type_probe VALUES(9007199254740993),('9007199254740993')");
      const encoded=q.exec("DELETE FROM type_probe RETURNING CASE WHEN typeof(value)='integer' THEN printf('%lld',value) ELSE value END").raw().toArray();
      assert(encoded.length===2 && typeof encoded[0][0]==='string' && encoded[0][0]===encoded[1][0],'expected integer/TEXT type collision');
      throw Error('type diagnostic rollback');
    }); } catch(error) { if(error.message!=='type diagnostic rollback') throw error; }
    assert(q.exec('SELECT COUNT(*) AS n FROM type_probe').one().n===0,'type diagnostic left rows');
    // SQLite embargoes RETURNING output until all changes have occurred.
    // This local check demonstrates ordering only; it cannot measure SQLite's
    // internal buffering or establish bounded memory for arbitrary results.
    q.exec('CREATE TABLE IF NOT EXISTS embargo_probe(value INTEGER)');
    q.exec('CREATE TABLE IF NOT EXISTS embargo_audit(n INTEGER NOT NULL)');
    q.exec('DELETE FROM embargo_audit'); q.exec('INSERT INTO embargo_audit VALUES(0)');
    q.exec('CREATE TRIGGER IF NOT EXISTS embargo_delete AFTER DELETE ON embargo_probe BEGIN UPDATE embargo_audit SET n=n+1; END');
    try { s.transactionSync(()=>{
      q.exec('INSERT INTO embargo_probe VALUES(1),(2),(3)');
      const rows=q.exec('DELETE FROM embargo_probe RETURNING value').raw()[Symbol.iterator]();
      const first=rows.next();assert(!first.done,'missing first RETURNING row');
      assert(q.exec('SELECT COUNT(*) AS n FROM embargo_probe').one().n===0 && q.exec('SELECT n FROM embargo_audit').one().n===3,'writes not completed before first RETURNING row');
      let count=1;while(!rows.next().done) count++;assert(count===3,'missing embargo result rows');
      throw Error('embargo diagnostic rollback');
    }); } catch(error) {if(error.message!=='embargo diagnostic rollback') throw error;}
    assert(q.exec('SELECT COUNT(*) AS n FROM embargo_probe').one().n===0 && q.exec('SELECT n FROM embargo_audit').one().n===0,'embargo diagnostic rollback failed');
    const size = 8388530, expected = new Uint8Array(size);
    expected.set([255,0,0,0,0,0,0,0,0]); expected.set(new TextEncoder().encode('@MaPiRun1'), 9);
    for (let i=0;i<65;i++) expected[18+Math.floor((size-18-64)*(i+1)/66)] = i+1;
    const handle = crypto.randomUUID();
    const context = {project:'synthetic-project',owner:'synthetic-owner',generation:1,handle};
    let spill = this.env.SPILL.getByName(handle);
    const key = await crypto.subtle.generateKey({name:'AES-GCM',length:256}, false, ['encrypt','decrypt']);
    const prefix = crypto.getRandomValues(new Uint8Array(4));
    const rollback = 'synthetic result rollback';
    const statement=`DELETE FROM fixture RETURNING value,${names.join(',')}`;
    // This isolated probe substitutes one NULL projection with typeof(value),
    // preserving 100 columns while testing whether metadata fits the row.
    let typeProbe;
    try {s.transactionSync(()=>{
      q.exec('INSERT INTO fixture(value) VALUES (?)',expected);
      const row=q.exec(`DELETE FROM fixture RETURNING value,typeof(value),${names.slice(0,98).join(',')}`).raw().toArray()[0];
      assert(row.length===100 && row[1]==='blob' && row.slice(2).every(v=>v===null) && equal(new Uint8Array(row[0]),expected),'typed direct row changed');
      throw Error('typed probe rollback');
    });} catch(error) {if(error.message==='typed probe rollback') typeProbe='fits';else if(String(error).includes('SQLITE_TOOBIG')) typeProbe='too-big';else throw error;}
    assert(q.exec('SELECT COUNT(*) AS n FROM fixture').one().n===0 && q.exec('SELECT n FROM audit').one().n===0,'typed probe changed data or audit');
    let bridgeError;
    try { s.transactionSync(()=>{q.exec('INSERT INTO fixture(value) VALUES (?)',expected);execute(s,{statement,args:[],query:true});throw Error('expected bridge failure');}); }
    catch(error) { bridgeError=String(error); }
    assert(bridgeError.includes('SQLITE_TOOBIG'),'current bridge did not reproduce exact-size failure');
    assert(q.exec('SELECT COUNT(*) AS n FROM fixture').one().n===0 && q.exec('SELECT n FROM audit').one().n===0,'failed bridge changed data or audit');
    let sent = 0, frameCount = 0, replayChecked = false, writtenChain=new Uint8Array(32);
    try {
      await s.transaction(async () => {
        q.exec('INSERT INTO fixture(value) VALUES (?)',expected);
        const cursor=q.exec(statement).raw()[Symbol.iterator]();
        const first=cursor.next();
        assert(!first.done && first.value.length===100 && first.value.slice(1).every(v=>v===null),'unexpected result shape');
        // The CHECK constraint is the test's type authority. A generic
        // RETURNING implementation still needs a real per-cell type channel.
        assert(first.value[0] instanceof ArrayBuffer,'unexpected SQLite result type');
        const value=new Uint8Array(first.value[0]);
        assert(value.byteLength===size,'unexpected returned BLOB length');
        try { for(let offset=0;offset<value.length;offset+=FRAME_BYTES) {
          if(injectFailure && frameCount===1) throw Error('injected spill failure');
          const part=value.subarray(offset,Math.min(offset+FRAME_BYTES,value.length));
          const ciphertext=await crypto.subtle.encrypt({name:'AES-GCM',iv:nonce(prefix,frameCount),additionalData:aad(context,frameCount,offset,size)},key,part);
          assert(await spill.put(frameCount,ciphertext)==='stored','spill did not store frame');
          writtenChain=await chain(writtenChain,ciphertext);
          if(frameCount===0) {
            assert(await spill.put(frameCount,ciphertext)==='replayed','identical replay failed');
            const bad=new Uint8Array(ciphertext.slice(0));bad[0]^=1;
            let rejected=false;try{await spill.put(frameCount,bad);}catch{rejected=true;}
            assert(rejected,'conflicting replay accepted');
            rejected=false;try{await spill.put(2,ciphertext);}catch{rejected=true;}
            assert(rejected,'out-of-order frame accepted');replayChecked=true;
          }
          sent+=part.length;frameCount++;
        } } catch(error) { while(!cursor.next().done) {} throw error; }
        assert(cursor.next().done,'unexpected extra row');
        const manifest=new TextEncoder().encode(JSON.stringify({version:1,frames:frameCount,total:size,chain:writtenChain.toBase64()}));
        const sealed=await crypto.subtle.encrypt({name:'AES-GCM',iv:nonce(prefix,frameCount),additionalData:aad(context,frameCount,size,size,'seal')},key,manifest);
        let rejected=false;try{await spill.seal(frameCount+1,sealed);}catch{rejected=true;}
        assert(rejected,'incomplete seal accepted');
        assert(await spill.seal(frameCount,sealed)==='sealed','seal failed');
        assert(await spill.seal(frameCount,sealed)==='replayed','identical seal replay failed');
        const conflict=new Uint8Array(sealed.slice(0));conflict[0]^=1;
        rejected=false;try{await spill.seal(frameCount,conflict);}catch{rejected=true;}
        assert(rejected,'conflicting seal accepted');
        rejected=false;try{await spill.put(frameCount,new Uint8Array([0]));}catch{rejected=true;}
        assert(rejected,'write after seal accepted');
        if(!commit) throw Error(rollback);
      });
      assert(commit, 'rollback was not triggered');
    } catch(error) { if(commit || error.message!==(injectFailure?'injected spill failure':rollback)) throw error; }
    if(injectFailure) {
      assert(q.exec('SELECT COUNT(*) AS n FROM fixture').one().n===0 && q.exec('SELECT n FROM audit').one().n===0,'failed spill changed data or audit');
      assert(frameCount===1 && await spill.count()===1,'failure checkpoint differs');
      let unsealed=false;try{await spill.readSeal();}catch{unsealed=true;}
      assert(unsealed,'partial spill appears sealed');
      await spill.clear();assert(await spill.count()===0,'failure cleanup failed');
      return {ok:true,mode,commit:false,size,frameCount,maxFrame:FRAME_BYTES,audit:0,typeProbe};
    }
    assert(sent===size && replayChecked,'incomplete export');
    assert(q.exec('SELECT COUNT(*) AS n FROM fixture').one().n===0,'fixture row survived');
    assert(q.exec('SELECT n FROM audit').one().n===(commit?1:0),'audit transaction changed');
    assert(await spill.count()===frameCount,'spill missing frames');
    let restarted=false;try{await spill.restart();}catch{restarted=true;}
    assert(restarted,'spill did not restart');spill=this.env.SPILL.getByName(handle);
    assert(await spill.count()===frameCount,'spill did not survive restart');
    const storedSeal=await spill.readSeal();
    const badSeal=new Uint8Array(storedSeal.slice(0));badSeal[0]^=1;
    let rejectedSeal=false;try{await crypto.subtle.decrypt({name:'AES-GCM',iv:nonce(prefix,frameCount),additionalData:aad(context,frameCount,size,size,'seal')},key,badSeal);}catch{rejectedSeal=true;}
    assert(rejectedSeal,'tampered seal authenticated');
    const sealBytes=await crypto.subtle.decrypt({name:'AES-GCM',iv:nonce(prefix,frameCount),additionalData:aad(context,frameCount,size,size,'seal')},key,storedSeal);
    const seal=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(sealBytes));
    assert(seal.version===1 && seal.frames===frameCount && seal.total===size && typeof seal.chain==='string','invalid sealed manifest');
    let read=0, maxFrame=0, readChain=new Uint8Array(32);
    for(let seq=0;seq<frameCount;seq++) {
      const offset=seq*FRAME_BYTES, ciphertext=await spill.get(seq);
      readChain=await chain(readChain,ciphertext);
      if(seq===1) {
        let rejected=false;try{await crypto.subtle.decrypt({name:'AES-GCM',iv:nonce(prefix,0),additionalData:aad(context,0,0,size)},key,ciphertext);}catch{rejected=true;}
        assert(rejected,'reordered frame authenticated');
      }
      if(seq===0) {
        let rejected=false;try{await crypto.subtle.decrypt({name:'AES-GCM',iv:nonce(prefix,seq),additionalData:aad({...context,generation:2},seq,offset,size)},key,ciphertext);}catch{rejected=true;}
        assert(rejected,'changed generation authenticated');
        const tampered=new Uint8Array(ciphertext.slice(0));tampered[0]^=1;
        rejected=false;try{await crypto.subtle.decrypt({name:'AES-GCM',iv:nonce(prefix,seq),additionalData:aad(context,seq,offset,size)},key,tampered);}catch{rejected=true;}
        assert(rejected,'tampered ciphertext authenticated');
      }
      const part=new Uint8Array(await crypto.subtle.decrypt({name:'AES-GCM',iv:nonce(prefix,seq),additionalData:aad(context,seq,offset,size)},key,ciphertext));
      assert(equal(part,expected.subarray(offset,offset+part.length)),`frame ${seq} changed`);
      maxFrame=Math.max(maxFrame,part.length);read+=part.length;
    }
    assert(read===size && readChain.toBase64()===seal.chain,'incomplete or corrupt readback');
    await spill.swapFirstFrames();
    const swapped=await spill.get(0);let rejectedSwap=false;
    try{await crypto.subtle.decrypt({name:'AES-GCM',iv:nonce(prefix,0),additionalData:aad(context,0,0,size)},key,swapped);}catch{rejectedSwap=true;}
    assert(rejectedSwap,'swapped stored frame authenticated');
    await spill.swapFirstFrames();
    await spill.deleteFrame(frameCount-1);
    let missing=false;try{await spill.get(frameCount-1);}catch{missing=true;}
    assert(missing,'missing sealed frame accepted');
    await spill.clear(); assert(await spill.count()===0,'spill cleanup failed');
    return {ok:true,mode,commit,size,frameCount,maxFrame,audit:commit?1:0,typeProbe};
  }
}
export default { async fetch(request, env) {
  try {
    const owner=env.OWNER.getByName(crypto.randomUUID());
    const params=new URL(request.url).searchParams;
    return Response.json(params.has('multirow')?await owner.multirow(params.has('nested'),params.has('ctas'),params.has('commit')):await owner.run(params.has('commit')?'commit':params.has('fail')?'fail':'rollback'));
  } catch(error) { return Response.json({ok:false,error:String(error),stack:error.stack},{status:500}); }
} };
