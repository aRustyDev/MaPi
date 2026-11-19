import { DurableObject } from 'cloudflare:workers';
import wasm from '../worker/generated/egress-spike.wasm';
import { instantiateReactor } from '../worker/wasi.js';
const encoder = new TextEncoder(), decoder = new TextDecoder('utf-8', { fatal: true });
const maxBytes = 16 * 1024, timeoutMs = 1000;

// Local-only fixed literal endpoint. Arbitrary provider URLs have no transport.
function authorizedOrigin(value) {
 const u = new URL(value);
 if (u.protocol !== 'https:' || u.hostname !== '127.0.0.1' || !u.port || u.username || u.password || u.pathname !== '/' || u.search || u.hash) throw Error('endpoint denied');
 return u.origin;
}
export class EgressSpike extends DurableObject {
 constructor(ctx, env) { super(ctx, env); this.storage = ctx.storage; this.storage.sql.exec(`CREATE TABLE IF NOT EXISTS intents (id TEXT PRIMARY KEY, issuer TEXT NOT NULL, url TEXT NOT NULL, lease TEXT NOT NULL, deadline INTEGER NOT NULL, state TEXT NOT NULL, result TEXT)`); }
 #call(name, data) {
  let memory; const reactor = instantiateReactor(wasm, mem => { memory = mem; return {}; });
  const encoded = encoder.encode(JSON.stringify(data)), ptr = reactor.mapi_alloc(encoded.length); new Uint8Array(memory(), ptr, encoded.length).set(encoded);
  const raw = reactor[name](), offset = Number(raw >> 32n), length = Number(raw & 0xffffffffn); const result = JSON.parse(decoder.decode(new Uint8Array(memory(), offset, length))); reactor.mapi_release(); return result;
 }
 check(host) { return this.#call('mapi_egress_check', { host }); }
 status(id) { return this.storage.sql.exec('SELECT state, result FROM intents WHERE id = ?', id).toArray()[0] ?? null; }
 expire(id) { if (this.env.MAPI_LOCAL_TEST !== '1') throw Error('local only'); this.storage.sql.exec('UPDATE intents SET deadline = 0 WHERE id = ? AND state = ?', id, 'pending'); }
 async run(id, issuer, failStage = '') {
  if (this.env.MAPI_LOCAL_TEST !== '1' || !/^[a-z0-9-]{1,80}$/.test(id)) return { error: 'denied' };
  let origin; try { origin = authorizedOrigin(this.env.MAPI_EGRESS_ORIGIN); if (issuer !== origin) throw Error(); } catch { return { error: 'denied' }; }
  const prepared = this.#call('mapi_prepare', { issuer, allowLoopback: true });
  if (prepared.error || prepared.url !== `${origin}/.well-known/openid-configuration`) return { error: 'denied' };
  const lease = crypto.randomUUID();
  const claim = this.storage.transactionSync(() => {
   const previous = this.storage.sql.exec('SELECT * FROM intents WHERE id = ?', id).toArray()[0];
   if (previous && (previous.issuer !== issuer || previous.url !== prepared.url)) return { error: 'conflict' };
   if (previous?.state === 'done') return { done: JSON.parse(previous.result) };
   if (previous?.state === 'failed') return { error: 'failed' };
   if (previous && previous.deadline > Date.now()) return { error: 'busy' };
   const deadline = Date.now() + timeoutMs;
   this.storage.sql.exec(`INSERT INTO intents (id,issuer,url,lease,deadline,state) VALUES (?,?,?,?,?,'pending')
    ON CONFLICT(id) DO UPDATE SET lease=excluded.lease,deadline=excluded.deadline,state='pending',result=NULL`, id, issuer, prepared.url, lease, deadline);
   return { deadline };
  });
  if (claim.done || claim.error) return claim.done ?? claim;
  // Flush the intent before network dispatch and before injected eviction.
  await this.storage.sync();
  if (failStage === 'after-reserve') { this.ctx.abort('local synthetic interruption'); }
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeoutMs);
  let result, failure;
  try {
   // Exactly one operator-fixed HTTPS literal IP; no DNS lookup or redirects.
   const response = await fetch(prepared.url, { method: 'GET', redirect: 'manual', headers: { accept: 'application/json' }, signal: controller.signal });
   if (response.status >= 300 && response.status < 400) throw Error('redirect');
   const length = response.headers.get('content-length'); if (length && Number(length) > maxBytes) throw Error('oversized');
   const chunks = []; let size = 0;
   if (response.body) {
    const reader = response.body.getReader();
    for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > maxBytes) { await reader.cancel(); throw Error('oversized'); } chunks.push(value); }
   }
   const data = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.length; }
   if (failStage === 'after-network') this.ctx.abort('local synthetic interruption');
   result = { status: response.status, body: decoder.decode(data) };
  } catch (error) { failure = controller.signal.aborted ? 'timeout' : ['redirect', 'oversized'].includes(error.message) ? error.message : 'network'; }
  finally { clearTimeout(timer); }
  return this.storage.transactionSync(() => {
   const current = this.storage.sql.exec('SELECT * FROM intents WHERE id = ?', id).toArray()[0];
   if (!current || current.state !== 'pending' || current.lease !== lease) return { error: 'stale' };
   if (current.deadline < Date.now() && failure !== 'timeout') return { error: 'stale' };
   if (failure) { this.storage.sql.exec("UPDATE intents SET state='failed',result=? WHERE id=?", JSON.stringify({ error: failure }), id); return { error: failure }; }
   // Resume pinned Go in the short synchronous transaction after fetch ends.
   const resumed = this.#call('mapi_resume', { issuer, url: prepared.url, allowLoopback: true, ...result });
   if (resumed.error) { this.storage.sql.exec("UPDATE intents SET state='failed',result=? WHERE id=?", JSON.stringify({ error: 'discovery_failed' }), id); return { error: 'discovery_failed' }; }
   this.storage.sql.exec("UPDATE intents SET state='done',result=? WHERE id=?", JSON.stringify(resumed), id);
   return resumed;
  });
 }
 evict() { this.ctx.abort('local eviction'); }
}
// No production route: all control is private test-only Durable Object RPC.
export default { fetch() { return new Response(null, { status: 404 }); } };
