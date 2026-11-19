import { cp, mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
const source=resolve('.mapi/nextgen'), pin='b0b74cd4a198428ea9b82910c217259ffc62b65c';
if (execFileSync('git',['-C',source,'rev-parse','HEAD'],{encoding:'utf8'}).trim()!==pin) throw Error('Nextgen checkout is not pinned');
for (const name of ['internal/mapidpop','cmd/mapi-dpop-spike']) { await mkdir(resolve(source,'apps/api',name),{recursive:true}); await cp(resolve('upstream/overlay/apps/api',name),resolve(source,'apps/api',name),{recursive:true}); }
await mkdir('worker/generated',{recursive:true});
execFileSync('go',['build','-trimpath','-ldflags=-s -w','-buildmode=c-shared','-o',resolve('worker/generated/dpop-spike.wasm'),'./cmd/mapi-dpop-spike'],{cwd:resolve(source,'apps/api'),stdio:'inherit',env:{...process.env,GOWORK:'off',GOOS:'wasip1',GOARCH:'wasm',CGO_ENABLED:'0',GOTOOLCHAIN:'go1.26.9'}});
console.log('Built isolated DPoP test reactor.');
