// Synthetic owner: this tests an authenticated private service binding only.
export default {async fetch(request,env){
 if(request.headers.get('authorization')!==`Bearer ${env.ARGON_SPIKE_TEST_AUTH}`)return new Response(null,{status:401});
 const path=new URL(request.url).pathname;if(!['/verify','/test-only/hash'].includes(path)||request.method!=='POST')return new Response(null,{status:404});
 return env.ARGON_VERIFIER.fetch(`https://argon.internal${path}`,{method:'POST',headers:{authorization:`Bearer ${env.ARGON_SPIKE_SECRET}`,'content-type':'application/json'},body:request.body,duplex:'half'});
}};
