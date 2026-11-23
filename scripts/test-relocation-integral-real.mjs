// Distinct local finite-REAL transport check. This does not exercise the
// interrupted non-finite, exact-size, cursor, SQL-limit, history or owner tests.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

const sql = await readFile('worker/sql.js', 'utf8');
const worker = `import { DurableObject } from 'cloudflare:workers';
  import { execute } from './sql.js';
  export class FiniteReal extends DurableObject {
    run() {
      const storage = this.ctx.storage, db = storage.sql;
      db.exec('CREATE TABLE source (id TEXT PRIMARY KEY, value BLOB)');
      db.exec('CREATE TABLE destination (id TEXT PRIMARY KEY, value BLOB)');
      db.exec("INSERT INTO source VALUES ('integer-valued', CAST('1.0' AS REAL)), ('fractional', CAST('1.5' AS REAL))");
      const result = [];
      for (const id of ['integer-valued','fractional']) {
        const from = db.exec('SELECT typeof(value) AS type, value FROM source WHERE id=?', id).one();
        const read = execute(storage,{statement:'SELECT value FROM source WHERE id=?',args:[{kind:'value',value:id}],query:true});
        const transported = JSON.parse(JSON.stringify(read.rows[0][0]));
        execute(storage,{statement:'INSERT INTO destination VALUES (?, ?)',args:[{kind:'value',value:id},{kind:'value',value:transported}],query:false});
        const to = db.exec('SELECT typeof(value) AS type, value FROM destination WHERE id=?', id).one();
        result.push({id,sourceType:from.type,destinationType:to.type,source:from.value,destination:to.value});
      }
      return result;
    }
  }
  export default { async fetch(_request,env) { return Response.json(await env.FINITE_REAL.getByName('one').run()); } };`;
const options = convertV4MiniflareOptions({host:'127.0.0.1',port:0,telemetry:{enabled:false},workers:[{
  name:'finite-real-transport',compatibilityDate:'2026-11-18',durableObjects:{FINITE_REAL:{className:'FiniteReal',useSQLite:true}},modules:[
    {type:'ESModule',path:'worker.mjs',contents:worker},
    {type:'ESModule',path:'sql.js',contents:sql},
  ],
}]});
let runtime;
try {
  runtime = new Miniflare(options);
  const response = await runtime.dispatchFetch('http://localhost/');
  assert.equal(response.status, 200);
  const rows = await response.json();
  assert.deepEqual(rows, [
    {id:'integer-valued',sourceType:'real',destinationType:'real',source:1,destination:1},
    {id:'fractional',sourceType:'real',destinationType:'real',source:1.5,destination:1.5},
  ]);
  console.log('Finite REAL transport preserves SQLite storage class and value');
} finally { if (runtime) await runtime.dispose(); }
