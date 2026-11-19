import { cp, mkdir, mkdtemp, readFile, rm, writeFile, stat } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
const root=await mkdtemp(resolve(tmpdir(),'mapi-invitations-build-'));
try {
 const source=resolve(root,'nextgen');await mkdir(source);
 const tar=resolve(root,'source.tar');execFileSync('git',['-C',resolve('.mapi/nextgen'),'archive','--format=tar',`--output=${tar}`,'b0b74cd4a198428ea9b82910c217259ffc62b65c'],{stdio:'inherit'});
 execFileSync('tar',['-xf',tar,'-C',source],{stdio:'inherit'});await cp('upstream/overlay',source,{recursive:true});
 execFileSync('git',['apply','--unidiff-zero',resolve('upstream/audit-tracing.patch')],{cwd:source,stdio:'inherit'});
 for(const file of ['dialect','error','pool','with_transaction']){const path=resolve(source,`apps/api/internal/storage/dialect/sqlite/${file}.go`);await writeFile(path,`//go:build !wasip1\n\n${await readFile(path,'utf8')}`);}
 const adapter=resolve(source,'apps/api/internal/api/cloudflare_wasip1.go');let code=await readFile(adapter,'utf8');
 const anchor='\tmux := http.NewServeMux()';if(!code.includes(anchor))throw Error('handler mount changed');code=code.replace(anchor,anchor+'\n configureMaPiInvitations(h, server, mux)');await writeFile(adapter,code);
 const wasm=resolve('worker/generated/invitations-test.wasm');execFileSync('go',['build','-tags=mapi_invitations','-trimpath','-ldflags=-s -w','-buildmode=c-shared','-o',wasm,'./cmd/mapi-wasm'],{cwd:resolve(source,'apps/api'),stdio:'inherit',env:{...process.env,GOWORK:'off',GOOS:'wasip1',GOARCH:'wasm',CGO_ENABLED:'0',GOTOOLCHAIN:'go1.26.9'}});
 let object=await readFile('worker/index.js','utf8');object=object.replace('"./generated/nextgen.wasm"','"./invitations-test.wasm"').replace('"./generated/fixture.json"','"./fixture.json"').replace('"./wasi.js"','"../wasi.js"').replace('"./sql.js"','"../sql.js"');
 const anchor2='  handleRequest(request) {';if(!object.includes(anchor2))throw Error('missing fixture hook');
 object=object.replace(anchor2,`  invitationClaim() { if(this.env.MAPI_LOCAL_TEST !== '1')throw new Error('local only');this.#initialize();this.ctx.storage.sql.exec("INSERT INTO authz_assignments(id,project_id,catalog_id,principal_type,principal_id,object_type,relation,scope_kind,created_at,updated_at) VALUES('test_claim',?,'cat_sys_1','team','test_owner','project','team','project',1800000000000000000,1800000000000000000)",fixture.projectId); }

${anchor2}`);await writeFile('worker/generated/invitations-test-object.js',object);
 console.log(`Built test-only invitation adapter: ${(await stat(wasm)).size} Wasm bytes.`);
}finally{await rm(root,{recursive:true,force:true});}
