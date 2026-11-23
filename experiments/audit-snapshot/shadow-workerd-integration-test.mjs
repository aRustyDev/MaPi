// Distinct disposable integration check. It uses small synthetic event rows,
// fake authorization and no real application handler or hosted resource.
// It is not a bridge cursor, SQL-limit, exact-size, nonfinite, malformed-TEXT,
// real-owner, normalization, or previously interrupted test.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

const pin='b0b74cd4a198428ea9b82910c217259ffc62b65c';
const go='/Users/asmith/go/pkg/mod/golang.org/toolchain@v0.0.1-go1.26.9.darwin-arm64/bin/go';
const sourceRepo=resolve('.mapi/nextgen');
const root=await mkdtemp(join(tmpdir(),'mapi-shadow-integrated-'));
const hash=x=>createHash('sha256').update(x).digest('hex');
let mf;
try {
  assert.equal(execFileSync('git',['-C',sourceRepo,'rev-parse',`${pin}^{commit}`],{encoding:'utf8'}).trim(),pin);
  const archive=execFileSync('git',['-C',sourceRepo,'archive','--format=tar',pin],{maxBuffer:128*1024*1024});
  const source=join(root,'source'); await mkdir(source); await writeFile(join(root,'source.tar'),archive);
  execFileSync('tar',['xf',join(root,'source.tar'),'-C',source],{stdio:'inherit'});
  await cp('upstream/overlay',source,{recursive:true});
  const tracingPatch=await readFile('upstream/audit-tracing.patch');
  execFileSync('git',['apply','--unidiff-zero',resolve('upstream/audit-tracing.patch')],{cwd:source,stdio:'inherit'});
  const api=join(source,'apps/api'), pkg='internal/storage/dialect/sqlite';
  const experiment='experiments/audit-snapshot/nextgen-overlay/apps/api/internal/storage/dialect/sqlite';
  const diagnostic=['event_shadow_reader_diagnostic.go','event_shadow_workerd_diagnostic.go'];
  const hashes={pin,archive:hash(archive),tracingPatch:hash(tracingPatch)};
  // Match the existing wasip1 build path: upstream native SQLite files must
  // not pull the native-only modernc driver into the WASI reactor.
  for(const file of ['dialect','error','pool','with_transaction']) {
    const path=join(api,pkg,`${file}.go`);
    await writeFile(path,`//go:build !wasip1\n\n${await readFile(path,'utf8')}`);
    hashes[`excluded-${file}`]=hash(await readFile(path));
  }
  for(const file of diagnostic) {
    const data=await readFile(join(experiment,file)); hashes[file]=hash(data);
    await writeFile(join(api,pkg,file),data);
  }
  const command=join(api,'cmd/mapi-shadow-integration'); await mkdir(command,{recursive:true});
  const main=await readFile('experiments/audit-snapshot/shadow-workerd-diagnostic.go');
  hashes.main=hash(main); await writeFile(join(command,'main.go'),main);
  execFileSync(go,['build','-trimpath','-ldflags=-s -w','-tags','mapi_shadow_diagnostic','-buildmode=c-shared','-o',join(root,'reactor.wasm'),'./cmd/mapi-shadow-integration'],{
    cwd:api,stdio:'inherit',env:{...process.env,GOOS:'wasip1',GOARCH:'wasm',CGO_ENABLED:'0',GOWORK:'off',GOTOOLCHAIN:'local',GOPROXY:'off',GOMODCACHE:'/private/tmp/mapi-management-build-c4k7gq/gomod-verified',GOCACHE:'/private/tmp/mapi-phase1-shadow-integrated-go-cache'},
  });
  for(const file of diagnostic) assert.equal(hash(await readFile(join(api,pkg,file))),hashes[file]);
  assert.equal(hash(await readFile(join(command,'main.go'))),hashes.main);
  const wasm=await readFile(join(root,'reactor.wasm')); hashes.wasm=hash(wasm);
  const baseline=await readFile('worker/generated/baseline.json'); hashes.baseline=hash(baseline);
  const statements=JSON.parse(baseline).statements;
  const ddl=statements.find(s=>/^CREATE TABLE events\s*\(/.test(s));
  const indexes=statements.filter(s=>/^CREATE INDEX idx_events_[a-z0-9_]+\s+ON events\s*\(/.test(s));
  assert.ok(ddl); assert.equal(indexes.length,12);
  const paths=['worker/wasi.js','worker/sql.js','worker/owner-fence.js','worker/audit-source-capture.js',
    'experiments/audit-snapshot/shadow-sql.mjs','experiments/audit-snapshot/shadow-lifecycle.mjs'];
  const modules=[];
  for(const path of paths) {const data=await readFile(path); hashes[path]=hash(data); modules.push({type:'ESModule',path,contents:data.toString()});}
  const worker=`import { DurableObject } from 'cloudflare:workers';
    import wasm from './reactor.wasm';
    import { instantiateReactor } from './worker/wasi.js';
    import { execute, sqliteError } from './worker/sql.js';
    import { initializeOwnerFence, freezeOwnerFence } from './worker/owner-fence.js';
    import { beginShadow, acquireShadowReader, withShadowReader, releaseShadowReader, closeShadow } from './experiments/audit-snapshot/shadow-lifecycle.mjs';
    const ddl=${JSON.stringify(ddl)}, indexes=${JSON.stringify(indexes)};
    const enc=new TextEncoder(), dec=new TextDecoder();
    const route={projectId:'shadow-a',origin:'https://a.invalid',objectName:'owner-a',generation:1};
    const scope={id:'1'.repeat(32),epoch:'era-1',principal:'2'.repeat(64),request:'3'.repeat(64),route};
    const reader='4'.repeat(32),use='5'.repeat(32),allow=()=>true;
    export class ShadowIntegration extends DurableObject {
      run() {
        const storage=this.ctx.storage, sql=storage.sql;
        initializeOwnerFence(storage,route);
        sql.exec("CREATE TABLE mapi_recovery_epoch(epoch TEXT NOT NULL)");
        sql.exec("INSERT INTO mapi_recovery_epoch VALUES ('era-1')");
        sql.exec(ddl); for(const index of indexes) sql.exec(index);
        sql.exec("INSERT INTO events(project_id,id,event_type,category,occurred_at,created_at,payload,metadata) VALUES ('shadow-a','evt-a','user.created','identity',1,1,'{}','{}'),('shadow-a','evt-b','user.created','identity',2,2,'{}','{}'),('shadow-b','evt-a','user.created','foreign',1,1,'{}','{}')");
        beginShadow(storage,scope,ddl,indexes,allow);
        acquireShadowReader(storage,scope,reader,use,allow);
        sql.exec("UPDATE events SET category='changed' WHERE project_id='shadow-a' AND id='evt-a'");
        sql.exec("DELETE FROM events WHERE project_id='shadow-a' AND id='evt-b'");
        sql.exec("INSERT INTO events(project_id,id,event_type,category,occurred_at,created_at,payload,metadata) VALUES ('shadow-a','evt-new','user.created','new',3,3,'{}','{}')");
        let output,memory,frame;
        const reactor=instantiateReactor(wasm,getMemory=>{memory=getMemory;return {
          sql(pointer,size){const query=JSON.parse(dec.decode(new Uint8Array(memory(),pointer,size)));let result;
            try{result=execute(storage,query);}catch(error){result={error:sqliteError(error)};}
            output=enc.encode(JSON.stringify(result));return output.length;},
          result(pointer,size){new Uint8Array(memory(),pointer,size).set(output);output=undefined;},
          transaction(){return 2;},
          diagnostic_frame(pointer,size){if(size>131072)throw Error('Diagnostic frame exceeds limit');frame=new Uint8Array(new Uint8Array(memory(),pointer,size));},
        };});
        const bytes=withShadowReader(storage,scope,reader,use,allow,()=>{frame=undefined;if(reactor.mapi_shadow_diagnostic()!==0||!frame)throw Error('Diagnostic Go read failed');return frame;});
        const value=JSON.parse(dec.decode(bytes));
        if(JSON.stringify(value)!==JSON.stringify({items:[{id:'evt-a',category:'identity'},{id:'evt-b',category:'identity'}],foreign:0}))throw Error('Snapshot mismatch');
        let denied=false;try{withShadowReader(storage,{...scope,route:{...route,generation:2}},reader,use,allow,()=>bytes);}catch{denied=true;}if(!denied)throw Error('Stale route accepted');
        releaseShadowReader(storage,scope,reader,use,allow);
        denied=false;try{withShadowReader(storage,scope,reader,use,allow,()=>bytes);}catch{denied=true;}if(!denied)throw Error('Released reader accepted');
        closeShadow(storage,scope,allow);
        if(JSON.stringify(value)!==JSON.stringify(JSON.parse(dec.decode(bytes))))throw Error('Detached frame changed');
        return {ok:true,bytes:bytes.length};
      }
    }
    export default {async fetch(request,env){return Response.json(await env.SHADOW.getByName('diagnostic').run());}};`;
  hashes.worker=hash(worker);
  const options=convertV4MiniflareOptions({host:'127.0.0.1',port:0,telemetry:{enabled:false},workers:[{
    name:'shadow-integration',compatibilityDate:'2026-11-18',durableObjects:{SHADOW:{className:'ShadowIntegration',useSQLite:true}},modules:[
      {type:'ESModule',path:'worker.mjs',contents:worker},...modules,{type:'CompiledWasm',path:'reactor.wasm',contents:wasm},
    ],
  }]});
  mf=new Miniflare(options);
  const response=await mf.dispatchFetch('http://localhost/');
  assert.equal(response.status,200);
  const value=await response.json(); assert.equal(value.ok,true); assert.ok(value.bytes>0);
  for(const path of paths) assert.equal(hash(await readFile(path)),hashes[path]);
  console.log('Pinned Go event statements + shadow lease + local Workerd SQLite passed');
  console.log(JSON.stringify(hashes));
} finally { if(mf)await mf.dispose(); await rm(root,{recursive:true,force:true}); }
