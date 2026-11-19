// Local test harness only. No authentication or management API is exposed.
import runtime, { NextgenApplication, ProjectRegistry } from './console-runtime-proof-worker.mjs';
import assets from './console-static-proof-worker.mjs';
export { NextgenApplication, ProjectRegistry };
const noStore={'cache-control':'no-store'};
export default {async fetch(request,env,ctx) {
 const url=new URL(request.url);
 if(env.MAPI_LOCAL_TEST!=='1'||!['localhost','127.0.0.1','[::1]'].includes(url.hostname))return new Response(null,{status:404,headers:noStore});
 if(url.pathname==='/console/runtime.json'||url.pathname==='/_mapi/admin/projects'||url.pathname==='/_mapi/admin/users')return runtime.fetch(request,env,ctx);
 if(url.pathname==='/ui/console'||url.pathname.startsWith('/ui/console/'))return assets.fetch(request,env,ctx);
 if(url.pathname!=='/api/v1/sessions/me'&&url.pathname!=='/__test/session')return new Response(null,{status:404,headers:noStore});
 if(request.headers.has('origin')&&request.headers.get('origin')!==url.origin)return new Response(null,{status:403,headers:noStore});
 const route=await env.PROJECT_REGISTRY.getByName('projects').resolve(url.origin);
 if(!route||route.state!=='active'||route.origin!==url.origin||!route.project_id)return new Response(null,{status:503,headers:noStore});
 const object=env.NEXTGEN_APPLICATION.getByName(route.object_name),owner={projectId:route.project_id,origin:route.origin};
 if(url.pathname==='/__test/session') {
  if(request.method!=='POST'||!env.MAPI_OPERATOR_TOKEN||request.headers.get('authorization')!==`Bearer ${env.MAPI_OPERATOR_TOKEN}`)return new Response(null,{status:404,headers:noStore});
  try{const {email,password}=await request.json();if(!await object.admitLogin(owner))throw Error('route');const result=await object.login(email,password,'127.0.0.1');if(result.status!==200)return new Response(null,{status:result.status,headers:noStore});return new Response(null,{status:204,headers:{...noStore,'set-cookie':result.cookie}});}catch{return new Response(null,{status:503,headers:noStore});}
 }
 if(request.method!=='GET')return new Response(null,{status:405,headers:{...noStore,allow:'GET'}});
 if(url.searchParams.getAll('project_id').length!==1||url.searchParams.get('project_id')!==route.project_id||[...url.searchParams.keys()].some(k=>k!=='project_id'))return new Response(null,{status:403,headers:noStore});
 try{const result=await object.consoleSessionProbe(owner,request.headers.get('cookie')??'');const headers=new Headers(noStore);for(const [name,values] of Object.entries(result.headers??{}))for(const value of values)headers.append(name,value);headers.set('cache-control','no-store');return new Response(result.body?Uint8Array.fromBase64(result.body):null,{status:result.status,headers});}catch{return new Response(null,{status:503,headers:noStore});}
}};
