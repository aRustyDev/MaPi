// Unmounted local Go/Workerd transaction integration. The permission row is
// synthetic; this does not exercise a real API handler, owner, or caller.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

const root=await mkdtemp(join(tmpdir(),'mapi-shadow-go-transaction-'));
const digest=value=>createHash('sha256').update(value).digest('hex');
let mf;
try {
  const go='/Users/asmith/go/pkg/mod/golang.org/toolchain@v0.0.1-go1.26.9.darwin-arm64/bin/go';
  const pkg=join(root,'internal/cloudflarewasm'), command=join(root,'cmd/probe');
  await mkdir(pkg,{recursive:true}); await mkdir(command,{recursive:true});
  await writeFile(join(root,'go.mod'),'module github.com/zitadel/nextgen\n\ngo 1.26\n');
  const hashes={};
  for(const name of ['bridge_wasip1.go','driver_wasip1.go','rows.go']) {
    const bytes=await readFile(`upstream/overlay/apps/api/internal/cloudflarewasm/${name}`); hashes[name]=digest(bytes);
    await writeFile(join(pkg,name),bytes);
  }
  const main=await readFile('experiments/audit-snapshot/shadow-go-transaction-diagnostic.go');
  hashes.main=digest(main); await writeFile(join(command,'main.go'),main);
  execFileSync(go,['build','-trimpath','-ldflags=-s -w','-buildmode=c-shared','-o',join(root,'probe.wasm'),'./cmd/probe'],{
    cwd:root,stdio:'inherit',env:{...process.env,GOOS:'wasip1',GOARCH:'wasm',CGO_ENABLED:'0',GOWORK:'off',GOTOOLCHAIN:'local',GOPROXY:'off',GOCACHE:'/private/tmp/mapi-shadow-go-transaction-cache'},
  });
  const wasm=await readFile(join(root,'probe.wasm')); hashes.wasm=digest(wasm);
  const baseline=await readFile('worker/generated/baseline.json'); hashes.baseline=digest(baseline);
  const statements=JSON.parse(baseline).statements;
  const ddl=statements.find(sql=>/^CREATE TABLE events\s*\(/.test(sql));
  const indexes=statements.filter(sql=>/^CREATE INDEX idx_events_[a-z0-9_]+\s+ON events\s*\(/.test(sql));
  assert.ok(ddl); assert.equal(indexes.length,12);
  const paths=['worker/wasi.js','worker/sql.js','worker/owner-fence.js','worker/audit-source-capture.js','experiments/audit-snapshot/shadow-sql.mjs','experiments/audit-snapshot/shadow-lifecycle.mjs'];
  const modules=[];
  for(const path of paths) {const bytes=await readFile(path); hashes[path]=digest(bytes); modules.push({type:'ESModule',path,contents:bytes.toString()});}
  const worker=`import {DurableObject} from 'cloudflare:workers';
    import wasm from './probe.wasm';
    import {instantiateReactor} from './worker/wasi.js';
    import {execute,sqliteError} from './worker/sql.js';
    import {initializeOwnerFence} from './worker/owner-fence.js';
    import {beginShadowInTransaction,shadowStatus} from './experiments/audit-snapshot/shadow-lifecycle.mjs';
    const ddl=${JSON.stringify(ddl)},indexes=${JSON.stringify(indexes)};
    const route={projectId:'p',origin:'https://p.invalid',objectName:'owner-p',generation:1};
    const scope={id:'1'.repeat(32),epoch:'era-1',principal:'2'.repeat(64),request:'3'.repeat(64),route};
    const enc=new TextEncoder(),dec=new TextDecoder();
    export class Probe extends DurableObject {
      run() {
        const storage=this.ctx.storage,sql=storage.sql;
        initializeOwnerFence(storage,route);
        sql.exec('CREATE TABLE mapi_recovery_epoch(epoch TEXT NOT NULL)'); sql.exec("INSERT INTO mapi_recovery_epoch VALUES ('era-1')");
        sql.exec(ddl); for(const index of indexes) sql.exec(index);
        sql.exec('CREATE TABLE synthetic_permission(id INTEGER PRIMARY KEY, allowed INTEGER NOT NULL)');
        sql.exec('INSERT INTO synthetic_permission VALUES (1,0)');
        sql.exec('CREATE TABLE transaction_marker(value INTEGER NOT NULL)');
        let memory,output,reactor,inTransaction=false,begins=0;
        const sentinel=Symbol('rollback');
        const hostBegin=()=>{
          if(!inTransaction) return 1;
          try {beginShadowInTransaction(storage,scope,ddl,indexes,()=>true); begins++; return 0;} catch {return 1;}
        };
        reactor=instantiateReactor(wasm,getMemory=>{memory=getMemory;return {
          sql(pointer,size){const query=JSON.parse(dec.decode(new Uint8Array(memory(),pointer,size)));let result;
            try{result=execute(storage,query);}catch(error){result={error:sqliteError(error)};}
            output=enc.encode(JSON.stringify(result));return output.length;},
          result(pointer,size){new Uint8Array(memory(),pointer,size).set(output);output=undefined;},
          transaction(){try{storage.transactionSync(()=>{inTransaction=true;try{if(reactor.mapi_transaction_body()!==0)throw sentinel;}finally{inTransaction=false;}});return 0;}catch(error){return error===sentinel?1:2;}},
          begin_shadow:hostBegin,
        };});
        const count=()=>sql.exec('SELECT COUNT(*) AS n FROM transaction_marker').one().n;
        const shadowCount=()=>sql.exec("SELECT COUNT(*) AS n FROM sqlite_schema WHERE lower(name) GLOB 'mapi_shadow_*' OR lower(name) GLOB 'mapi_audit_shadow_*'").one().n;
        if(hostBegin()!==1)throw Error('Host accepted an absent transaction');
        if(reactor.mapi_shadow_transaction_diagnostic(1)!==1||begins!==0||count()!==0||shadowCount()!==0)throw Error('Synthetic authorization denial failed');
        sql.exec('UPDATE synthetic_permission SET allowed=1 WHERE id=1');
        if(reactor.mapi_shadow_transaction_diagnostic(0)!==1||begins!==1||count()!==0||shadowCount()!==0)throw Error('Go callback rollback failed');
        if(reactor.mapi_shadow_transaction_diagnostic(1)!==0||begins!==2||count()!==2||shadowStatus(storage,scope,()=>true).state!=='active')throw Error('Go callback commit failed');
        return true;
      }
    }
    export default {async fetch(req,env){return new Response(await env.PROBE.getByName('transaction').run()?'ok':'failed')}};`;
  hashes.worker=digest(worker);
  mf=new Miniflare(convertV4MiniflareOptions({host:'127.0.0.1',port:0,telemetry:{enabled:false},workers:[{
    name:'shadow-go-transaction',compatibilityDate:'2026-11-18',durableObjects:{PROBE:{className:'Probe',useSQLite:true}},
    modules:[{type:'ESModule',path:'worker.mjs',contents:worker},{type:'CompiledWasm',path:'probe.wasm',contents:wasm},...modules],
  }]}));
  const response=await mf.dispatchFetch('http://localhost/');const body=await response.text();
  assert.equal(response.status,200,body); assert.equal(body,'ok');
  for(const path of paths)assert.equal(digest(await readFile(path)),hashes[path]);
  for(const name of ['bridge_wasip1.go','driver_wasip1.go','rows.go'])assert.equal(digest(await readFile(`upstream/overlay/apps/api/internal/cloudflarewasm/${name}`)),hashes[name]);
  assert.equal(digest(await readFile('experiments/audit-snapshot/shadow-go-transaction-diagnostic.go')),hashes.main);
  console.log('Local Workerd real Go transaction, synthetic authorization, shadow rollback and commit passed');
  console.log(JSON.stringify(hashes));
} finally {if(mf)await mf.dispose();await rm(root,{recursive:true,force:true});}
