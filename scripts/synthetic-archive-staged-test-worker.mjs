export { SyntheticArchiveStagedDestination } from './synthetic-archive-staged-destination.mjs';
const bytes = new TextEncoder();
async function hash(s) { return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes.encode(s)))].map(x=>x.toString(16).padStart(2,'0')).join(''); }
function check(v, m) { if (!v) throw Error(m); }
async function rejects(fn, m) { try { await fn(); } catch { return; } throw Error(m); }
async function fixture(env, name) {
  let target=env.TARGET.getByName(name);
  const p0={projectId:name,generation:1,moveId:'move',index:0,prev:'',table:'users',columns:['id','name'],offset:0,rows:[['u1','Alice'],['u2','Bob']],last:true,done:false,cursor:['u2']};
  const content0=JSON.stringify(p0), digest0=await hash(content0);
  const p1={projectId:name,generation:1,moveId:'move',index:1,prev:digest0,table:'events',columns:['id','payload'],offset:0,rows:[[{integer:'-9223372036854775808'},'audit one'],[{integer:'9223372036854775807'},'audit two']],last:true,done:true,cursor:[{integer:'9223372036854775807'}]};
  const content1=JSON.stringify(p1), digest1=await hash(content1);
  const config={scope:{runId:'synthetic',archiveId:'a'.repeat(32),manifestDigest:'b'.repeat(64)},envelopeDigest:'c'.repeat(64),destinationName:`destination-${name}`,commitment:{projectId:name,origin:'https://synthetic.invalid',objectName:'source',generation:1,moveId:'move',manifestDigest:'b'.repeat(64),tables:['users','events'],chunkCount:2,finalDigest:digest1}};
  const {identityDigest}=await target.initializeFixture(config);
  const selector='d'.repeat(64), record='e'.repeat(64);
  const inventory0=await hash(JSON.stringify(['mapi-archive-inventory-v1','',0,selector,record]));
  const inventory1=await hash(JSON.stringify(['mapi-archive-inventory-v1',inventory0,1,selector,record]));
  const cp0={identityDigest,sealDigest:'f'.repeat(64),inventoryDigest:inventory1,next:0,previous:'',inventory:'',table:0,complete:false};
  const cp1={...cp0,next:1,previous:digest0,inventory:inventory0,table:1};
  const cp2={...cp1,next:2,previous:digest1,inventory:inventory1,table:2};
  const step0={expected:cp0,next:cp1,content:content0,index:0,digest:digest0,selectorDigest:selector,recordDigest:record};
  const step1={expected:cp1,next:cp2,content:content1,index:1,digest:digest1,selectorDigest:selector,recordDigest:record};
  await target.begin(cp0);
  await rejects(()=>target.apply(step1),'out of order accepted');
  await target.abortAfterNextImport();
  await rejects(()=>target.apply(step0),'interruption did not abort');
  target=env.TARGET.getByName(name);
  let state=await target.fixtureState();
  check(state.checkpoint.next===0 && state.importer.next_chunk===1 && state.users.length===2 && state.inserts[0].count===2,'interrupted checkpoint not durable');
  const altered={...p0,rows:[['u1','Changed'],['u2','Bob']]}, changed=JSON.stringify(altered), changedDigest=await hash(changed);
  await rejects(()=>target.apply({...step0,content:changed,digest:changedDigest,next:{...cp1,previous:changedDigest}}),'conflicting replay accepted');
  await target.apply(step0); await target.apply(step0);
  state=await target.fixtureState();
  check(state.checkpoint.next===1 && state.users.length===2 && state.inserts[0].count===2,'replay reinserted users');
  await target.corruptCheckpointForTest(JSON.stringify({...cp1,previous:'0'.repeat(64)}));
  await rejects(()=>target.load(),'corrupted checkpoint accepted');
  await target.corruptCheckpointForTest(JSON.stringify(cp1));
  await target.apply(step1);
  state=await target.fixtureState();
  check(JSON.stringify(state.users)===JSON.stringify([{id:'u1',name:'Alice'},{id:'u2',name:'Bob'}]),'users differ');
  check(JSON.stringify(state.events)===JSON.stringify([{id:'-9223372036854775808',payload:'audit one'},{id:'9223372036854775807',payload:'audit two'}]),'audit events differ');
  check(JSON.stringify(state.inserts)===JSON.stringify([{kind:'event',count:2},{kind:'user',count:2}]),'unexpected insert audit');
  await target.corruptRowsForTest(); await rejects(()=>target.finish(cp2),'corrupt rows accepted');
  await target.restoreRowsForTest(); await target.finish(cp2); await target.finish(cp2);
  state=await target.fixtureState(); check(state.checkpoint.complete && state.inserts.every(x=>x.count===2),'completion or replay differs');
  return {project:name,users:state.users.length,events:state.events.length,next:state.checkpoint.next};
}
export default { async fetch(request,env) { try { const results=await Promise.all([fixture(env,'synthetic-a'),fixture(env,'synthetic-b')]); return Response.json({ok:true,results}); } catch(error) { return Response.json({ok:false,error:String(error?.stack||error)},{status:500}); } } };
