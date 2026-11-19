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
 const anchor='\tmux := http.NewServeMux()';if(!code.includes(anchor))throw Error('handler mount changed');code=code.replace(anchor,anchor+'\n configureMaPiSelf(h, server, mux)');await writeFile(adapter,code);
 const wasm=resolve('worker/generated/self-test.wasm');execFileSync('go',['build','-tags=mapi_self','-trimpath','-ldflags=-s -w','-buildmode=c-shared','-o',wasm,'./cmd/mapi-wasm'],{cwd:resolve(source,'apps/api'),stdio:'inherit',env:{...process.env,GOWORK:'off',GOOS:'wasip1',GOARCH:'wasm',CGO_ENABLED:'0',GOTOOLCHAIN:'go1.26.9'}});
 let object=await readFile('worker/index.js','utf8');object=object.replace('"./generated/nextgen.wasm"','"./self-test.wasm"').replace('"./generated/fixture.json"','"./fixture.json"').replace('"./wasi.js"','"../wasi.js"').replace('"./sql.js"','"../sql.js"');const seedAnchor='  handleRequest(request) {';
 if(!object.includes(seedAnchor))throw Error('missing fixture hook');
 object=object.replace(seedAnchor,`  seedSelfData(userId) {
    if (this.env.MAPI_LOCAL_TEST !== '1') throw new Error('local only');
    this.#initialize();
    const sql = this.ctx.storage.sql;
    this.ctx.storage.transactionSync(() => {
      const schema = sql.exec('SELECT schema_url FROM users WHERE project_id=? AND id=?',fixture.projectId,userId).one().schema_url;
      sql.exec("INSERT INTO users(project_id,id,schema_url,status,created_at,updated_at) VALUES(?,?,?,'active',1800000000000000000,1800000000000000000)",fixture.projectId,'user_self_decoy',schema);
      for (const [n,status] of [[1,'active'],[2,'inactive'],[3,'removed']]) {
        const id = 'team_self_test_' + n;
        sql.exec("INSERT INTO teams(project_id,id,name,created_at,updated_at) VALUES(?,?,?,1800000000000000000,1800000000000000000)", fixture.projectId,id,'Self Team ' + n);
        sql.exec("INSERT INTO team_memberships(project_id,team_id,user_id,status,created_at,updated_at) VALUES(?,?,?,?,1800000000000000000,1800000000000000000)",fixture.projectId,id,userId,status);
      }
      for (const n of [1,2]) {
        const connection = 'idp_self_test_' + n;
        sql.exec("INSERT INTO idp_connections(project_id,id,slug,created_at) VALUES(?,?,?,1800000000000000000)",fixture.projectId,connection,'self-test-' + n);
        sql.exec("INSERT INTO idp_identity_links(project_id,id,connection_id,subject,user_id,created_at) VALUES(?,?,?,?,?,1800000000000000000)",fixture.projectId,'link_self_test_'+n,connection,'sensitive-subject-'+n,userId);
      }
      sql.exec("INSERT INTO teams(project_id,id,name,created_at,updated_at) VALUES(?,?,?,1800000000000000000,1800000000000000000)",fixture.projectId,'team_self_decoy','Self Team Decoy');
      sql.exec("INSERT INTO team_memberships(project_id,team_id,user_id,status,created_at,updated_at) VALUES(?,?,?,'active',1800000000000000000,1800000000000000000)",fixture.projectId,'team_self_decoy','user_self_decoy');
      sql.exec("INSERT INTO idp_identity_links(project_id,id,connection_id,subject,user_id,created_at) VALUES(?,?,?,?,?,1800000000000000000)",fixture.projectId,'link_self_decoy','idp_self_test_1','decoy-subject','user_self_decoy');
    });return true;
  }

${seedAnchor}`);
 await writeFile('worker/generated/self-test-object.js',object);
 console.log(`Built test-only self-service adapter: ${(await stat(wasm)).size} Wasm bytes.`);
}finally{await rm(root,{recursive:true,force:true});}
