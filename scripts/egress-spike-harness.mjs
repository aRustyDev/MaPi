import { EgressSpike } from './egress-spike-worker.mjs';
export { EgressSpike };
// Local-only harness; this entry point must never be deployed.
export default { async fetch(request, env) {
 const u = new URL(request.url);
 if (env.MAPI_LOCAL_TEST !== '1' || !['localhost', '127.0.0.1'].includes(u.hostname) || request.headers.get('x-local-test-key') !== env.MAPI_TEST_KEY || request.method !== 'POST') return new Response(null, { status: 404 });
 const args = await request.json(); const object = env.EGRESS_SPIKE.getByName(args.object ?? 'test');
 try {
  if (u.pathname === '/run') return Response.json(await object.run(args.id, args.issuer, args.failStage ?? ''));
  if (u.pathname === '/status') return Response.json(await object.status(args.id));
  if (u.pathname === '/expire') { await object.expire(args.id); return Response.json({ ok: true }); }
  if (u.pathname === '/check') return Response.json(await object.check(args.host));
  if (u.pathname === '/evict') { await object.evict(); return Response.json({ ok: true }); }
 } catch { return new Response(null, { status: 500 }); }
 return new Response(null, { status: 404 });
}};
