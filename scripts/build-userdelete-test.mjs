import { cp, mkdir, mkdtemp, readFile, rm, writeFile, stat } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
const root=await mkdtemp(resolve(tmpdir(),'mapi-account-build-'));
try {
 const source=resolve(root,'nextgen');await mkdir(source);
 const tar=resolve(root,'source.tar');execFileSync('git',['-C',resolve('.mapi/nextgen'),'archive','--format=tar',`--output=${tar}`,'b0b74cd4a198428ea9b82910c217259ffc62b65c'],{stdio:'inherit'});
 execFileSync('tar',['-xf',tar,'-C',source],{stdio:'inherit'});await cp('upstream/overlay',source,{recursive:true});
 execFileSync('git',['apply','--unidiff-zero',resolve('upstream/audit-tracing.patch')],{cwd:source,stdio:'inherit'});
 for(const file of ['dialect','error','pool','with_transaction']){const path=resolve(source,`apps/api/internal/storage/dialect/sqlite/${file}.go`);await writeFile(path,`//go:build !wasip1\n\n${await readFile(path,'utf8')}`);}
 const adapter=resolve(source,'apps/api/internal/api/cloudflare_wasip1.go');let code=await readFile(adapter,'utf8');
 const anchor='\tmux := http.NewServeMux()';if(!code.includes(anchor))throw Error('handler mount changed');code=code.replace(anchor,anchor+'\n configureMaPiUserDelete(h, server, mux)');await writeFile(adapter,code);
 const wasm=resolve('worker/generated/userdelete-test.wasm');execFileSync('go',['build','-tags=mapi_userdelete','-trimpath','-ldflags=-s -w','-buildmode=c-shared','-o',wasm,'./cmd/mapi-wasm'],{cwd:resolve(source,'apps/api'),stdio:'inherit',env:{...process.env,GOWORK:'off',GOOS:'wasip1',GOARCH:'wasm',CGO_ENABLED:'0',GOTOOLCHAIN:'go1.26.9'}});
 let object=await readFile('worker/index.js','utf8');object=object.replace('"./generated/nextgen.wasm"','"./userdelete-test.wasm"').replace('"./generated/fixture.json"','"./fixture.json"').replace('"./wasi.js"','"../wasi.js"').replace('"./sql.js"','"../sql.js"');const hook='  handleRequest(request) {';if(!object.includes(hook))throw Error('missing fixture hook');
 object=object.replace(hook,`  deleteFixture(user, foreignProject, action) {
    if(this.env.MAPI_LOCAL_TEST!=='1')throw new Error('local only');this.#initialize();const sql=this.ctx.storage.sql;
    if(action==='seed')this.ctx.storage.transactionSync(()=>{
      const project=fixture.projectId,schema=sql.exec('SELECT schema_url FROM users WHERE project_id=? AND id=?',project,user).one().schema_url;
      sql.exec("INSERT INTO teams(project_id,id,name,created_at,updated_at) VALUES(?,?,?,1800000000000000000,1800000000000000000)",project,'team_delete_test','Delete Test Team');
      sql.exec("INSERT INTO resource_scope_index(resource_id,resource_kind,project_id,team_id,created_at,updated_at) VALUES(?,?,?,NULL,1800000000000000000,1800000000000000000)",'team_delete_test','team',project);
      sql.exec("INSERT INTO team_memberships(project_id,team_id,user_id,status,created_at,updated_at) VALUES(?,?,?,'active',1800000000000000000,1800000000000000000)",project,'team_delete_test',user);
      sql.exec("INSERT INTO authz_membership_edges(project_id,member_type,member_id,set_type,set_id,created_at) VALUES(?,'user',?,'team',?,1800000000000000000)",project,user,'team_delete_test');
      sql.exec("INSERT INTO users(project_id,id,schema_url,status,created_at,updated_at) VALUES(?,?,?,'active',1800000000000000000,1800000000000000000)",project,'user_delete_decoy',schema);
      for(const [id,principal,relation,type] of [['assignment_user_delete',user,'viewer','user'],['assignment_user_decoy','user_delete_decoy','viewer','user'],['assignment_user_owner','team_delete_test','team','team']])sql.exec("INSERT INTO authz_assignments(id,project_id,catalog_id,principal_type,principal_id,object_type,relation,scope_kind,created_at,updated_at) VALUES(?,?,'cat_sys_1',?,?,'project',?,'project',1800000000000000000,1800000000000000000)",id,foreignProject,type,principal,relation);
    });
    if(action==='release')sql.exec("UPDATE authz_assignments SET revoked_at=1800000000000000001 WHERE project_id=? AND id='assignment_user_owner'",foreignProject);
    const count=(q,...args)=>sql.exec(q,...args).one().n;
    return {user:count('SELECT COUNT(*) AS n FROM users WHERE project_id=? AND id=?',fixture.projectId,user),membership:count('SELECT COUNT(*) AS n FROM team_memberships WHERE project_id=? AND user_id=?',fixture.projectId,user),grant:count("SELECT COUNT(*) AS n FROM authz_assignments WHERE project_id=? AND id='assignment_user_delete' AND revoked_at IS NULL",foreignProject),decoy:count("SELECT COUNT(*) AS n FROM authz_assignments WHERE project_id=? AND id='assignment_user_decoy' AND revoked_at IS NULL",foreignProject),deleted:count("SELECT COUNT(*) AS n FROM events WHERE project_id=? AND event_type='user.deleted'",fixture.projectId),revoked:count("SELECT COUNT(*) AS n FROM events WHERE project_id=? AND event_type='authz.revoked'",foreignProject)};
  }

${hook}`);await writeFile('worker/generated/userdelete-test-object.js',object);
 console.log(`Built test-only user-deletion adapter: ${(await stat(wasm)).size} Wasm bytes.`);
}finally{await rm(root,{recursive:true,force:true});}
