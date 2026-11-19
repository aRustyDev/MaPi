import { DurableObject } from 'cloudflare:workers';
import wasm from '../worker/generated/flow-release-test.wasm';
import baseline from '../worker/generated/baseline.json';
import defaultFlow from '../worker/generated/default-login-test.json';
import { instantiateReactor } from '../worker/wasi.js';
import { execute, sqliteError } from '../worker/sql.js';
const encoder=new TextEncoder(),decoder=new TextDecoder(),rejected=Symbol('rollback');
export class FlowReleaseTest extends DurableObject {
 async run(key){
  this.ctx.storage.transactionSync(()=>{for(const statement of baseline.statements)this.ctx.storage.sql.exec(statement);this.ctx.storage.sql.exec('CREATE TABLE mapi_project(project_id TEXT PRIMARY KEY, schema_url TEXT NOT NULL)');this.ctx.storage.sql.exec('CREATE TABLE mapi_project_origin(origin TEXT NOT NULL)');this.ctx.storage.sql.exec('INSERT INTO mapi_project_origin VALUES (?)','https://issuer.example');});
  let reactor,memory,output,failAudit=false;
  reactor=instantiateReactor(wasm,getMemory=>{memory=getMemory;return{
   sql:(p,n)=>{const q=JSON.parse(decoder.decode(new Uint8Array(memory(),p,n)));let result;try{if(failAudit&&/\bINSERT INTO events\b/i.test(q.statement)){failAudit=false;throw new Error('injected audit failure');}result=execute(this.ctx.storage,q);}catch(e){result={error:sqliteError(e)};}output=encoder.encode(JSON.stringify(result));return output.length;},
   result:(p,n)=>{new Uint8Array(memory(),p,n).set(output);output.fill(0);output=undefined;},
   transaction:()=>{try{this.ctx.storage.transactionSync(()=>{if(reactor.mapi_transaction_body()!==0)throw rejected;});return 0;}catch(e){return e===rejected?1:2;}},
  };},()=>{});
  const call=(name,input)=>{const bytes=encoder.encode(JSON.stringify(input)),p=reactor.mapi_alloc(bytes.length);new Uint8Array(memory(),p,bytes.length).set(bytes);bytes.fill(0);const packed=reactor[name](),ptr=Number(packed>>32n),n=Number(packed&0xffffffffn),result=JSON.parse(decoder.decode(new Uint8Array(memory(),ptr,n)));reactor.mapi_release();return result;};
  function ok(result){if(result?.error)throw Error(result.error);return result;}
  ok(call('mapi_init',{id:'master-test',pem:key,projectId:''}));
  const projectId=ok(call('mapi_provision',{name:'Flow release test',origin:'https://issuer.example'})).projectId;
  const common={projectId,origin:'https://issuer.example'},flow=(action,args={})=>call('mapi_flow_release',{...common,action,...args});
  const initial=ok(flow('status'));if(!initial.deploymentId||initial.loginFlows.length!==1)throw Error('initial login flow missing');
  const tables=['flow_definitions','releases','deployments','events'];
  const counts=()=>tables.map(table=>this.ctx.storage.sql.exec(`SELECT COUNT(*) AS n FROM ${table} WHERE project_id=?`,projectId).one().n);
  const original=counts(),unchanged=()=>{if(JSON.stringify(counts())!==JSON.stringify(original))throw Error('failed publish retained mutations or audit');};
  if(!flow('status',{origin:'https://other.example'}).error)throw Error('foreign origin accepted');
  const doc=structuredClone(defaultFlow);doc.name=initial.loginFlows[0].name;doc.steps[0].actions[0].text_key='identifier.action.modified';
  if(!flow('publish',{document:{name:'invalid',steps:[]},expectedDeploymentId:initial.deploymentId}).error)throw Error('invalid flow accepted');unchanged();
  if(!flow('publish',{document:doc,expectedDeploymentId:'stale'}).error)throw Error('stale publish accepted');unchanged();
  failAudit=true;if(!flow('publish',{document:doc,expectedDeploymentId:initial.deploymentId}).error||failAudit)throw Error('injected audit failure was not detected');unchanged();
  const published=ok(flow('publish',{document:doc,expectedDeploymentId:initial.deploymentId}));
  if(published.deploymentId===initial.deploymentId||published.releaseId===initial.releaseId||!published.flowRevisionId)throw Error('flow deployment missing');
  for(const [type,id] of [['flowdef.created',published.flowRevisionId],['release.created',published.releaseId],['deployment.created',published.deploymentId]]){
   const audit=this.ctx.storage.sql.exec('SELECT actor_id,actor_type FROM events WHERE project_id=? AND event_type=? AND entity_id=?',projectId,type,id).toArray();
   if(audit.length!==1||audit[0].actor_id!=='mapi_operator'||audit[0].actor_type!=='service')throw Error('operator audit actor missing');
  }
  const active=ok(flow('status'));if(active.deploymentId!==published.deploymentId||active.loginFlows[0].revisionId!==published.flowRevisionId)throw Error('new flow not active');
  const pointers=id=>JSON.parse(this.ctx.storage.sql.exec('SELECT pointers FROM releases WHERE project_id=? AND id=?',projectId,id).one().pointers).filter(p=>p.kind!=='flow_definition');
  if(JSON.stringify(pointers(initial.releaseId))!==JSON.stringify(pointers(published.releaseId)))throw Error('non-flow release pointers changed');
  if(!flow('rollback',{targetDeploymentId:initial.deploymentId,expectedDeploymentId:initial.deploymentId}).error)throw Error('stale rollback accepted');
  const restored=ok(flow('rollback',{targetDeploymentId:initial.deploymentId,expectedDeploymentId:published.deploymentId}));
  const final=ok(flow('status'));if(restored.releaseId!==initial.releaseId||final.releaseId!==initial.releaseId||final.loginFlows[0].revisionId!==initial.loginFlows[0].revisionId)throw Error('rollback did not restore the original flow');
  const rollbackAudit=this.ctx.storage.sql.exec('SELECT actor_id,actor_type FROM events WHERE project_id=? AND event_type=? AND entity_id=?',projectId,'deployment.created',restored.deploymentId).toArray();
  if(rollbackAudit.length!==1||rollbackAudit[0].actor_id!=='mapi_operator'||rollbackAudit[0].actor_type!=='service')throw Error('rollback audit actor missing');
  const events=this.ctx.storage.sql.exec('SELECT event_type FROM events WHERE project_id=?',projectId).toArray().map(x=>x.event_type);
  for(const kind of ['flowdef.created','release.created','deployment.created'])if(!events.includes(kind))throw Error('missing upstream mutation audit');
  return {ok:true,memoryBytes:memory().byteLength};
 }
}
export default{async fetch(request,env){try{return Response.json(await env.FLOW_RELEASE_TEST.getByName('isolated').run((await request.json()).pem));}catch(error){return Response.json({ok:false,error:String(error)},{status:500});}}};
