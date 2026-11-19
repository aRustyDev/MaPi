// Test-only static proof. No application, auth, or management routes are served.
import policy from '../worker/generated/console-policy.json';

const prefix='/ui/console';
function headers(response, cache) {
  const h=new Headers(response.headers);
  h.set('Content-Security-Policy',policy.enforced);
  h.set('Content-Security-Policy-Report-Only',policy.report);
  h.set('X-Content-Type-Options','nosniff');
  h.set('X-Frame-Options','DENY');
  h.set('Referrer-Policy','strict-origin-when-cross-origin');
  h.set('Permissions-Policy','camera=(), microphone=(), geolocation=()');
  if(cache)h.set('Cache-Control',cache);
  return new Response(response.body,{status:response.status,statusText:response.statusText,headers:h});
}
export default {async fetch(request,env) {
  const url=new URL(request.url);
  if(url.pathname==='/console/runtime.json') {
    if(request.method!=='GET'&&request.method!=='HEAD')return new Response(null,{status:405,headers:{Allow:'GET, HEAD'}});
    const h={'Content-Type':'application/json','Cache-Control':'no-store'};
    if(url.searchParams.get('test')==='unavailable')return new Response(request.method==='HEAD'?null:'synthetic outage',{status:500,headers:h});
    return new Response(request.method==='HEAD'?null:JSON.stringify({mode:'standalone'}),{headers:h});
  }
  if(url.pathname===prefix)return Response.redirect(new URL(prefix+'/',url),308);
  if(!url.pathname.startsWith(prefix+'/')||!['GET','HEAD'].includes(request.method))return new Response('Not Found',{status:404});
  let relative;
  try { relative=decodeURIComponent(url.pathname.slice(prefix.length+1)); } catch { return new Response('Bad Request',{status:400}); }
  // Resolve path segments like path.Clean, but never escape the asset root.
  const parts=[];for(const part of relative.split('/')){if(!part||part==='.')continue;if(part==='..')parts.pop();else parts.push(part);}
  relative=parts.join('/');
  const assetURL=new URL('/'+(relative||'index.html'),url);
  let response=await env.ASSETS.fetch(new Request(assetURL,{method:request.method}));
  let fallback=false;
  if(response.status===404&&!relative.startsWith('assets/')){fallback=true;response=await env.ASSETS.fetch(new Request(new URL('/index.html',url),{method:request.method}));}
  const cache=response.status===200 ? (relative.startsWith('assets/')?'public, max-age=31536000, immutable':(!relative||relative.endsWith('/index.html')||relative==='index.html'||fallback?'no-store':undefined)) : undefined;
  return headers(response,cache);
}};
