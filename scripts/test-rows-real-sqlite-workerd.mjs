// Focused integration check: current Go driver -> actual SQL host -> disposable
// Workerd SQLite DO. No upstream suite, migrations, platform limit probes,
// cursor/concurrency stress, external service, or hosted deployment.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

const pin = 'b0b74cd4a198428ea9b82910c217259ffc62b65c';
const upstream = resolve('.mapi/nextgen');
const go = '/Users/asmith/go/pkg/mod/golang.org/toolchain@v0.0.1-go1.26.9.darwin-arm64/bin/go';
const sha = data => createHash('sha256').update(data).digest('hex');
const root = await mkdtemp(join(tmpdir(), 'mapi-real-row-sqlite-'));
let mf;
try {
  assert.equal(execFileSync('git', ['-C',upstream,'rev-parse',`${pin}^{commit}`], {encoding:'utf8'}).trim(), pin);
  const archive = execFileSync('git', ['-C',upstream,'archive','--format=tar',pin], {maxBuffer:128*1024*1024});
  const archivePath = join(root,'nextgen.tar');
  await writeFile(archivePath,archive);
  const source = join(root,'source');
  await mkdir(source);
  execFileSync('tar',['xf',archivePath,'-C',source],{stdio:'inherit'});
  await cp('upstream/overlay',source,{recursive:true});
  const api = join(source,'apps/api'), command = join(api,'cmd/rows-real-sqlite');
  await mkdir(command,{recursive:true});
  const main = await readFile('scripts/rows-real-sqlite-wasip1.go');
  await writeFile(join(command,'main.go'),main);
  const overlay = resolve('upstream/overlay/apps/api/internal/cloudflarewasm');
  const files = ['rows.go','driver_wasip1.go','bridge_wasip1.go'];
  const hashes = {pin,archive:sha(archive),main:sha(main)};
  for (const file of files) {
    const original=await readFile(join(overlay,file));
    hashes[file]=sha(original);
    assert.equal(sha(await readFile(join(api,'internal/cloudflarewasm',file))),hashes[file]);
  }
  execFileSync(go,['build','-trimpath','-ldflags=-s -w','-buildmode=c-shared','-o',join(root,'smoke.wasm'),'./cmd/rows-real-sqlite'],{
    cwd:api,stdio:'inherit',env:{...process.env,GOOS:'wasip1',GOARCH:'wasm',CGO_ENABLED:'0',GOWORK:'off',GOTOOLCHAIN:'local',GOPROXY:'off',GOCACHE:'/private/tmp/mapi-phase1-real-rows-go-cache'},
  });
  for (const file of files) {
    assert.equal(sha(await readFile(join(api,'internal/cloudflarewasm',file))),hashes[file]);
    assert.equal(sha(await readFile(join(overlay,file))),hashes[file]);
  }
  assert.equal(sha(await readFile(join(command,'main.go'))),hashes.main);
  const wasm=await readFile(join(root,'smoke.wasm'));
  const wasi=await readFile('worker/wasi.js','utf8');
  const sql=await readFile('worker/sql.js','utf8');
  hashes.wasm=sha(wasm); hashes.wasi=sha(wasi); hashes.sql=sha(sql);
  const worker=`import { DurableObject } from 'cloudflare:workers';
    import wasm from './smoke.wasm';
    import { instantiateReactor } from './wasi.js';
    import { execute, sqliteError } from './sql.js';
    const enc=new TextEncoder(), dec=new TextDecoder();
    export class RealRows extends DurableObject {
      run() {
        let output, memory;
        const reactor=instantiateReactor(wasm,getMemory=>{
          memory=getMemory;
          return {
            sql:(pointer,size)=>{
              const query=JSON.parse(dec.decode(new Uint8Array(memory(),pointer,size)));
              let result;
              try { result=execute(this.ctx.storage,query); }
              catch(error) { result={error:sqliteError(error)}; }
              output=enc.encode(JSON.stringify(result)); return output.length;
            },
            result:(pointer,size)=>{new Uint8Array(memory(),pointer,size).set(output);output=undefined;},
            transaction:()=>2,
          };
        });
        return reactor.mapi_rows_real_sqlite();
      }
    }
    export default { async fetch(request,env) {
      const result=await env.REAL_ROWS.getByName('disposable-real-rows').run();
      return new Response(String(result));
    }};`;
  hashes.worker=sha(worker);
  const options=convertV4MiniflareOptions({host:'127.0.0.1',port:0,telemetry:{enabled:false},workers:[{
    name:'rows-real-sqlite',compatibilityDate:'2026-11-18',durableObjects:{REAL_ROWS:{className:'RealRows',useSQLite:true}},modules:[
      {type:'ESModule',path:'worker.mjs',contents:worker},
      {type:'ESModule',path:'wasi.js',contents:wasi},
      {type:'ESModule',path:'sql.js',contents:sql},
      {type:'CompiledWasm',path:'smoke.wasm',contents:wasm},
    ],
  }]});
  mf=new Miniflare(options);
  const response=await mf.dispatchFetch('http://localhost/');
  assert.equal(response.status,200);
  const result=await response.text();
  assert.equal(result,'0',`Go/SQLite assertion failed with step ${result}`);
  assert.equal(sha(await readFile('worker/sql.js','utf8')),hashes.sql);
  assert.equal(sha(await readFile('worker/wasi.js','utf8')),hashes.wasi);
  console.log('Fresh pinned overlay Go driver + Workerd SQLite round trip passed');
  console.log(JSON.stringify(hashes));
} finally {
  if (mf) await mf.dispose();
  await rm(root,{recursive:true,force:true});
}
