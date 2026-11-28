import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {createServer} from 'node:net';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {setTimeout} from 'node:timers/promises';
import {startLocalZitadel,bootstrapProject} from '@zitadel/testing';
import {client} from './parity.mjs';

async function port(){const s=createServer().listen(0,'127.0.0.1');await once(s,'listening');const p=s.address().port;await new Promise(done=>s.close(done));return p;}
const dir=await mkdtemp(resolve(tmpdir(),'mapi-usercreate-parity-'));let native,server,db,logs='';
try {
 native=await startLocalZitadel({dir:resolve(dir,'native'),projectName:'User creation parity'});
 const user=await native.seedUser();const foreign=await bootstrapProject({baseUrl:native.handle.baseUrl,projectName:'Foreign user creation'});
 const nf={...native.handle,user,otherProjectId:foreign.projectId,otherProjectSecret:foreign.projectSecret};
 const wf=JSON.parse(await readFile('.mapi/fixture.json','utf8'));
 db=new DatabaseSync(resolve(dir,'native/.zitadel/local/nextgen-data/zitadel.db'));
 const p=await port(),inspector=await port();
 server=spawn(process.execPath,[resolve('node_modules/wrangler/bin/wrangler.js'),'dev','--local','--config','scripts/usercreate-test.wrangler.jsonc','--env-file',resolve('.dev.vars.poc'),'--ip','127.0.0.1','--port',String(p),'--inspector-port',String(inspector),'--persist-to',resolve(dir,'state')],{stdio:['ignore','ignore','pipe'],env:{...process.env,WRANGLER_LOG_PATH:resolve(dir,'wrangler.log'),WRANGLER_SEND_METRICS:'false'}});
 server.stderr.on('data',c=>{logs=(logs+c).slice(-8000)});const worker=`http://127.0.0.1:${p}`;
 for(let n=0;;n++){if(server.exitCode!==null||n===100)throw Error('workerd not ready');try{await fetch(worker+'/livez');break;}catch{await setTimeout(200);}}
 async function run(base,f,workerSide){
  const api=client(base,f),session=api.session(await api.exchange(await api.mint())),origin=new URL(base).origin;
  const test=async(command,id)=>{const r=await fetch(base+'/__mapi/test',{method:'POST',body:JSON.stringify({command,id})});assert.equal(r.status,200);return r.json();};
  const count=async()=>workerSide?test('user_count'):db.prepare('SELECT count(*) AS n FROM users WHERE project_id=?').get(f.projectId).n;
  const audit=async()=>workerSide?(await test('events')).events.find(e=>e.event_type==='user.created')?.count??0:db.prepare("SELECT count(*) AS n FROM events WHERE project_id=? AND event_type='user.created'").get(f.projectId).n;
  async function req(path,{token,cookie,body,headers={}}={}){const h={accept:'application/json',...headers};if(token)h.authorization=`Bearer ${token}`;if(cookie)h.cookie=cookie;if(body!==undefined)h['content-type']='application/json';const r=await fetch(base+path,{method:'POST',headers:h,body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(30000)});const text=await r.text();let data;try{data=text?JSON.parse(text):null;}catch{data=null;}return{status:r.status,code:data?.code??null,data};}
  const path=`/users?project_id=${encodeURIComponent(f.projectId)}`,schema=f.schemaId;
  assert.ok(schema,'testing fixture needs a schema ID');
  const email=`create-${randomUUID()}@example.test`,body={schema,attributes:{email}};
  const csrf=await fetch(`${base}/sessions/me/csrf?project_id=${encodeURIComponent(f.projectId)}`,{headers:{cookie:session.cookie}}).then(r=>r.json());assert.ok(csrf.csrf_token);
  const results={};const record=async(label,promise)=>{const r=await promise;results[label]={status:r.status,code:r.code};return r;};
  const before=await count(),eventsBefore=await audit();
  await record('missing credential',req(path,{body}));
  await record('invalid credential',req(path,{token:'invalid',body}));
  await record('session missing csrf',req(path,{cookie:session.cookie,headers:{origin},body}));
  await record('session cross origin',req(path,{cookie:session.cookie,headers:{origin:'https://other.example','x-zitadel-csrf':csrf.csrf_token},body}));
  await record('session only',req(path,{cookie:session.cookie,headers:{origin,'x-zitadel-csrf':csrf.csrf_token},body}));
  const foreignResult=await record('foreign credential',req(path,{token:f.otherProjectSecret,body}));assert.ok(foreignResult.status>=400&&foreignResult.status<500);
  await record('missing project',req('/users',{token:f.projectSecret,body}));
  await record('invalid schema',req(path,{token:f.projectSecret,body:{schema:'missing',attributes:{email}}}));
  await record('invalid attributes',req(path,{token:f.projectSecret,body:{schema,attributes:{email:'invalid'}}}));
  await record('unknown team',req(`${path}&team_id=team_missing`,{token:f.projectSecret,body}));
  assert.equal(await count(),before);assert.equal(await audit(),eventsBefore,'rejected user creation emitted success audit');
  if(workerSide){await test('fail_audit');const failed=await req(path,{token:f.projectSecret,body});assert.equal(failed.status,500);assert.equal(await count(),before,'audit failure retained user');assert.equal(await audit(),eventsBefore,'audit failure retained event');}
  const made=await record('created',req(path,{token:f.projectSecret,body}));assert.ok([200,201].includes(made.status));assert.equal(made.data.attributes.email,email);assert.ok(made.data.id);results.createdFields=Object.keys(made.data).sort();assert.equal(await count(),before+1);assert.equal(await audit(),eventsBefore+1);
  const read=await fetch(`${base}/users/${encodeURIComponent(made.data.id)}`,{headers:{authorization:`Bearer ${f.projectSecret}`}});assert.equal(read.status,200);assert.equal((await read.json()).attributes.email,email);
  await record('duplicate',req(path,{token:f.projectSecret,body}));assert.equal(await count(),before+1);assert.equal(await audit(),eventsBefore+1);
  const raceEmail=`race-${randomUUID()}@example.test`,raceBody={schema,attributes:{email:raceEmail}},race=await Promise.all(Array.from({length:2},()=>req(path,{token:f.projectSecret,body:raceBody})));
  results.concurrent=race.map(r=>({status:r.status,code:r.code})).sort((a,b)=>a.status-b.status);assert.equal(race.filter(r=>[200,201].includes(r.status)).length,1,'concurrent duplicate created multiple users');assert.equal(await count(),before+2);assert.equal(await audit(),eventsBefore+2);
  const alternate=await record('api alias',req(`/api/v1/users?project_id=${encodeURIComponent(f.projectId)}`,{token:f.projectSecret,body:{schema,attributes:{email:`alias-${randomUUID()}@example.test`}}}));assert.ok([200,201].includes(alternate.status));assert.equal(await audit(),eventsBefore+3);
  const team='team_usercreate_test';
  if(workerSide)await test('seed_team',team);else db.prepare('INSERT INTO teams(project_id,id,name,created_at,updated_at) VALUES (?,?,?,1800000000000000000,1800000000000000000)').run(f.projectId,team,'Synthetic creation team');
  const memberships=async()=>workerSide?test('membership_count',team):db.prepare('SELECT count(*) AS n FROM team_memberships WHERE project_id=? AND team_id=?').get(f.projectId,team).n;
  const teamBody={schema,attributes:{email:`team-${randomUUID()}@example.test`}},teamPath=`${path}&team_id=${team}`,beforeTeam=await count(),beforeTeamAudit=await audit();
  assert.equal(await memberships(),0);
  if(workerSide){await test('fail_audit');const failed=await req(teamPath,{token:f.projectSecret,body:teamBody});assert.equal(failed.status,500);assert.equal(await count(),beforeTeam,'failed team create retained user');assert.equal(await memberships(),0,'failed team create retained membership');assert.equal(await audit(),beforeTeamAudit,'failed team create retained audit');}
  const teamUser=await record('create in team',req(teamPath,{token:f.projectSecret,body:teamBody}));assert.equal(teamUser.status,201);assert.equal(await count(),beforeTeam+1);assert.equal(await memberships(),1);assert.equal(await audit(),beforeTeamAudit+1);
  const textCases = [
    { label: 'multibyte', value: 'é😀' },
    { label: 'replacement', value: '\uFFFD' },
    { label: 'invalid UTF-8', value: '\uFFFD', raw: true },
  ];
  const textBytes = async id => workerSide ? test('text_probe_bytes', id) :
    db.prepare("SELECT hex(value) AS bytes FROM user_attributes WHERE project_id = ? AND user_id = ? AND key = 'text_probe'").get(f.projectId, id);
  async function probeText(method, url, mode, attributes, id, credentials) {
    const before = id ? await textBytes(id) : null;
    const fields = { ...(method === 'POST' ? { schema } : {}), attributes };
    const payload = Buffer.from(JSON.stringify({ ...fields, attributes: { ...attributes, text_probe: mode.raw ? 'x' : mode.value } }));
    if (mode.raw) payload[payload.lastIndexOf(Buffer.from('"x"')) + 1] = 0x80;
    const originalCount = await count();
    const response = await fetch(base + url, {
      method, headers: { 'content-type': 'application/json', ...credentials }, body: payload,
    });
    if (mode.raw && response.status >= 400 && response.status < 500) {
      assert.equal(await count(), originalCount);
      if (id) assert.deepEqual(await textBytes(id), before);
      return response.status;
    }
    assert.ok([200, 201].includes(response.status), `${method} ${mode.label}: ${response.status}`);
    const user = await response.json();
    assert.equal(user.attributes.text_probe, mode.value);
    assert.equal((await textBytes(user.id)).bytes, Buffer.from(JSON.stringify(mode.value)).toString('hex').toUpperCase());
    return response.status;
  }
  const adminCredentials = { authorization: `Bearer ${f.projectSecret}` };
  const selfCredentials = { origin, cookie: session.cookie, 'x-zitadel-csrf': csrf.csrf_token };
  for (const mode of textCases) {
    results[`create ${mode.label}`] = await probeText('POST', path, mode, { email: `text-${randomUUID()}@example.test` }, null, adminCredentials);
    results[`admin patch ${mode.label}`] = await probeText('PATCH', `/users/${made.data.id}`, mode, { email }, made.data.id, adminCredentials);
    results[`self patch ${mode.label}`] = await probeText('PATCH', `/users/me?project_id=${encodeURIComponent(f.projectId)}`, mode, { email: f.user.email }, f.user.id, selfCredentials);
  }
  assert.equal((await api.revoke(session)).status,204);
  for(const name of ['missing credential','invalid credential'])assert.equal(results[name].status,401,name);
  for(const name of ['session missing csrf','session cross origin'])assert.equal(results[name].status,403,name);
  assert.equal(results['session only'].status,400,'unprivileged session did not receive upstream invalid-project response');
  assert.equal(results['unknown team'].status,500,'pinned unknown-team behavior changed');
  return results;
 }
 const a=await run(nf.baseUrl,nf,false),b=await run(worker,wf,true);
 for(const name of Object.keys(a)){if(name==='foreign credential')continue;assert.deepEqual(b[name],a[name],name);}
 console.log(JSON.stringify({native:a,worker:b},null,2));
 console.log('Native/workerd user creation, uniqueness, authorization and audit rollback passed; foreign credential status reported.');
}catch(e){if(logs)console.error(logs);throw e;}finally{db?.close();if(server&&server.exitCode===null&&server.signalCode===null){const done=once(server,'exit');server.kill('SIGTERM');await done;}if(native)await native.stop();await rm(dir,{recursive:true,force:true});}
