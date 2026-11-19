import { DurableObject } from 'cloudflare:workers';
import wasm from '../worker/generated/oauth-composition-test.wasm';
import baseline from '../worker/generated/baseline.json';
import { instantiateReactor } from '../worker/wasi.js';
import { execute, sqliteError } from '../worker/sql.js';
const encoder=new TextEncoder(), decoder=new TextDecoder(), rejected=Symbol('rollback');
export class OAuthCompositionTest extends DurableObject {
 async run(key) {
  const start=Date.now();
  this.ctx.storage.transactionSync(()=>{
   for(const statement of baseline.statements) this.ctx.storage.sql.exec(statement);
   this.ctx.storage.sql.exec('CREATE TABLE mapi_project(project_id TEXT PRIMARY KEY, schema_url TEXT NOT NULL)');
   this.ctx.storage.sql.exec('CREATE TABLE mapi_project_origin(origin TEXT NOT NULL)');
   this.ctx.storage.sql.exec('INSERT INTO mapi_project_origin VALUES (?)','https://issuer.example');
  });
  let reactor, memory, output, diagnostic='', failAudit=false;
  reactor=instantiateReactor(wasm,(getMemory)=>{
   memory=getMemory;
   return {
    sql:(p,n)=>{const query=JSON.parse(decoder.decode(new Uint8Array(memory(),p,n)));let result;try{if(failAudit&&/\bINSERT INTO events\b/i.test(query.statement)){failAudit=false;throw new Error('injected audit failure');}result=execute(this.ctx.storage,query);}catch(e){result={error:sqliteError(e)};}output=encoder.encode(JSON.stringify(result));return output.length;},
    result:(p,n)=>{new Uint8Array(memory(),p,n).set(output);output.fill(0);output=undefined;},
    transaction:()=>{try{this.ctx.storage.transactionSync(()=>{if(reactor.mapi_transaction_body()!==0)throw rejected;});return 0;}catch(e){return e===rejected?1:2;}},
   };
  },(bytes)=>{diagnostic+=decoder.decode(bytes);});
  function call(name,object){const bytes=encoder.encode(JSON.stringify(object)),p=reactor.mapi_alloc(bytes.length);new Uint8Array(memory(),p,bytes.length).set(bytes);bytes.fill(0);const packed=reactor[name]();const ptr=Number(packed>>32n),n=Number(packed&0xffffffffn),value=JSON.parse(decoder.decode(new Uint8Array(memory(),ptr,n)));reactor.mapi_release();if(value?.error)throw new Error(`${name}: ${value.error} ${diagnostic.slice(-300)}`);return value;}
  call('mapi_init',{id:'master-test',pem:key,projectId:''});
  const project=call('mapi_provision',{name:'OAuth composition test',origin:'https://issuer.example'}).projectId;
  const args={projectId:project,origin:'https://issuer.example'};
  const first=call('mapi_oauth_admin',{...args,action:'initialize'});
  // Rehearse a real v1-to-v4 migration after the Go bridge read the schema.
  this.ctx.storage.transactionSync(()=>{this.ctx.storage.sql.exec('DROP TABLE mapi_oauth_revoked_access').toArray();this.ctx.storage.sql.exec('DROP TABLE mapi_oauth_logout_uris').toArray();this.ctx.storage.sql.exec('DROP TABLE mapi_oauth_client_epochs').toArray();this.ctx.storage.sql.exec('UPDATE mapi_oauth_schema SET version=1 WHERE singleton=1').toArray();});
  const retry=call('mapi_oauth_admin',{...args,action:'initialize'});
  if(first.keyId!==retry.keyId)throw new Error('initialization rotated key');
  const registered=call('mapi_oauth_admin',{...args,action:'register',document:{slug:'shop',name:'Shop',clients:[{slug:'web',type:'confidential',grant_types:['authorization_code','refresh_token'],redirect_uris:['https://shop.example/callback']}]}});
  if(registered.Secrets?.length!==1||!registered.Secrets[0].Secret)throw new Error('missing one-time upstream client secret');
  const logoutURI='https://shop.example/signed-out?from=mapi';
  call('mapi_oauth_admin',{...args,action:'register_logout',clientId:registered.Secrets[0].ClientID,logoutUri:logoutURI});
  call('mapi_oauth_admin',{...args,action:'register_logout',clientId:registered.Secrets[0].ClientID,logoutUri:logoutURI});

  const rotated=call('mapi_oauth_admin',{...args,action:'rotate'});
  if(rotated.keyId===first.keyId)throw new Error('rotation did not change key');
  const result=call('mapi_oauth_request',{...args,request:{method:'GET',url:`https://issuer.example/oauth/${project}/jwks`,headers:{},body:'',peer:'127.0.0.1'}});
  const jwks=JSON.parse(decoder.decode(Uint8Array.fromBase64(result.body)));
  if(result.status!==200||jwks.keys.length!==2||jwks.keys.some(k=>k.d))throw new Error('invalid JWKS');
  // Exercise the private issuer against a real Nextgen password session.
  call('mapi_init',{id:'master-test',pem:key,projectId:project});
  const email='synthetic@example.test',password='Test-Passphrase-49!';
  call('mapi_add_user',{projectId:project,email,password});
  const projectToken=call('mapi_project_token',{projectId:project}).token;
  const secret=registered.Secrets[0],verifier='abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~';
  const digest=new Uint8Array(await crypto.subtle.digest('SHA-256',encoder.encode(verifier)));
  const challenge=digest.toBase64().replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
  const query=new URLSearchParams({client_id:secret.ClientID,redirect_uri:'https://shop.example/callback',response_type:'code',scope:'openid offline_access',state:'test-state',nonce:'test-nonce',code_challenge:challenge,code_challenge_method:'S256'});
  const oauth=(method,path,headers={},body='')=>call('mapi_oauth_request',{...args,request:{method,url:'https://issuer.example'+path,headers,body:encoder.encode(body).toBase64(),peer:'127.0.0.1'}});
  const metadata=oauth('GET',`/oauth/${project}/.well-known/openid-configuration`);
  const discovery=JSON.parse(decoder.decode(Uint8Array.fromBase64(metadata.body)));
  if(metadata.status!==200||discovery.issuer!==first.issuer)throw new Error('discovery issuer mismatch');
  for(const [name,path] of Object.entries({authorization_endpoint:'authorize',token_endpoint:'token',jwks_uri:'jwks',userinfo_endpoint:'userinfo',revocation_endpoint:'revoke',end_session_endpoint:'end_session'}))if(discovery[name]!==`${first.issuer}/${path}`)throw new Error(`discovery ${name} mismatch`);
  const profiles={response_types_supported:['code'],response_modes_supported:['query'],grant_types_supported:['authorization_code','refresh_token'],subject_types_supported:['public'],id_token_signing_alg_values_supported:['RS256'],scopes_supported:['openid','offline_access'],token_endpoint_auth_methods_supported:['client_secret_basic','client_secret_post'],revocation_endpoint_auth_methods_supported:['client_secret_basic','client_secret_post'],code_challenge_methods_supported:['S256'],claims_supported:['iss','sub','aud','exp','iat','auth_time','nonce','sid','at_hash']};
  for(const [name,values] of Object.entries(profiles))if(JSON.stringify(discovery[name])!==JSON.stringify(values))throw new Error(`discovery ${name} mismatch`);
  if(Object.keys(discovery).length!==1+6+Object.keys(profiles).length)throw new Error('unexpected discovery profile fields');
  for(const [field,value] of [['code_challenge_method','plain'],['scope','openid email'],['response_type','token']]){
   const unsupported=new URLSearchParams(query);unsupported.set(field,value);
   const result=oauth('GET',`/oauth/${project}/authorize?${unsupported}`);
   if(result.headers.Location?.[0]?.startsWith('https://issuer.example/login'))throw new Error(`unsupported ${field} accepted`);
  }
  const silentQuery=new URLSearchParams(query);silentQuery.set('prompt','none');
  const silent=oauth('GET',`/oauth/${project}/authorize?${silentQuery}`);
  if(silent.status!==302||new URL(silent.headers.Location[0]).searchParams.get('error')!=='interaction_required')throw new Error('valid PKCE prompt=none did not return interaction_required');
  silentQuery.delete('code_challenge');silentQuery.delete('code_challenge_method');
  const silentWithoutPKCE=oauth('GET',`/oauth/${project}/authorize?${silentQuery}`);
  if(silentWithoutPKCE.status!==302||new URL(silentWithoutPKCE.headers.Location[0]).searchParams.get('error')!=='invalid_request')throw new Error('prompt=none bypassed mandatory PKCE');
  const auth=oauth('GET',`/oauth/${project}/authorize?${query}`);
  if(auth.status!==302)throw new Error(`OAuth authorize returned ${auth.status}: ${decoder.decode(Uint8Array.fromBase64(auth.body)).slice(0,300)}`);
  const handle=new URL(auth.headers.Location[0]).searchParams.get('mapi_oauth');
  const binding=auth.headers['Set-Cookie'][0].split(';')[0];
  let flowCookie='';
  function upstream(method,path,body,needsProjectToken=false){
   const headers={accept:['application/json']};
   if(needsProjectToken)headers.authorization=[`Bearer ${projectToken}`];
   if(flowCookie)headers.cookie=[flowCookie];
   if(body!==undefined)headers['content-type']=['application/json'];
   const r=call('mapi_request',{method,url:'https://issuer.example'+path,headers,body:body===undefined?'':encoder.encode(JSON.stringify(body)).toBase64(),peer:'127.0.0.1'});
   const text=decoder.decode(Uint8Array.fromBase64(r.body));
   if(r.status<200||r.status>=300)throw new Error(`upstream ${method} ${path.split('?')[0]} returned ${r.status}: ${text.slice(0,300)}`);
   const updated=(r.headers['Set-Cookie']??[]).find(value=>value.startsWith('_zflow='));
   if(updated)flowCookie=updated.split(';')[0];
   return {...r,data:text?JSON.parse(text):null};
  }
  let flow=upstream('POST','/flows',{project_id:project,purpose:'login'}).data;
  if(!flowCookie||upstream('GET',`/flows/${encodeURIComponent(flow.id)}`).data.id!==flow.id)throw new Error('upstream flow read failed');
  for(let hop=0;hop<6&&!flow.handoff_token;hop++){
   const fields={};
   for(const field of flow.step.fields??[]){const name=field.name.split(/[#/.]/).at(-1).toLowerCase();if(name==='email')fields[field.name]=email;else if(name==='password')fields[field.name]=password;else throw new Error(`unrecognized flow field ${name}`);}
   flow=upstream('POST',`/flows/${encodeURIComponent(flow.id)}/submit`,{action:'submit',fields,...(flow.session_token?{session_token:flow.session_token}:{})}).data;
  }
  if(!flow.handoff_token)throw new Error('password flow did not produce a handoff');
  const session=upstream('POST',`/sessions/exchange?project_id=${encodeURIComponent(project)}`,{handoff_token:flow.handoff_token},true);
  const sessionCookie=session.headers['Set-Cookie'][0].split(';')[0];
  const cookie=`${sessionCookie}; ${binding}`;
  const continuation=oauth('GET',`/oauth/continue?request=${encodeURIComponent(handle)}`,{cookie:[cookie]});
  const html=decoder.decode(Uint8Array.fromBase64(continuation.body)),csrf=html.match(/name="csrf" value="([^"]+)"/)?.[1];
  if(continuation.status!==200||!csrf)throw new Error(`continuation page failed: ${continuation.status}`);
  const complete=oauth('POST','/oauth/continue',{cookie:[cookie],origin:['https://issuer.example'],'content-type':['application/x-www-form-urlencoded']},new URLSearchParams({request:handle,csrf}).toString());
  if(complete.status!==303)throw new Error(`continuation returned ${complete.status}: ${decoder.decode(Uint8Array.fromBase64(complete.body)).slice(0,300)}`);
  const redirect=new URL(complete.headers.Location[0]),code=redirect.searchParams.get('code');
  if(redirect.searchParams.get('state')!=='test-state'||!code)throw new Error('invalid authorization response');
  const tokenForm=new URLSearchParams({grant_type:'authorization_code',code,redirect_uri:'https://shop.example/callback',code_verifier:verifier});
  const credentials=btoa(`${encodeURIComponent(secret.ClientID)}:${encodeURIComponent(secret.Secret)}`);
  const tokenHeaders={authorization:[`Basic ${credentials}`],'content-type':['application/x-www-form-urlencoded']};
  const badTokenHeaders={...tokenHeaders,authorization:[`Basic ${btoa(`${encodeURIComponent(secret.ClientID)}:wrong`)}`]};
  if(oauth('POST',`/oauth/${project}/token`,badTokenHeaders,tokenForm.toString()).status===200)throw new Error('invalid client secret accepted');
  const token=oauth('POST',`/oauth/${project}/token`,tokenHeaders,tokenForm.toString());
  const tokenBody=JSON.parse(decoder.decode(Uint8Array.fromBase64(token.body)));
  if(token.status!==200||!tokenBody.id_token||!tokenBody.access_token||!tokenBody.refresh_token)throw new Error(`token exchange failed: ${token.status}`);
  const [encodedHeader,encodedClaims,encodedSignature]=tokenBody.id_token.split('.');
  const decode64=(value)=>Uint8Array.fromBase64(value.replace(/-/g,'+').replace(/_/g,'/').padEnd(Math.ceil(value.length/4)*4,'='));
  const claims=JSON.parse(decoder.decode(decode64(encodedClaims))),header=JSON.parse(decoder.decode(decode64(encodedHeader))),jwk=jwks.keys.find(k=>k.kid===header.kid);
  const publicKey=await crypto.subtle.importKey('jwk',jwk,{name:'RSASSA-PKCS1-v1_5',hash:'SHA-256'},false,['verify']);
  const valid=await crypto.subtle.verify('RSASSA-PKCS1-v1_5',publicKey,decode64(encodedSignature),encoder.encode(`${encodedHeader}.${encodedClaims}`));
  const accessHash=new Uint8Array(await crypto.subtle.digest('SHA-256',encoder.encode(tokenBody.access_token))).slice(0,16).toBase64().replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
  if(!valid||claims.iss!==first.issuer||claims.sub!==session.data.session.user_id||claims.nonce!=='test-nonce'||claims.at_hash!==accessHash||!claims.sid||!claims.auth_time||claims.auth_time>claims.iat||!(Array.isArray(claims.aud)?claims.aud:[claims.aud]).includes(secret.ClientID))throw new Error('signed ID token binding failed');
  if(oauth('POST',`/oauth/${project}/token`,tokenHeaders,tokenForm.toString()).status===200)throw new Error('authorization code replay accepted');
  const refreshForm=new URLSearchParams({grant_type:'refresh_token',refresh_token:tokenBody.refresh_token});
  const refreshed=oauth('POST',`/oauth/${project}/token`,tokenHeaders,refreshForm.toString());
  const refreshedBody=JSON.parse(decoder.decode(Uint8Array.fromBase64(refreshed.body)));
  if(refreshed.status!==200||!refreshedBody.refresh_token||refreshedBody.refresh_token===tokenBody.refresh_token)throw new Error('refresh rotation failed');
  if(oauth('POST',`/oauth/${project}/token`,tokenHeaders,refreshForm.toString()).status===200)throw new Error('refresh replay accepted');
  refreshForm.set('refresh_token',refreshedBody.refresh_token);
  if(oauth('POST',`/oauth/${project}/token`,tokenHeaders,refreshForm.toString()).status===200)throw new Error('reused refresh family remains active');
  const userinfo=(value)=>oauth('GET',`/oauth/${project}/userinfo`,{authorization:[`Bearer ${value}`]});
  const before=userinfo(tokenBody.access_token);
  if(before.status!==200||JSON.parse(decoder.decode(Uint8Array.fromBase64(before.body))).sub!==claims.sub)throw new Error('userinfo failed');
  const revoke=(value,headers=tokenHeaders)=>oauth('POST',`/oauth/${project}/revoke`,headers,new URLSearchParams({token:value}).toString());
  const secondClient=call('mapi_oauth_admin',{...args,action:'register',document:{slug:'other',name:'Other',clients:[{slug:'web',type:'confidential',grant_types:['authorization_code'],redirect_uris:['https://other.example/callback']}]}}).Secrets[0];
  const otherCredentials=btoa(`${encodeURIComponent(secondClient.ClientID)}:${encodeURIComponent(secondClient.Secret)}`);
  const otherHeaders={authorization:[`Basic ${otherCredentials}`],'content-type':['application/x-www-form-urlencoded']};
  if(revoke(tokenBody.access_token,otherHeaders).status!==200||userinfo(tokenBody.access_token).status!==200)throw new Error('cross-client token revocation');
  failAudit=true;
  if(revoke(tokenBody.access_token).status!==500||failAudit||userinfo(tokenBody.access_token).status!==200)throw new Error('revocation audit failure did not roll back');
  if(revoke(tokenBody.access_token).status!==200||revoke(tokenBody.access_token).status!==200)throw new Error('access revocation failed');
  const denied=userinfo(tokenBody.access_token);
  if(denied.status!==401||!Object.entries(denied.headers).some(([name,values])=>name.toLowerCase()==='www-authenticate'&&values.some(value=>value.includes('invalid_token'))))throw new Error('revoked userinfo accepted');
  // Mint another grant from the same live session and revoke its refresh token.
  const again=oauth('GET',`/oauth/${project}/authorize?${query}`),handle2=new URL(again.headers.Location[0]).searchParams.get('mapi_oauth'),binding2=again.headers['Set-Cookie'][0].split(';')[0],cookie2=`${sessionCookie}; ${binding2}`;
  const page2=oauth('GET',`/oauth/continue?request=${encodeURIComponent(handle2)}`,{cookie:[cookie2]}),html2=decoder.decode(Uint8Array.fromBase64(page2.body)),csrf2=html2.match(/name="csrf" value="([^"]+)"/)?.[1];
  const complete2=oauth('POST','/oauth/continue',{cookie:[cookie2],origin:['https://issuer.example'],'content-type':['application/x-www-form-urlencoded']},new URLSearchParams({request:handle2,csrf:csrf2}).toString());
  if(complete2.status!==303)throw new Error('second continuation failed');
  const secondCode=new URL(complete2.headers.Location[0]).searchParams.get('code');
  const secondToken=oauth('POST',`/oauth/${project}/token`,tokenHeaders,new URLSearchParams({grant_type:'authorization_code',code:secondCode,redirect_uri:'https://shop.example/callback',code_verifier:verifier}).toString());
  const secondBody=JSON.parse(decoder.decode(Uint8Array.fromBase64(secondToken.body)));
  if(secondToken.status!==200||!secondBody.refresh_token)throw new Error('second grant failed');
  const postCredentials=new URLSearchParams({grant_type:'refresh_token',refresh_token:secondBody.refresh_token,client_id:secret.ClientID,client_secret:secret.Secret});
  const postRefresh=oauth('POST',`/oauth/${project}/token`,{'content-type':['application/x-www-form-urlencoded']},postCredentials.toString());
  const postBody=JSON.parse(decoder.decode(Uint8Array.fromBase64(postRefresh.body)));
  if(postRefresh.status!==200||!postBody.refresh_token)throw new Error('advertised client_secret_post authentication failed');
  if(revoke(postBody.refresh_token).status!==200||revoke(postBody.refresh_token).status!==200)throw new Error('refresh revocation failed');
  if(oauth('POST',`/oauth/${project}/token`,tokenHeaders,new URLSearchParams({grant_type:'refresh_token',refresh_token:postBody.refresh_token}).toString()).status===200)throw new Error('revoked refresh token accepted');
  if(userinfo(secondBody.access_token).status!==200)throw new Error('live second session rejected');
  const logoutParams=new URLSearchParams({id_token_hint:secondBody.id_token,client_id:secret.ClientID,post_logout_redirect_uri:logoutURI,state:'logout-state'});
  const logoutURL=`/oauth/${project}/end_session`;
  const invalidParams=new URLSearchParams(logoutParams);invalidParams.set('post_logout_redirect_uri','https://evil.example/');
  if(oauth('GET',`${logoutURL}?${invalidParams}`,{cookie:[sessionCookie]}).status!==400)throw new Error('unregistered logout redirect accepted');
  const logoutPage=oauth('GET',`${logoutURL}?${logoutParams}`,{cookie:[sessionCookie]});
  const logoutHTML=decoder.decode(Uint8Array.fromBase64(logoutPage.body)),logoutCSRF=logoutHTML.match(/name="csrf" value="([^"]+)"/)?.[1];
  if(logoutPage.status!==200||!logoutCSRF)throw new Error('logout confirmation failed');
  const logoutForm=new URLSearchParams(logoutParams);logoutForm.set('csrf',logoutCSRF);
  const logoutHeaders={cookie:[sessionCookie],origin:['https://issuer.example'],'content-type':['application/x-www-form-urlencoded']};
  if(oauth('POST',logoutURL,{...logoutHeaders,origin:['https://evil.example']},logoutForm.toString()).status!==403)throw new Error('cross-origin logout accepted');
  const badCSRF=new URLSearchParams(logoutForm);badCSRF.set('csrf','wrong');
  if(oauth('POST',logoutURL,logoutHeaders,badCSRF.toString()).status!==403)throw new Error('invalid logout CSRF accepted');
  const logout=oauth('POST',logoutURL,logoutHeaders,logoutForm.toString());
  const destination=new URL(logout.headers.Location?.[0]??'https://invalid.example/');
  if(logout.status!==303||destination.origin!=='https://shop.example'||destination.pathname!=='/signed-out'||destination.searchParams.get('from')!=='mapi'||destination.searchParams.get('state')!=='logout-state'||userinfo(secondBody.access_token).status!==401)throw new Error(`logout failed or session remains active: ${logout.status}`);
  const events=this.ctx.storage.sql.exec("SELECT event_type FROM events WHERE project_id = ?",project).toArray().map(x=>x.event_type);
  if(events.filter(e=>e==='mapi.oauth.signing_key.rotated').length!==2||!events.includes('application.created')||!events.includes('mapi.oauth.refresh.reuse')||!events.includes('mapi.oauth.code.issued')||!events.includes('auth.token.issued')||events.filter(e=>e==='mapi.oauth.logout_uri.registered').length!==1||events.filter(e=>e==='auth.token.revoked').length<2)throw new Error('transactional audit missing');
  return {ok:true,keys:jwks.keys.length,events:events.length,journey:true,memoryBytes:memory().byteLength,elapsedMs:Date.now()-start};
 }
}
export default {async fetch(request,env){try{return Response.json(await env.OAUTH_TEST.getByName('isolated').run((await request.json()).pem));}catch(error){return Response.json({ok:false,error:String(error)},{status:500});}}};
