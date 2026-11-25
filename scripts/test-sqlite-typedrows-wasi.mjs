// Local Go/WASI consumer test using Node's WASI host. This is not workerd
// or a production SQLite bridge test.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { WASI } from 'node:wasi';

const directory=await mkdtemp(resolve(tmpdir(),'mapi-typedrows-wasi-'));
try {
  const executable=resolve(directory,'typedrows.test.wasm');
  execFileSync('go',['test','-c','-o',executable,'./experiments/sql-result-spill/typedrows'],{
    stdio:'inherit',env:{...process.env,GOWORK:'off',GO111MODULE:'off',GOTOOLCHAIN:'go1.26.9',GOOS:'wasip1',GOARCH:'wasm',CGO_ENABLED:'0'},
  });
  const wasi=new WASI({version:'preview1',args:['typedrows.test','-test.v'],env:{},preopens:{},returnOnExit:true});
  const module=await WebAssembly.compile(await readFile(executable));
  const instance=await WebAssembly.instantiate(module,{wasi_snapshot_preview1:wasi.wasiImport});
  assert.equal(wasi.start(instance),0,'synthetic typed-row Go/WASI tests failed');
} finally {await rm(directory,{recursive:true,force:true});}
