// Distinct local host-response test: no SQLite statements, cursors, limits,
// relocation fixtures, Woven deployment, or external service is involved.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

const root = await mkdtemp(join(tmpdir(), 'mapi-rows-host-'));
const source = resolve('upstream/overlay/apps/api/internal/cloudflarewasm');
const go = '/Users/asmith/go/pkg/mod/golang.org/toolchain@v0.0.1-go1.26.9.darwin-arm64/bin/go';
const sha = value => createHash('sha256').update(value).digest('hex');
const files = ['rows.go', 'driver_wasip1.go', 'bridge_wasip1.go'];
let mf;
try {
  await mkdir(join(root, 'internal/cloudflarewasm'), {recursive:true});
  await mkdir(join(root, 'cmd/smoke'), {recursive:true});
  const hashes = {};
  for (const file of files) {
    const contents = await readFile(join(source, file)); hashes[file] = sha(contents);
    await writeFile(join(root, 'internal/cloudflarewasm', file), contents);
  }
  const main = await readFile('scripts/rows-wasip1-smoke.go');
  hashes['rows-wasip1-smoke.go'] = sha(main);
  await writeFile(join(root, 'cmd/smoke/main.go'), main);
  await writeFile(join(root, 'go.mod'), 'module mapirowstest\n\ngo 1.26\n');
  execFileSync(go, ['build', '-buildmode=c-shared', '-o', 'smoke.wasm', './cmd/smoke'], {
    cwd:root, stdio:'inherit', env:{...process.env,GOOS:'wasip1',GOARCH:'wasm',GOWORK:'off',GOTOOLCHAIN:'local',GOPROXY:'off',GOCACHE:'/private/tmp/mapi-phase1-rows-go-cache'},
  });
  for (const file of files) assert.equal(sha(await readFile(join(root, 'internal/cloudflarewasm',file))),hashes[file]);
  assert.equal(sha(await readFile(join(root,'cmd/smoke/main.go'))),hashes['rows-wasip1-smoke.go']);
  const wasm = await readFile(join(root,'smoke.wasm'));
  hashes.wasm = sha(wasm);
  const wasi = await readFile('worker/wasi.js','utf8'); hashes['wasi.js'] = sha(wasi);
  const script = `import wasm from './smoke.wasm';
    import {instantiateReactor} from './wasi.js';
    const enc=new TextEncoder(), dec=new TextDecoder();
    export default { async fetch() {
      let out, memory;
      const reactor=instantiateReactor(wasm, getMemory=>{
        memory=getMemory;
        return {sql(ptr,n) {
          const q=JSON.parse(dec.decode(new Uint8Array(memory(),ptr,n)));
          const normal={columns:['n','s','i','b'],rows:[[null,'',{integer:'9007199254740993'},{blob:'YQ=='}]]};
          const responses={short:{columns:['a','b'],rows:[[1]]},long:{columns:['a'],rows:[[1,2]]},badblob:{columns:['a'],rows:[[{blob:'synthetic-secret'}]]},badinteger:{columns:['a'],rows:[[{integer:'synthetic-secret'}]]},ambiguous:{columns:['a'],rows:[[{integer:'1',blob:'YQ=='}]]},array:{columns:['a'],rows:[[[1]]]},normal};
          out=enc.encode(JSON.stringify(responses[q.statement])); return out.length;
        },result(ptr,n){new Uint8Array(memory(),ptr,n).set(out);},transaction(){return 1;}};
      });
      return new Response(String(reactor.mapi_rows_smoke()));
    }};`;
  hashes.worker = sha(script);
  mf = new Miniflare(convertV4MiniflareOptions({host:'127.0.0.1',port:0,telemetry:{enabled:false},workers:[{name:'rows-test',compatibilityDate:'2025-01-01',modules:[
    {type:'ESModule',path:'worker.mjs',contents:script},
    {type:'ESModule',path:'wasi.js',contents:wasi},
    {type:'CompiledWasm',path:'smoke.wasm',contents:wasm},
  ]}]}));
  const response = await mf.dispatchFetch('http://localhost/');
  assert.equal(response.status,200);
  assert.equal(await response.text(),'0');
  console.log('Fresh-overlay Workerd driver host-response check passed');
  console.log(JSON.stringify(hashes));
} finally {
  if (mf) await mf.dispose();
  await rm(root,{recursive:true,force:true});
}
