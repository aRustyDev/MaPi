// Disposable local helper test; no registry, actual application owner, cutover,
// history integration, hosted deployment, or external service.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

const source = await readFile('worker/owner-fence.js', 'utf8');
const hash = value => createHash('sha256').update(value).digest('hex');
const worker = `import { DurableObject } from 'cloudflare:workers';
import { createOwnerFenceTable, retireOwnerFence } from './owner-fence.js';
const route = { projectId:'p', origin:'https://p.example', objectName:'source', generation:1 };
export class Probe extends DurableObject {
  run(kind) {
    const s=this.ctx.storage, q=s.sql;
    createOwnerFenceTable(s);
    q.exec("INSERT INTO mapi_owner_fence VALUES (1, 'p', 'https://p.example', 'source', 1, 'frozen', 'move', 'digest')");
    q.exec('CREATE TABLE business (id INTEGER PRIMARY KEY)');
    if (kind==='trigger') q.exec("CREATE TRIGGER retirement_fault BEFORE UPDATE ON mapi_owner_fence BEGIN INSERT INTO business VALUES (1); SELECT RAISE(IGNORE); END");
    let error;
    try { retireOwnerFence(s,route,'move','digest',true); } catch(e) { error=String(e); }
    const state=q.exec('SELECT state FROM mapi_owner_fence').one().state;
    if(kind==='trigger') {
      if(!error || !error.includes('Owner retirement did not take effect') || state!=='frozen' || q.exec('SELECT COUNT(*) AS n FROM business').one().n!==0) throw Error('Trigger case failed');
    } else {
      if(error || state!=='retired') throw Error('Retirement failed '+error);
      retireOwnerFence(s,route,'move','digest',false);
      let mismatch=false; try { retireOwnerFence(s,route,'move','wrong',true); } catch { mismatch=true; }
      if(!mismatch) throw Error('Mismatched retry accepted');
    }
    return true;
  }
}
export default { async fetch(req,env) {
  for(const kind of ['normal','trigger']) if(!await env.PROBE.getByName(kind).run(kind)) throw Error(kind);
  return new Response('ok');
}};`;
let mf;
try {
  const options=convertV4MiniflareOptions({host:'127.0.0.1',port:0,telemetry:{enabled:false},workers:[{
    name:'owner-retirement-probe',compatibilityDate:'2026-11-18',durableObjects:{PROBE:{className:'Probe',useSQLite:true}},modules:[
      {type:'ESModule',path:'worker.mjs',contents:worker},
      {type:'ESModule',path:'owner-fence.js',contents:source},
    ],
  }]});
  mf=new Miniflare(options);
  const response=await mf.dispatchFetch('http://localhost/');
  assert.equal(response.status,200); assert.equal(await response.text(),'ok');
  assert.equal(hash(await readFile('worker/owner-fence.js','utf8')),hash(source));
  console.log('Owner retirement local Workerd helper checks passed');
  console.log(JSON.stringify({ownerFence:hash(source),worker:hash(worker)}));
} finally { if(mf) await mf.dispose(); }
