import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
const base=process.env.MAPI_URL, token=process.env.MAPI_OPERATOR_TOKEN, phase=process.argv[2];
const file='.mapi/phase0-recovery-state.json';
const auth={authorization:`Bearer ${token}`,'content-type':'application/json'};
async function request(path,{method='GET',body,headers={}}={}) { return fetch(base+path,{method,headers:{...headers},body,redirect:'manual'}); }
async function admin(path,body) { const r=await request('/_mapi/admin/'+path,{method:body?'POST':'GET',headers:auth,body:body?JSON.stringify(body):undefined}); assert.ok(r.ok,`${path}: ${r.status}`); return r.status===204?null:r.json(); }
async function proof(body) { const r=await request('/_mapi/phase0-proof',{method:'POST',headers:auth,body:JSON.stringify(body)}); assert.equal(r.status,200,`proof ${body.action}: ${r.status}`); return r.json(); }
async function login(email,password) { const r=await request('/login',{method:'POST',headers:{origin:base,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({email,password})}); assert.equal(r.status,303); return r.headers.get('set-cookie').split(';')[0]; }
async function app(cookie) {return (await request('/app',{headers:{cookie}})).status;}
if (phase==='setup') {
 const email=`phase0-${randomUUID()}@example.test`, password=`Example-${randomUUID()}!`; await admin('users',{email,password});
 const active=await login(email,password), revoked=await login(email,password);
 const appResponse=await request('/app',{headers:{cookie:revoked}}); const csrf=(await appResponse.text()).match(/name="csrf" value="([A-Za-z0-9_-]+)"/)[1];
 const logout=await request('/logout',{method:'POST',headers:{cookie:revoked,origin:base},body:new URLSearchParams({csrf})}); assert.equal(logout.status,303);
 assert.equal(await app(active),200); assert.equal(await app(revoked),303);
 await writeFile(file,JSON.stringify({email,password,active,revoked}),{mode:0o600}); console.log('Synthetic active and revoked sessions created.');
} else {
 const state=JSON.parse(await readFile(file,'utf8'));
 if (phase==='rollback-check') {assert.equal(await app(state.active),200);assert.equal(await app(state.revoked),303);console.log('Rollback retained active and revoked session state.');}
 if (phase==='bookmark') { state.mintedAt=Date.now(); const minted=await proof({action:'mint',email:state.email,password:state.password}); assert.equal(minted.status,200); state.handoff=minted.handoff; state.before=await proof({action:'counts'}); state.bookmark=(await admin('bookmark')).bookmark; const postEmail=`after-${randomUUID()}@example.test`; await admin('users',{email:postEmail,password:state.password}); const after=await proof({action:'counts'}); assert.equal(after.users,state.before.users+1);assert.ok(after.events>state.before.events); await writeFile(file,JSON.stringify(state),{mode:0o600});console.log('Bookmark captured with pending handoff; later user and audit writes verified.',JSON.stringify({before:state.before,after})); }
 if (phase==='restore') { const r=await request('/_mapi/admin/restore',{method:'POST',headers:auth,body:JSON.stringify({bookmark:state.bookmark})}); assert.equal(r.status,202);console.log('Restore scheduled.'); }
 if (phase==='recover') { const pre=await proof({action:'counts'}); assert.deepEqual(pre,state.before);const s=await admin('status');assert.equal(s.maintenance,true);assert.equal(s.recoveryReady,false);await admin('recover',{}); const after=await proof({action:'counts'}); assert.equal(after.users,pre.users);assert.equal(after.recoveryEvents,pre.recoveryEvents+1);assert.ok(after.events>pre.events);const ready=await admin('status');assert.equal(ready.recoveryReady,true);console.log('Restored bookmarked user/audit counts; recovery audit and epoch committed.',JSON.stringify({restored:pre,recovered:after})); }
 if (phase==='verify') {assert.equal(await app(state.active),303);assert.equal(await app(state.revoked),303);const result=await proof({action:'exchange',handoff:state.handoff});const ageMs=Date.now()-state.mintedAt;assert.ok(ageMs<60000,`handoff expired before verification: ${ageMs}ms`);console.log('Handoff age at rejection:',ageMs,'ms');assert.ok(result.status>=400,`handoff status ${result.status}`); console.log('Recovered active and revoked sessions rejected; pending handoff rejected with HTTP',result.status);}
}
