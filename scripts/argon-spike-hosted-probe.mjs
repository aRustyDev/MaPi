// A gated synthetic probe only. No caller-supplied credentials reach the verifier.
const enc=new TextEncoder();
function authorized(request,secret){
 if(typeof secret!=='string'||secret.length<32)return false;
 const a=enc.encode(request.headers.get('authorization')??''),b=enc.encode(`Bearer ${secret}`);
 if(a.length!==b.length)return false;let diff=0;for(let i=0;i<a.length;i++)diff|=a[i]^b[i];return diff===0;
}
export default {async fetch(request,env){
 const noStore={'cache-control':'no-store'};
 if(!authorized(request,env.ARGON_SPIKE_TEST_AUTH))return new Response(null,{status:404,headers:noStore});
 if(request.method!=='POST'||new URL(request.url).pathname!=='/probe')return new Response(null,{status:404,headers:noStore});
 if(typeof env.ARGON_SPIKE_SECRET!=='string'||env.ARGON_SPIKE_SECRET.length<32)return new Response(null,{status:503,headers:noStore});
 const password=`synthetic-${crypto.randomUUID()}-password!`;
 async function call(path,data){
  const start=Date.now();const response=await env.ARGON_VERIFIER.fetch(`https://argon.internal${path}`,{method:'POST',headers:{authorization:`Bearer ${env.ARGON_SPIKE_SECRET}`,'content-type':'application/json'},body:JSON.stringify(data)});
  if(!response.ok)throw Error('private verifier failed');const result=await response.json();return {result,elapsed:Date.now()-start};
 }
 try{
  const seeded=await call('/test-only/hash',{password});if(typeof seeded.result.hash!=='string')throw Error('synthetic setup failed');
  const wrong=await call('/verify',{password:'synthetic-wrong-password',hash:seeded.result.hash});if(wrong.result.verified!==false)throw Error('wrong password accepted');
  const first=await call('/verify',{password,hash:seeded.result.hash});if(first.result.verified!==true)throw Error('correct password rejected');
  const times=[],memory=[];const started=Date.now();
  for(let i=0;i<5;i++)await Promise.all(Array.from({length:4},async()=>{const value=await call('/verify',{password,hash:seeded.result.hash});if(value.result.verified!==true)throw Error('password rejected');times.push(value.elapsed);memory.push(value.result.wasmBytes);}));
  times.sort((a,b)=>a-b);
  return Response.json({journeys:20,concurrency:4,setupWasmBytes:seeded.result.wasmBytes,firstWasmBytes:first.result.wasmBytes,burstMaxWasmBytes:Math.max(...memory),firstMs:first.elapsed,p95Ms:times[18],wallMs:Date.now()-started},{headers:noStore});
 }catch{return new Response(null,{status:503,headers:noStore});}
}};
