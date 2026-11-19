import { cp, mkdir, mkdtemp, readFile, rm, writeFile, stat } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
const root=await mkdtemp(resolve(tmpdir(),'mapi-usercreate-build-'));
try {
 const source=resolve(root,'nextgen');await mkdir(source);
 const tar=resolve(root,'source.tar');execFileSync('git',['-C',resolve('.mapi/nextgen'),'archive','--format=tar',`--output=${tar}`,'b0b74cd4a198428ea9b82910c217259ffc62b65c'],{stdio:'inherit'});
 execFileSync('tar',['-xf',tar,'-C',source],{stdio:'inherit'});await cp('upstream/overlay',source,{recursive:true});
 execFileSync('git',['apply','--unidiff-zero',resolve('upstream/audit-tracing.patch')],{cwd:source,stdio:'inherit'});
 for(const file of ['dialect','error','pool','with_transaction']){const path=resolve(source,`apps/api/internal/storage/dialect/sqlite/${file}.go`);await writeFile(path,`//go:build !wasip1\n\n${await readFile(path,'utf8')}`);}
 const adapter=resolve(source,'apps/api/internal/api/cloudflare_wasip1.go');let code=await readFile(adapter,'utf8');
 const sig='flows service.FlowService, projects service.ProjectService) (http.Handler, error) {';
 if(!code.includes(sig))throw Error('handler signature changed');code=code.replace(sig,'flows service.FlowService, projects service.ProjectService, accountHashers *crypto.HasherFactory) (http.Handler, error) {').replace('"github.com/zitadel/nextgen/internal/domain"','"github.com/zitadel/nextgen/internal/domain"\n "github.com/zitadel/nextgen/internal/crypto"');
 const anchor='\tmux := http.NewServeMux()';if(!code.includes(anchor))throw Error('handler mount changed');code=code.replace(anchor,anchor+'\n if err := configureMaPiAccount(h, server, mux, accountHashers); err != nil { return nil, err }\n configureMaPiUserCreate(server, mux)');await writeFile(adapter,code);
 const entry=resolve(source,'apps/api/cmd/mapi-wasm/main_wasip1.go');let main=await readFile(entry,'utf8');const call='service.NewRuntimeResolver(pool, releases), flows, projects)';if(!main.includes(call))throw Error('handler call changed');main=main.replace(call,'service.NewRuntimeResolver(pool, releases), flows, projects, hashers)');await writeFile(entry,main);
 const wasm=resolve('worker/generated/usercreate-test.wasm');execFileSync('go',['build','-tags=mapi_account,mapi_usercreate,mapi_flow','-trimpath','-ldflags=-s -w','-buildmode=c-shared','-o',wasm,'./cmd/mapi-wasm'],{cwd:resolve(source,'apps/api'),stdio:'inherit',env:{...process.env,GOWORK:'off',GOOS:'wasip1',GOARCH:'wasm',CGO_ENABLED:'0',GOTOOLCHAIN:'go1.26.9'}});
 let object=await readFile('worker/index.js','utf8');object=object.replace('"./generated/nextgen.wasm"','"./usercreate-test.wasm"').replace('"./generated/fixture.json"','"./fixture.json"').replace('"./wasi.js"','"../wasi.js"').replace('"./sql.js"','"../sql.js"');
 const testAnchor='      case "events":';if(!object.includes(testAnchor))throw Error('test hook changed');
 object=object.replace(testAnchor,`      case "user_count":\n        return sql.exec("SELECT COUNT(*) AS n FROM users WHERE project_id = ?", fixture.projectId).one().n;\n      case "seed_team":\n        sql.exec("INSERT INTO teams (project_id,id,name,created_at,updated_at) VALUES (?,?,?,1800000000000000000,1800000000000000000)", fixture.projectId, id, "Synthetic creation team");return true;\n      case "membership_count":\n        return sql.exec("SELECT COUNT(*) AS n FROM team_memberships WHERE project_id = ? AND team_id = ?", fixture.projectId, id).one().n;\n${testAnchor}`);
 await writeFile('worker/generated/usercreate-test-object.js',object);
 console.log(`Built test-only user-create adapter: ${(await stat(wasm)).size} Wasm bytes.`);
}finally{await rm(root,{recursive:true,force:true});}
