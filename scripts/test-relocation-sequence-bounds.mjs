// Disposable local workerd test for the goose-only relocation metadata query.
// It does not invoke fixture export, real-owner relocation, or registry history.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

const source = `import { DurableObject } from 'cloudflare:workers';
import { readRelocationSequences } from './relocation-sequences.js';
export class Probe extends DurableObject {
  fetch() {
    const storage=this.ctx.storage, sql=storage.sql;
    sql.exec('CREATE TABLE goose_db_version (id INTEGER PRIMARY KEY AUTOINCREMENT)');
    sql.exec('CREATE TABLE checkpoint (value INTEGER NOT NULL)');
    sql.exec('CREATE TABLE audit_history (id INTEGER PRIMARY KEY)');
    sql.exec('INSERT INTO checkpoint VALUES (0)');
    sql.exec('INSERT INTO audit_history VALUES (1)');
    let returnedRows=0, largestText=0;
    const measured={sql:{exec(statement,...args) {
      const cursor=sql.exec(statement,...args);
      return {columnNames:cursor.columnNames,raw() {
        const raw=cursor.raw();
        return { [Symbol.iterator]() { return raw[Symbol.iterator](); }, toArray() {
          const result=raw.toArray(); returnedRows=Math.max(returnedRows,result.length);
          for (const row of result) for (const cell of row) if (typeof cell==='string') largestText=Math.max(largestText,new TextEncoder().encode(cell).length);
          return result;
        }};
      }};
    }}};
    function state() { return {checkpoint:sql.exec('SELECT value FROM checkpoint').one().value,audits:sql.exec('SELECT COUNT(*) AS n FROM audit_history').one().n,exportTables:sql.exec("SELECT COUNT(*) AS n FROM sqlite_schema WHERE name='mapi_chunk_export'").one().n}; }
    function attempt() {
      returnedRows=0; largestText=0; let value, error='';
      try { storage.transactionSync(() => { value=readRelocationSequences(measured); sql.exec('UPDATE checkpoint SET value=value+1'); }); }
      catch (e) { error=e.message; }
      return {value,error,returnedRows,largestText,state:state()};
    }
    const results=[];
    results.push(['empty',attempt()]);
    sql.exec("INSERT INTO sqlite_sequence VALUES ('goose_db_version',17)");
    results.push(['valid',attempt()]);
    sql.exec("INSERT INTO sqlite_sequence VALUES ('goose_db_version',18)");
    results.push(['duplicate',attempt()]);
    sql.exec('DELETE FROM sqlite_sequence');
    sql.exec("INSERT INTO sqlite_sequence VALUES ('foreign',17)");
    results.push(['foreign',attempt()]);
    sql.exec('DELETE FROM sqlite_sequence');
    sql.exec('INSERT INTO sqlite_sequence VALUES (?,17)','x'.repeat(4096));
    results.push(['long-name',attempt()]);
    sql.exec('DELETE FROM sqlite_sequence');
    sql.exec("INSERT INTO sqlite_sequence VALUES ('goose_db_version',?)",new Uint8Array(4096));
    results.push(['blob-sequence',attempt()]);
    sql.exec('DELETE FROM sqlite_sequence');
    sql.exec("INSERT INTO sqlite_sequence VALUES ('goose_db_version',-1)");
    results.push(['negative',attempt()]);
    sql.exec('DELETE FROM sqlite_sequence');
    sql.exec("INSERT INTO sqlite_sequence VALUES ('goose_db_version',1.5)");
    results.push(['real',attempt()]);
    sql.exec('DELETE FROM sqlite_sequence');
    sql.exec("INSERT INTO sqlite_sequence VALUES ('goose_db_version','17')");
    results.push(['text',attempt()]);
    sql.exec('DELETE FROM sqlite_sequence');
    sql.exec("INSERT INTO sqlite_sequence VALUES ('goose_db_version',NULL)");
    results.push(['null',attempt()]);
    sql.exec('DELETE FROM sqlite_sequence');
    for(let i=0;i<1024;i++) sql.exec('INSERT INTO sqlite_sequence VALUES (?,?)','foreign-'+i,i);
    results.push(['many',attempt()]);
    return Response.json(results);
  }
}
export default { fetch(request,env) { return env.PROBE.get(env.PROBE.idFromName('synthetic')).fetch(request); } };`;

const mf = new Miniflare(convertV4MiniflareOptions({
  workers: [{ name:'local-relocation-sequence-bounds', compatibilityDate:'2026-11-19',
    modules: [
      { type:'ESModule', path:'worker.js', contents:source },
      { type:'ESModule', path:'relocation-sequences.js', contents:await readFile('worker/relocation-sequences.js','utf8') },
      { type:'ESModule', path:'sql.js', contents:await readFile('worker/sql.js','utf8') },
    ], durableObjects:{PROBE:{className:'Probe',useSQLite:true}} }],
  host:'127.0.0.1', port:0, telemetry:{enabled:false},
}));
try {
  const response=await mf.dispatchFetch('http://127.0.0.1/');
  assert.equal(response.status,200);
  const results=new Map(await response.json());
  assert.deepEqual(results.get('empty').value,[]);
  assert.deepEqual(results.get('valid').value,[['goose_db_version',{integer:'17'}]]);
  for (const name of ['duplicate','foreign','long-name','blob-sequence','negative','real','text','null','many']) {
    const result=results.get(name);
    assert.match(result.error,/Unreviewed SQLite sequence/);
    assert.deepEqual(result.state,{checkpoint:2,audits:1,exportTables:0});
    assert(result.returnedRows<=2, `${name}: too many rows crossed the SQL boundary`);
    assert(result.largestText<=32, `${name}: oversized text crossed the SQL boundary`);
  }
  console.log('Local workerd relocation sequence bounds and rejected-write checks passed');
} finally { await mf.dispose(); }
