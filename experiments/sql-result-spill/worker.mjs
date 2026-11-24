import { DurableObject } from 'cloudflare:workers';
import { execute } from '../../worker/sql.js';

// Feasibility experiment only. This is not an authenticated production spill
// service, is not exported by the application, and uses a throwaway key.
const FRAME_BYTES = 32768;
const assert = (condition, message) => { if (!condition) throw Error(message); };
const aad = (context, seq, offset, total) => new TextEncoder().encode(JSON.stringify([
  'mapi-result-spill-test-v1', context.project, context.owner, context.generation,
  context.handle, seq, offset, total,
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
export class Spill extends DurableObject {
  async put(seq, encrypted) {
    const s = this.ctx.storage, bytes = new Uint8Array(encrypted);
    assert(Number.isSafeInteger(seq) && seq >= 0 && bytes.length <= FRAME_BYTES + 16, 'invalid frame');
    return s.transactionSync(() => {
      const q = s.sql;
      q.exec('CREATE TABLE IF NOT EXISTS frames(seq INTEGER PRIMARY KEY, value BLOB NOT NULL)');
      q.exec('CREATE TABLE IF NOT EXISTS progress(id INTEGER PRIMARY KEY CHECK(id=1), next INTEGER NOT NULL)');
      q.exec('INSERT OR IGNORE INTO progress VALUES(1,0)');
      const existing = q.exec('SELECT value FROM frames WHERE seq=?', seq).raw().toArray();
      if (existing.length) {
        assert(equal(new Uint8Array(existing[0][0]), bytes), 'conflicting replay');
        return 'replayed';
      }
      assert(q.exec('SELECT next FROM progress WHERE id=1').one().next === seq, 'out-of-order frame');
      q.exec('INSERT INTO frames VALUES (?,?)', seq, bytes);
      q.exec('UPDATE progress SET next=next+1 WHERE id=1');
      return 'stored';
    });
  }
  async get(seq) {
    const result = this.ctx.storage.sql.exec('SELECT value FROM frames WHERE seq=?', seq).raw().toArray();
    assert(result.length === 1, 'missing frame');
    return result[0][0];
  }
  async clear() { this.ctx.storage.transactionSync(()=>{this.ctx.storage.sql.exec('DELETE FROM frames');this.ctx.storage.sql.exec('UPDATE progress SET next=0 WHERE id=1');}); }
  async count() { return this.ctx.storage.sql.exec('SELECT COUNT(*) AS n FROM frames').one().n; }
  async restart() { this.ctx.abort('intentional synthetic spill restart'); }
}
export class Owner extends DurableObject {
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
    let bridgeError;
    try { s.transactionSync(()=>{q.exec('INSERT INTO fixture(value) VALUES (?)',expected);execute(s,{statement,args:[],query:true});throw Error('expected bridge failure');}); }
    catch(error) { bridgeError=String(error); }
    assert(bridgeError.includes('SQLITE_TOOBIG'),'current bridge did not reproduce exact-size failure');
    assert(q.exec('SELECT COUNT(*) AS n FROM fixture').one().n===0 && q.exec('SELECT n FROM audit').one().n===0,'failed bridge changed data or audit');
    let sent = 0, frameCount = 0, replayChecked = false;
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
        if(!commit) throw Error(rollback);
      });
      assert(commit, 'rollback was not triggered');
    } catch(error) { if(commit || error.message!==(injectFailure?'injected spill failure':rollback)) throw error; }
    if(injectFailure) {
      assert(q.exec('SELECT COUNT(*) AS n FROM fixture').one().n===0 && q.exec('SELECT n FROM audit').one().n===0,'failed spill changed data or audit');
      assert(frameCount===1 && await spill.count()===1,'failure checkpoint differs');
      await spill.clear();assert(await spill.count()===0,'failure cleanup failed');
      return {ok:true,mode,commit:false,size,frameCount,maxFrame:FRAME_BYTES,audit:0};
    }
    assert(sent===size && replayChecked,'incomplete export');
    assert(q.exec('SELECT COUNT(*) AS n FROM fixture').one().n===0,'fixture row survived');
    assert(q.exec('SELECT n FROM audit').one().n===(commit?1:0),'audit transaction changed');
    assert(await spill.count()===frameCount,'spill missing frames');
    let restarted=false;try{await spill.restart();}catch{restarted=true;}
    assert(restarted,'spill did not restart');spill=this.env.SPILL.getByName(handle);
    assert(await spill.count()===frameCount,'spill did not survive restart');
    let read=0, maxFrame=0;
    for(let seq=0;seq<frameCount;seq++) {
      const offset=seq*FRAME_BYTES, ciphertext=await spill.get(seq);
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
    assert(read===size,'incomplete readback');
    await spill.clear(); assert(await spill.count()===0,'spill cleanup failed');
    return {ok:true,mode,commit,size,frameCount,maxFrame,audit:commit?1:0};
  }
}
export default { async fetch(request, env) {
  try {
    const owner=env.OWNER.getByName(crypto.randomUUID());
    const params=new URL(request.url).searchParams;
    return Response.json(await owner.run(params.has('commit')?'commit':params.has('fail')?'fail':'rollback'));
  } catch(error) { return Response.json({ok:false,error:String(error),stack:error.stack},{status:500}); }
} };
