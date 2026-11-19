import { execFileSync } from 'node:child_process';
import { cp, mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
const dir=await mkdtemp(resolve(tmpdir(),'mapi-upstream-split-build-'));
try {
 const checkout=resolve(dir,'nextgen');await mkdir(checkout);
 const archive=resolve(dir,'nextgen.tar');execFileSync('git',['-C',resolve('.mapi/nextgen'),'archive','--format=tar',`--output=${archive}`,'b0b74cd4a198428ea9b82910c217259ffc62b65c'],{stdio:'inherit'});
 execFileSync('tar',['-xf',archive,'-C',checkout],{stdio:'inherit'});await cp('upstream/overlay',checkout,{recursive:true});
 execFileSync('git',['apply','--unidiff-zero',resolve('upstream/audit-tracing.patch')],{cwd:checkout,stdio:'inherit'});
 for(const file of ['dialect','error','pool','with_transaction']){const path=resolve(checkout,`apps/api/internal/storage/dialect/sqlite/${file}.go`);await writeFile(path,`//go:build !wasip1\n\n${await readFile(path,'utf8')}`);}
 const wasm=resolve('worker/generated/upstream-split-test.wasm');
 const argon=resolve('worker/generated/argon-spike.wasm');
 const env={...process.env,GOWORK:'off',GOOS:'wasip1',GOARCH:'wasm',CGO_ENABLED:'0',GOTOOLCHAIN:'go1.26.9'};
 execFileSync('go',['build','-trimpath','-ldflags=-s -w','-buildmode=c-shared','-o',argon,'./cmd/mapi-argon-spike'],{cwd:resolve(checkout,'apps/api'),stdio:'inherit',env});
 execFileSync('go',['build','-tags=mapi_flow,mapi_generation_test,mapi_split_password_test','-trimpath','-ldflags=-s -w','-buildmode=c-shared','-o',wasm,'./cmd/mapi-wasm'],{cwd:resolve(checkout,'apps/api'),stdio:'inherit',env:{...process.env,GOWORK:'off',GOOS:'wasip1',GOARCH:'wasm',CGO_ENABLED:'0',GOTOOLCHAIN:'go1.26.9'}});
 console.log(`Built private upstream split probe: ${(await stat(wasm)).size} Wasm bytes.`);
} finally {await rm(dir,{recursive:true,force:true});}
