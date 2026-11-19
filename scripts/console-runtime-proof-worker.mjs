import app, { NextgenApplication, ProjectRegistry } from '../worker/generated/console-runtime-object.js';
export { NextgenApplication, ProjectRegistry };
const noStore={'cache-control':'no-store'};
export default { async fetch(request,env,ctx) {
 const url=new URL(request.url);
 if(env.MAPI_LOCAL_TEST!=='1'||!['localhost','127.0.0.1','[::1]'].includes(url.hostname))return new Response(null,{status:404,headers:noStore});
 if(!['/console/runtime.json','/__test/project-token','/__test/users/query','/__test/owner-fence'].includes(url.pathname))return app.fetch(request,env,ctx);
 if(url.pathname==='/console/runtime.json'&&!['GET','HEAD'].includes(request.method))return new Response(null,{status:405,headers:{...noStore,allow:'GET, HEAD'}});
 const origin=request.headers.get('origin');if(origin&&origin!==url.origin)return new Response(null,{status:403,headers:noStore});
 const route=await env.PROJECT_REGISTRY.getByName('projects').resolve(url.origin);
 if(!route || route.state!=='active'||route.origin!==url.origin||!route.project_id)return new Response(null,{status:503,headers:noStore});
 const object=env.NEXTGEN_APPLICATION.getByName(route.object_name),owner={projectId:route.project_id,origin:route.origin};
 if(url.pathname==='/console/runtime.json') {
  try{const data=await object.consoleRuntimeProbe(owner);return new Response(request.method==='HEAD'?null:JSON.stringify(data),{headers:{...noStore,'content-type':'application/json'}});}catch{return new Response(null,{status:503,headers:noStore});}
 }
 if(request.method!=='POST'||request.headers.get('authorization')!==`Bearer ${env.MAPI_OPERATOR_TOKEN}`||!env.MAPI_OPERATOR_TOKEN)return new Response(null,{status:404,headers:noStore});
 if(url.pathname==='/__test/owner-fence') {
  const body=await request.json();try{await object.consoleRuntimeProbe({projectId:body.projectId,origin:body.origin});return new Response(null,{status:204,headers:noStore});}catch{return new Response(null,{status:503,headers:noStore});}
 }
 if(url.pathname==='/__test/project-token') {
  try{return Response.json({token:await object.consoleTestProjectToken(owner)},{headers:noStore});}catch{return new Response(null,{status:503,headers:noStore});}
 }
 const authorization=request.headers.get('x-test-token');if(!authorization)return new Response(null,{status:400,headers:noStore});
 const output=await object.handleRequest({method:'POST',url:`${route.origin}/users/query?project_id=${encodeURIComponent(route.project_id)}`,headers:{authorization:[`Bearer ${authorization}`],'content-type':['application/json'],accept:['application/json']},body:new TextEncoder().encode('{}').toBase64(),peer:'127.0.0.1'});
 return new Response(output.body?Uint8Array.fromBase64(output.body):null,{status:output.status,headers:{...noStore,'content-type':'application/json'}});
}};
