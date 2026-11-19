import {cp,mkdtemp,mkdir,rm} from 'node:fs/promises';
import {execFileSync,spawn} from 'node:child_process';
import {once} from 'node:events';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
const pin='b0b74cd4a198428ea9b82910c217259ffc62b65c';
if(execFileSync('git',['-C',resolve('.mapi/nextgen'),'rev-parse','HEAD'],{encoding:'utf8'}).trim()!==pin)throw Error('Nextgen checkout is not at the pinned commit');
const dir=await mkdtemp(resolve(tmpdir(),'mapi-idp-bridge-'));
try{const checkout=resolve(dir,'nextgen');await mkdir(checkout);execFileSync('rsync',['-a','--exclude=.git','--exclude=node_modules',`${resolve('.mapi/nextgen')}/`,`${checkout}/`],{stdio:'inherit'});await cp(resolve('upstream/overlay/apps/api/internal/mapiidpbridge'),resolve(checkout,'apps/api/internal/mapiidpbridge'),{recursive:true});await cp(resolve('upstream/overlay/apps/api/internal/storage/dialect/sqlite/mapi_native_e2e.go'),resolve(checkout,'apps/api/internal/storage/dialect/sqlite/mapi_native_e2e.go'));const child=spawn('go',['test','-race','-tags','mapi_native_e2e','-count=1','./internal/mapiidpbridge'],{cwd:resolve(checkout,'apps/api'),stdio:'inherit',env:{...process.env,GOWORK:'off'}});const [code]=await once(child,'exit');if(code!==0)throw Error(`IDP bridge test failed (${code})`);}finally{await rm(dir,{recursive:true,force:true});}
