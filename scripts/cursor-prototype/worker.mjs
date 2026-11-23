import { DurableObject } from 'cloudflare:workers';
import wasm from './prototype.wasm';
import { instantiateReactor } from './wasi.js';

// Isolated feasibility prototype: this is not the production SQL bridge ABI.
class TransactionCursors {
  constructor(sql, scope) { this.scope = scope; this.sql = sql; this.handles = new Map(); this.nextId = 1; this.active = true; }
  open(statement, ...args) {
    if (!this.active) throw Error('transaction expired');
    const iterator = this.sql.exec(statement, ...args).raw()[Symbol.iterator]();
    const id = this.scope + ':' + this.nextId++;
    this.handles.set(id, { iterator, pending: null, offset: 0 });
    return id;
  }
  next(id) {
    const h = this.active && this.handles.get(id);
    if (!h) throw Error('stale cursor');
    if (!h.pending) {
      const next = h.iterator.next();
      if (next.done) { this.handles.delete(id); return { done: true }; }
      h.pending = next.value; h.offset = 0;
    }
    const row = h.pending;
    if (row.length === 3) {
      const [slot, type, value] = row;
      if (type === 'text' || type === 'blob') {
        if (!h.bytes) h.bytes = type === 'text' ? new TextEncoder().encode(value) : new Uint8Array(value);
        const end = Math.min(h.bytes.length, h.offset + 32768);
        const frame = { slot, type, offset:h.offset, data:h.bytes.subarray(h.offset, end).toBase64(), end:end===h.bytes.length };
        h.offset=end; if(frame.end) {h.pending=null;h.bytes=null;} return frame;
      }
      h.pending=null; return {slot,type,value,end:true};
    }
    // Prototype output schema deliberately covers one BLOB or one integer per row.
    const v = row[0];
    if (v instanceof ArrayBuffer || ArrayBuffer.isView(v)) {
      const bytes = v instanceof ArrayBuffer ? new Uint8Array(v) : new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
      const end = Math.min(bytes.length, h.offset + 32768);
      const data = bytes.subarray(h.offset, end).toBase64();
      const frame = { kind: 'blob', offset: h.offset, data, end: end === bytes.length };
      h.offset = end;
      if (frame.end) h.pending = null;
      return frame;
    }
    h.pending = null;
    return { kind: 'scalar', value: v, end: true };
  }
  close(id) { const h = this.active && this.handles.get(id); if (!h) throw Error('stale cursor'); while (!h.iterator.next().done) {} this.handles.delete(id); }
  finish() { if (this.handles.size) throw Error('undrained cursor'); }
  invalidate() { this.active = false; for (const h of this.handles.values()) { while (!h.iterator.next().done) {} } this.handles.clear(); }
}
class StagedCursors {
  constructor(storage, scope) { this.storage=storage; this.sql=storage.sql; this.scope=String(scope); this.active=true; this.handle=null; this.seq=0; }
  open(statement) {
    if(!this.active || this.handle) throw Error('invalid open');
    const q=this.sql; let seq=0, expected=0, rowno=-1;
    for (const row of q.exec(statement).raw()) {
      const [slot, type, value]=row;
      if(slot!==expected) throw Error('misordered slots');
      if(slot===0) rowno++;
      expected=(expected+1)%100;
      const bytes=type==='text' || type==='integer' ? new TextEncoder().encode(value) : type==='blob' ? new Uint8Array(value) : new Uint8Array(0);
      for(let off=0;off<bytes.length || off===0;off+=32768) {
        const end=Math.min(bytes.length,off+32768);
        q.exec('INSERT INTO staged_frames2 VALUES (?,?,?,?,?,?,?,?,?)',this.scope,seq++,rowno,slot,type,off,end===bytes.length?1:0,bytes.slice(off,end),type==='real'?value:0);
        if(end===bytes.length) break;
      }
    }
    if(expected!==0) throw Error('truncated row');
    this.handle=this.scope+':1'; return this.handle;
  }
  next(id) {
    if(!this.active||id!==this.handle) throw Error('stale cursor');
    const rows=this.sql.exec('SELECT slot,typ,off,final,value,spare FROM staged_frames2 WHERE scope=? AND seq=?',this.scope,this.seq++).raw().toArray();
    if(!rows.length) { this.sql.exec('DELETE FROM staged_frames2 WHERE scope=?',this.scope); this.handle=null; return {done:true}; }
    const [slot,type,offset,final,value,number]=rows[0], bytes=new Uint8Array(value);
    if(type==='text'||type==='blob') return {slot,type,offset,data:bytes.toBase64(),end:!!final};
    if(type==='integer') return {slot,type,value:new TextDecoder().decode(bytes),end:true};
    if(type==='real') return {slot,type,value:number,end:true};
    return {slot,type,value:null,end:true};
  }
  close(id) {if(!this.active||id!==this.handle) throw Error('stale cursor'); this.sql.exec('DELETE FROM staged_frames2 WHERE scope=?',this.scope); this.handle=null;}
  finish() {if(this.handle) throw Error('undrained cursor');}
  invalidate() {this.active=false; this.sql.exec('DELETE FROM staged_frames2 WHERE scope=?',this.scope); this.handle=null;}
}
export class SQLSemanticsProbe extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    const q=ctx.storage.sql;
    q.exec('CREATE TABLE IF NOT EXISTS crash_frames(scope TEXT,part INTEGER,value BLOB)');
    this.cleaned=q.exec('SELECT count(*) AS n FROM crash_frames').one().n;
    q.exec('DELETE FROM crash_frames');
  }
  async kvRollback() {
    const s=this.ctx.storage; await s.delete('kv-rollback'); let pending, transactionError;
    try {s.transactionSync(()=>{pending=s.put('kv-rollback',new Uint8Array([1,2,3])); throw Error('rollback');});}
    catch(e) {transactionError=String(e);}
    let promiseError; try {await pending;} catch(e) {promiseError=String(e);}
    const value=await s.get('kv-rollback'); return {transactionError,promiseError:promiseError||null,value:value ? Array.from(value) : null};
  }
  run(mode) {
    if(mode==='jspifeature') return {suspending:typeof WebAssembly.Suspending,promising:typeof WebAssembly.promising};
    if(mode==='preparecrash') {
      const q=this.ctx.storage.sql;
      this.ctx.storage.transactionSync(()=>{for(let i=0;i<5;i++) q.exec("INSERT INTO crash_frames VALUES ('abandoned',?,zeroblob(32768))",i);});
      return {prepared:q.exec('SELECT count(*) AS n FROM crash_frames').one().n};
    }
    if(mode==='crashstage') this.ctx.abort('isolated staging reset');
    if(mode==='aftercrash') return {cleaned:this.cleaned, remaining:this.ctx.storage.sql.exec('SELECT count(*) AS n FROM crash_frames').one().n};
    if (mode === 'temp') { try { this.ctx.storage.sql.exec('CREATE TEMP TABLE IF NOT EXISTS spool(x BLOB)'); this.ctx.storage.sql.exec('INSERT INTO spool VALUES (zeroblob(10))'); return {temp: true, count: this.ctx.storage.sql.exec('SELECT count(*) AS n FROM spool').one().n}; } catch(e) { return {temp: false, error: String(e)}; } }
    if (mode === 'triggernestedupdate') {
      const q=this.ctx.storage.sql;
      q.exec('CREATE TABLE IF NOT EXISTS nested_update_source(a TEXT,b TEXT)'); q.exec('CREATE TABLE IF NOT EXISTS nested_update_meta(a TEXT,b TEXT)');
      q.exec('DELETE FROM nested_update_source'); q.exec('DELETE FROM nested_update_meta'); q.exec("INSERT INTO nested_update_source VALUES('original','old')");
      q.exec('CREATE TRIGGER IF NOT EXISTS meta_nested_update AFTER UPDATE ON nested_update_source BEGIN INSERT INTO nested_update_meta VALUES (NEW.a, typeof(NEW.b)); END');
      q.exec("CREATE TRIGGER IF NOT EXISTS other_nested_update AFTER UPDATE ON nested_update_source WHEN NEW.b IS NULL BEGIN UPDATE nested_update_source SET b='nested' WHERE a=NEW.a; END");
      const returned=q.exec("UPDATE nested_update_source SET b=NULL WHERE a='original' RETURNING a,b").toArray();
      return {returned, meta:q.exec('SELECT a,b FROM nested_update_meta ORDER BY rowid').toArray()};
    }
    if (mode === 'triggernested') {
      const q=this.ctx.storage.sql;
      q.exec('CREATE TABLE IF NOT EXISTS nested_source(a TEXT,b TEXT)'); q.exec('CREATE TABLE IF NOT EXISTS nested_meta(a TEXT,b TEXT)');
      q.exec('DELETE FROM nested_source'); q.exec('DELETE FROM nested_meta');
      q.exec('CREATE TRIGGER IF NOT EXISTS meta_nested AFTER INSERT ON nested_source BEGIN INSERT INTO nested_meta VALUES (NEW.a, typeof(NEW.b)); END');
      q.exec("CREATE TRIGGER IF NOT EXISTS other_nested AFTER INSERT ON nested_source WHEN NEW.b IS NULL BEGIN INSERT INTO nested_source VALUES ('nested','b'); END");
      const returned=q.exec("INSERT INTO nested_source(a) VALUES('original') RETURNING a").toArray();
      return {returned, meta:q.exec('SELECT a,b FROM nested_meta ORDER BY rowid').toArray()};
    }
    if (mode === 'triggermeta') {
      const st=this.ctx.storage, q=st.sql, cols=Array.from({length:100},(_,i)=>'c'+i), out={};
      try {
        q.exec('CREATE TABLE IF NOT EXISTS meta_source('+cols.map(x=>x+' TEXT').join(',')+')');
        q.exec('CREATE TABLE IF NOT EXISTS meta_types(seq INTEGER PRIMARY KEY, types TEXT)'); q.exec('DELETE FROM meta_source'); q.exec('DELETE FROM meta_types');
        q.exec(`CREATE TRIGGER IF NOT EXISTS meta_test_trigger AFTER INSERT ON meta_source BEGIN INSERT INTO meta_types(types) VALUES (${Array.from({length:4},(_,j)=>`printf('%s%s%s%s%s%s%s%s%s%s%s%s%s%s%s%s%s%s%s%s%s%s%s%s%s',${cols.slice(j*25,(j+1)*25).map(x=>`substr(typeof(NEW.${x}),1,1)`).join(',')})`).join(" || ")}); END`);
        st.transactionSync(()=>{
          const cursor=q.exec(`INSERT INTO meta_source(c0) VALUES(CAST(zeroblob(?) AS TEXT)) RETURNING ${cols.join(',')}`,8388400);
          let count=0; for(const row of cursor.raw()){out.textLength=row[0].length;out.columns=row.length;count++;} out.rows=count;
        });
        const meta=q.exec('SELECT types FROM meta_types').one().types; out.types=meta; out.metadataCount=q.exec('SELECT count(*) AS n FROM meta_types').one().n;
      } catch(e){out.error=String(e);} return out;
    }
    if (mode === 'narrowlimit') {
      const st=this.ctx.storage, q=st.sql; q.exec('CREATE TABLE IF NOT EXISTS pinned_json_shape(project_id TEXT NOT NULL, url TEXT NOT NULL, object_type TEXT, kind TEXT NOT NULL, created_at INTEGER NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(project_id,url))');
      const cols=['project_id','url','object_type','kind','created_at','payload'];
      function accepts(n,typed) {
        try { st.transactionSync(()=>{
          q.exec(`INSERT INTO pinned_json_shape VALUES ('p','u',NULL,'user-schema',1, '"'||substr(hex(zeroblob((?+1)/2)),1,?)||'"')`,n,n);
          const ret=typed ? cols.map(x=>`CASE WHEN typeof(${x})='integer' THEN printf('%lld',${x}) ELSE ${x} END, typeof(${x})`).join(',') : cols.join(',');
          for(const row of q.exec(`DELETE FROM pinned_json_shape WHERE project_id='p' AND url='u' RETURNING ${ret}`).raw()) {if(row.length!==(typed?12:6))throw Error('bad shape'); if(row[typed?10:5].length!==n+2)throw Error('bad payload length '+row[typed?10:5].length+' expected '+(n+2));}
          throw Error('rollback probe'); }); }
        catch(e) {if(String(e)==='Error: rollback probe')return true; if(String(e).includes('SQLITE_TOOBIG'))return false; throw e;}
      }
      function max(typed) {let lo=8388200,hi=9000000;while(hi-lo>1){let mid=Math.floor((lo+hi)/2);if(accepts(mid,typed))lo=mid;else hi=mid;}return lo;}
      const direct=max(false),typed=max(true);return {direct,typed,payloadBytes:8388602,directPass:accepts(8388600,false),typedAtDirect:accepts(8388600,true),rows:q.exec('SELECT count(*) AS n FROM pinned_json_shape').one().n};
    }
    if (mode === 'returnlimit') {
      const st=this.ctx.storage, q=st.sql; q.exec('CREATE TABLE IF NOT EXISTS returning_limit(value TEXT)');
      const tails=Array(99).fill('NULL').join(',');
      function accepts(n,prefix) {
        try { st.transactionSync(()=>{ const c=q.exec(`INSERT INTO returning_limit VALUES(CAST(zeroblob(?) AS TEXT)) RETURNING ${prefix ? "'t'||value" : 'value'}, ${tails}`,n); for(const row of c.raw()) {if(row[0].length!==n+(prefix?1:0)) throw Error('bad result');} throw Error('rollback probe'); }); }
        catch(e) { if(String(e)==='Error: rollback probe') return true; if(String(e).includes('SQLITE_TOOBIG')) return false; throw e; }
      }
      function max(prefix) {let lo=8388400,hi=8388609;while(hi-lo>1){let mid=Math.floor((lo+hi)/2);if(accepts(mid,prefix))lo=mid;else hi=mid;}return lo;}
      const direct=max(false), tagged=max(true);
      return {direct,tagged,directPass:accepts(direct,false),taggedAtDirect:accepts(direct,true),rows:q.exec('SELECT count(*) AS n FROM returning_limit').one().n};
    }
    if (mode === 'stagedsnapshot') {
      const s=this.ctx.storage, q=s.sql;
      q.exec('CREATE TABLE IF NOT EXISTS staged_frames2(scope TEXT,seq INTEGER,rowno INTEGER,slot INTEGER,typ TEXT,off INTEGER,final INTEGER,value BLOB,spare INTEGER,PRIMARY KEY(scope,seq))');
      q.exec('CREATE TABLE IF NOT EXISTS snapshot_probe(id INTEGER PRIMARY KEY)'); q.exec('DELETE FROM snapshot_probe'); q.exec('INSERT INTO snapshot_probe VALUES (1),(2),(3)');
      const c=Array.from({length:100},(_,i)=>'c'+i), expr=['id',...Array(99).fill('NULL')], cell=`CASE slot ${c.map((x,i)=>`WHEN ${i} THEN ${x}`).join(' ')} END`;
      const stmt=`WITH RECURSIVE src(${c.join(',')}) AS NOT MATERIALIZED (SELECT * FROM (SELECT ${expr.join(',')} FROM snapshot_probe ORDER BY id) LIMIT -1 OFFSET 0), slots(slot) AS (VALUES(0) UNION ALL SELECT slot+1 FROM slots WHERE slot<99) SELECT slot, typeof(${cell}), CASE WHEN typeof(${cell})='integer' THEN printf('%lld',${cell}) ELSE ${cell} END FROM src CROSS JOIN slots`;
      const manager=new StagedCursors(s,'snap'); let id; s.transactionSync(()=>{id=manager.open(stmt)}); s.transactionSync(()=>q.exec('INSERT INTO snapshot_probe VALUES (4)'));
      const ids=[]; for(let f=manager.next(id); !f.done; f=manager.next(id)) if(f.slot===0) ids.push(Number(f.value));
      manager.finish(); manager.invalidate(); const leftovers=q.exec("SELECT count(*) AS n FROM staged_frames2 WHERE scope='snap'").one().n;
      return {ids,leftovers,sourceCount:q.exec('SELECT count(*) AS n FROM snapshot_probe').one().n};
    }
    if (mode === 'snapshot') {
      const s=this.ctx.storage, q=s.sql;
      q.exec('CREATE TABLE IF NOT EXISTS snapshot_probe(id INTEGER PRIMARY KEY)'); q.exec('DELETE FROM snapshot_probe'); q.exec('INSERT INTO snapshot_probe VALUES (1),(2),(3)');
      let it; s.transactionSync(()=>{it=q.exec('SELECT id FROM snapshot_probe ORDER BY id').raw()[Symbol.iterator]()});
      const first=it.next().value[0]; s.transactionSync(()=>q.exec('INSERT INTO snapshot_probe VALUES (4)'));
      const rest=[]; for (let r=it.next();!r.done;r=it.next()) rest.push(r.value[0]);
      return {first,rest};
    }
    if (mode === 'vertical') {
      const sql=this.ctx.storage.sql;
      const c=Array.from({length:100},(_,i)=>'c'+i);
      const expr=["CAST(zeroblob(8388608) AS TEXT)", '9223372036854775807', "X'00FF'", "''", "X''", "CAST(X'6100F09F9880' AS TEXT)", '1.25', '-9223372036854775808', ...Array(92).fill('NULL')];
      const cell=`CASE slot ${c.map((x,i)=>`WHEN ${i} THEN ${x}`).join(' ')} END`;
      const source=`SELECT * FROM (SELECT ${expr.join(',')}) LIMIT -1 OFFSET 0`;
      const stmt=`WITH RECURSIVE src(${c.join(',')}) AS NOT MATERIALIZED (${source}), slots(slot) AS (VALUES(0) UNION ALL SELECT slot+1 FROM slots WHERE slot<99) SELECT slot, typeof(${cell}), CASE WHEN typeof(${cell})='integer' THEN printf('%lld',${cell}) ELSE ${cell} END FROM src CROSS JOIN slots`;
      const plan=sql.exec('EXPLAIN QUERY PLAN '+stmt).toArray().map(x=>x.detail);
      let count=0, textLength=0, int='', blob='', mismatch=0;
      for (const row of sql.exec(stmt).raw()) {if(row[0]!==count) mismatch++; if(count===0) textLength=row[2].length; if(count===1) int=row[2]; if(count===2) blob=new Uint8Array(row[2]).toHex(); count++;}
      return {count,textLength,int,blob,mismatch,plan};
    }
    if (mode === 'volatile') {
      const sql=this.ctx.storage.sql;
      const stmt=`WITH src(c0) AS NOT MATERIALIZED (SELECT * FROM (WITH RECURSIVE s(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM s WHERE n<10000) SELECT CASE WHEN random()%2=0 THEN 9223372036854775807 ELSE 'hello' END FROM s) LIMIT -1 OFFSET 0), tags(marker) AS (VALUES(0),(1)) SELECT CASE WHEN marker=0 THEN CASE WHEN typeof(c0)='integer' THEN printf('%lld',c0) ELSE c0 END ELSE typeof(c0) END FROM src CROSS JOIN tags`;
      const plan=sql.exec('EXPLAIN QUERY PLAN '+stmt).toArray().map(x=>x.detail);
      const iter=sql.exec(stmt).raw()[Symbol.iterator](); let count=0,bad=0;
      while(true) {const a=iter.next(); if(a.done) break; const b=iter.next(); if(b.done) {bad++;break;} if (!((a.value[0]==='9223372036854775807' && b.value[0]==='integer')||(a.value[0]==='hello' && b.value[0]==='text'))) bad++; count++; }
      return {count,bad,plan};
    }
    if (mode === 'exact') {
      const sql=this.ctx.storage.sql, out={};
      for (const n of [8000000, 8388607, 8388608]) {
        try { const r=sql.exec('SELECT CAST(zeroblob(?) AS TEXT)', n).raw()[Symbol.iterator]().next().value; out[n]={textLength:r[0].length}; }
        catch(e) {out[n]={error:String(e)};}
      }
      const c=Array.from({length:51}, (_,i)=>'c'+i);
      const expr=["CAST(zeroblob(8388608) AS TEXT)", '9223372036854775807', ...Array(49).fill('NULL')];
      const projection=c.map(x=>`CASE WHEN marker=0 THEN CASE WHEN typeof(${x})='integer' THEN printf('%lld',${x}) ELSE ${x} END ELSE typeof(${x}) END`).join(',');
      try {
        const stmt=`WITH src(${c.join(',')}) AS NOT MATERIALIZED (SELECT ${expr.join(',')} LIMIT -1 OFFSET 0), tags(marker) AS (VALUES(0),(1)) SELECT ${projection} FROM src CROSS JOIN tags`;
        const rows=sql.exec(stmt).raw().toArray(); out.paired={rows:rows.length, textLength:rows[0][0].length, int:rows[0][1], textType:rows[1][0], intType:rows[1][1]};
      } catch(e) {out.paired={error:String(e)};}
      return out;
    }
    if (mode === 'stage' || mode === 'stageRollback') {
      const s = this.ctx.storage, q = s.sql, out = {};
      q.exec('CREATE TABLE IF NOT EXISTS staged_source(id INTEGER PRIMARY KEY, value BLOB)');
      q.exec('CREATE TABLE IF NOT EXISTS staged_frames(scope TEXT, row_number INTEGER, part INTEGER, value BLOB, PRIMARY KEY(scope,row_number,part))');
      q.exec('DELETE FROM staged_source'); q.exec('DELETE FROM staged_frames');
      try { s.transactionSync(() => {
        const cursor = q.exec('INSERT INTO staged_source VALUES (1, zeroblob(8000000)) RETURNING id, value');
        let count=0;
        for (const row of cursor.raw()) { const bytes=new Uint8Array(row[1]); for(let off=0;off<bytes.length;off+=32768) { q.exec('INSERT INTO staged_frames VALUES (?, ?, ?, ?)', 'one', row[0], count++, bytes.slice(off, off+32768)); } }
        out.frames=count; if(mode === 'stageRollback') throw Error('injected rollback');
      }); } catch(e) { out.error=String(e); }
      out.source=q.exec('SELECT count(*) AS n FROM staged_source').one().n;
      out.parts=q.exec('SELECT count(*) AS n FROM staged_frames').one().n;
      out.bytes=q.exec('SELECT coalesce(sum(length(value)),0) AS n FROM staged_frames').one().n;
      q.exec('DELETE FROM staged_frames');
      return out;
    }
    const s = this.ctx.storage, q = s.sql, out = {};
    q.exec('CREATE TABLE IF NOT EXISTS staged_frames2(scope TEXT,seq INTEGER,rowno INTEGER,slot INTEGER,typ TEXT,off INTEGER,final INTEGER,value BLOB,spare INTEGER,PRIMARY KEY(scope,seq))');
    q.exec('CREATE TABLE IF NOT EXISTS frame_rows(id INTEGER PRIMARY KEY, data BLOB)');
    q.exec('DELETE FROM frame_rows');
    q.exec('INSERT INTO frame_rows VALUES (1, zeroblob(8000000))');
    let manager, memory, output, lastId, previousId, scope = 0;
    const encoder = new TextEncoder(), decoder = new TextDecoder();
    out.hostCalls = 0; out.maxFrameBytes = 0;
    const reactor = instantiateReactor(wasm, getMemory => {
      memory = getMemory;
      return { sql: (ptr, size) => {
        const request = JSON.parse(decoder.decode(new Uint8Array(memory(), ptr, size)));
        let result;
        if (request.op === 'open') {
          let sql = request.query === 'blob' ? 'SELECT data FROM frame_rows WHERE id=1' : 'WITH RECURSIVE x(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM x WHERE n<10000) INSERT INTO frame_rows(id) SELECT n+1 FROM x RETURNING id';
          if (request.query === 'vertical') {
            const c=Array.from({length:100},(_,i)=>'c'+i), expr=["CAST(zeroblob(8388608) AS TEXT)", '9223372036854775807', "X'00FF'", "''", "X''", "CAST(X'6100F09F9880' AS TEXT)", '1.25', '-9223372036854775808', ...Array(92).fill('NULL')];
            const cell=`CASE slot ${c.map((x,i)=>`WHEN ${i} THEN ${x}`).join(' ')} END`;
            sql=`WITH RECURSIVE src(${c.join(',')}) AS NOT MATERIALIZED (SELECT * FROM (SELECT ${expr.join(',')}) LIMIT -1 OFFSET 0), slots(slot) AS (VALUES(0) UNION ALL SELECT slot+1 FROM slots WHERE slot<99) SELECT slot, typeof(${cell}), CASE WHEN typeof(${cell})='integer' THEN printf('%lld',${cell}) ELSE ${cell} END FROM src CROSS JOIN slots`;
          }
          lastId = mode === 'verticaloutside' || mode === 'stagedb' ? s.transactionSync(() => manager.open(sql)) : manager.open(sql); if (previousId) { try { manager.next(previousId); throw Error('old scope accepted'); } catch(e) { if (String(e) !== 'Error: stale cursor') throw e; out.oldScopeRejected = true; } previousId = undefined; } result = { id: lastId };
        } else if (request.op === 'next') result = manager.next(request.id);
        else if (request.op === 'close') { manager.close(request.id); result = {closed:true}; }
        else throw Error('bad operation');
        output = encoder.encode(JSON.stringify(result)); out.maxFrameBytes = Math.max(out.maxFrameBytes, output.length); out.hostCalls++;
        return output.length;
      }, result: (ptr, size) => { new Uint8Array(memory(), ptr, size).set(output); output.fill(0); output = undefined; } };
    });
    const runGo = () => {
      manager = mode === 'stagedb' ? new StagedCursors(s, ++scope) : new TransactionCursors(q, ++scope);
      try { const status = reactor.mapi_stream_test(mode === 'verticaldb' || mode === 'verticaloutside' || mode === 'stagedb' ? 3 : mode === 'verticalgo' ? 2 : 0); if (status) throw Error('Go stream failed: '+status); manager.finish(); }
      finally { manager.invalidate(); }
    };
    if (mode === 'verticaloutside' || mode === 'stagedb') runGo(); else s.transactionSync(runGo);
    if (mode === 'verticalgo' || mode === 'verticaldb' || mode === 'verticaloutside' || mode === 'stagedb') { out.ok = true; return out; }
    try { manager.next(lastId); } catch (e) { out.stale = String(e); }
    out.committed = q.exec('SELECT count(*) AS n FROM frame_rows').one().n;
    previousId = lastId; q.exec('DELETE FROM frame_rows WHERE id > 1');
    try {
      s.transactionSync(() => {
        manager = new TransactionCursors(q, ++scope);
        try { if (reactor.mapi_stream_test(1)) throw Error('injected Go failure'); manager.finish(); }
        finally { manager.invalidate(); }
      });
    } catch(e) { out.rollbackError = String(e); }
    out.rolledBack = q.exec('SELECT count(*) AS n FROM frame_rows WHERE id > 1').one().n;
    try { manager.next(lastId); } catch (e) { out.rollbackStale = String(e); }
    return out;
  }
}
export default { async fetch(req, env) { const mode=new URL(req.url).searchParams.get('mode'), obj=env.PROBE.getByName('test'); return Response.json(mode==='kvrollback' ? await obj.kvRollback() : await obj.run(mode)); } };
