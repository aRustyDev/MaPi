// Synthetic mechanism probe only. The owner, fence, and checkpoints below are
// intentionally simplified; they are not the application relocation protocol.
// This test establishes no Go/Wasm, destination, peak-memory, or cutover guarantee.
import { DurableObject } from 'cloudflare:workers';
import { createTextPreflightMarker, invalidateTextPreflightMarker, readTextPreflightMarker } from '../worker/relocation-text-marker.js';

const check = (condition, message) => { if (!condition) throw Error(message); };
const token = '1234567890abcdef1234567890abcdef';
const partSize = 65536;
const toHex = value => [...new Uint8Array(value)].map(x => x.toString(16).padStart(2, '0')).join('');
export class Source extends DurableObject {
  #held = false; #release = null;
  constructor(ctx, env) {
    super(ctx, env);
    const s = ctx.storage.sql;
    s.exec('CREATE TABLE IF NOT EXISTS data (id INTEGER PRIMARY KEY, value TEXT NOT NULL)');
    s.exec("CREATE TABLE IF NOT EXISTS fence (id INTEGER PRIMARY KEY, phase TEXT NOT NULL)");
    s.exec("INSERT OR IGNORE INTO fence VALUES (1, 'active')");
    s.exec('CREATE TABLE IF NOT EXISTS progress (id INTEGER PRIMARY KEY, token TEXT NOT NULL, next_offset INTEGER NOT NULL, total INTEGER NOT NULL)');
    s.exec('CREATE TABLE IF NOT EXISTS pieces (offset INTEGER PRIMARY KEY, bytes BLOB NOT NULL, digest TEXT)');
  }
  seed(size) {
    return this.ctx.storage.transactionSync(() => {
      const s = this.ctx.storage.sql;
      s.exec('INSERT INTO data VALUES (1, ?)', 'x'.repeat(size - 3) + '\u0000é');
      createTextPreflightMarker(this.ctx.storage, token);
      s.exec('INSERT INTO progress VALUES (1, ?, 0, ?)', token, size);
    });
  }
  seedMalformed() {
    return this.ctx.storage.transactionSync(() => {
      const s = this.ctx.storage.sql;
      s.exec("INSERT INTO data VALUES (1, CAST(X'80FF00' AS TEXT))");
      createTextPreflightMarker(this.ctx.storage, token);
      s.exec('INSERT INTO progress VALUES (1, ?, 0, 3)', token);
    });
  }
  state() {
    const s = this.ctx.storage.sql;
    return { marker: readTextPreflightMarker(this.ctx.storage), phase: s.exec('SELECT phase FROM fence WHERE id=1').one().phase, progress: s.exec('SELECT * FROM progress WHERE id=1').one(), parts: s.exec('SELECT count(*) AS n FROM pieces').one().n, pending: s.exec('SELECT count(*) AS n FROM pieces WHERE digest IS NULL').one().n, size: s.exec('SELECT octet_length(value) AS n FROM data WHERE id=1').one().n };
  }
  async advance(hold = false) {
    const part = this.ctx.storage.transactionSync(() => {
      const s = this.ctx.storage.sql;
      const p = s.exec('SELECT * FROM progress WHERE id=1').one();
      check(readTextPreflightMarker(this.ctx.storage) === p.token, 'stale reservation');
      check(s.exec('SELECT phase FROM fence WHERE id=1').one().phase === 'active', 'source fenced');
      const pending = s.exec('SELECT offset, bytes FROM pieces WHERE digest IS NULL LIMIT 1').toArray()[0];
      if (pending) { check(pending.offset === p.next_offset, 'pending offset mismatch'); return pending; }
      check(p.next_offset < p.total, 'exhausted');
      const bytes = s.exec('SELECT substr(CAST(value AS BLOB), ?, ?) AS bytes FROM data WHERE id=1', p.next_offset + 1, Math.min(partSize, p.total - p.next_offset)).one().bytes;
      check(bytes.byteLength > 0, 'missing bytes');
      s.exec('INSERT INTO pieces VALUES (?, ?, NULL)', p.next_offset, bytes);
      return { offset: p.next_offset, bytes };
    });
    if (hold) { this.#held = true; await new Promise(resolve => { this.#release = resolve; }); this.#held = false; }
    const hash = toHex(await crypto.subtle.digest('SHA-256', part.bytes));
    return this.ctx.storage.transactionSync(() => {
      const s = this.ctx.storage.sql, p = s.exec('SELECT * FROM progress WHERE id=1').one();
      check(readTextPreflightMarker(this.ctx.storage) === p.token, 'stale finalization');
      check(s.exec('SELECT phase FROM fence WHERE id=1').one().phase === 'active', 'source fenced');
      check(p.next_offset === part.offset, 'offset changed');
      const row = s.exec('SELECT offset, bytes, digest FROM pieces WHERE offset=?', part.offset).one();
      check(row.digest === null && row.bytes.byteLength === part.bytes.byteLength && toHex(row.bytes) === toHex(part.bytes), 'reserved bytes changed');
      s.exec('UPDATE pieces SET digest=? WHERE offset=?', hash, part.offset);
      s.exec('UPDATE progress SET next_offset=? WHERE id=1', part.offset + part.bytes.byteLength);
      return { next: part.offset + part.bytes.byteLength, total: p.total, hash };
    });
  }
  held() { return this.#held; }
  release() { if (!this.#release) throw Error('not held'); this.#release(); this.#release = null; }
  mutate() { return this.ctx.storage.transactionSync(() => { invalidateTextPreflightMarker(this.ctx.storage); this.ctx.storage.sql.exec("UPDATE data SET value = 'changed' WHERE id=1"); }); }
  // Negative control: simulate a writer outside the application protocol. This
  // bypass exists only in this isolated toy and deliberately does not alter
  // the marker, illustrating why writer drain must be independently enforced.
  mutateWithoutInvalidating(size) {
    return this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec('UPDATE data SET value = ? WHERE id = 1', 'y'.repeat(size - 3) + '\u0000é');
    });
  }
  freeze() {
    return this.ctx.storage.transactionSync(() => {
      const s = this.ctx.storage.sql, p = s.exec('SELECT * FROM progress WHERE id=1').one();
      check(readTextPreflightMarker(this.ctx.storage) === p.token, 'stale freeze');
      check(s.exec('SELECT phase FROM fence WHERE id=1').one().phase === 'active', 'wrong phase');
      check(p.next_offset === p.total && !s.exec('SELECT 1 FROM pieces WHERE digest IS NULL LIMIT 1').toArray().length, 'incomplete staging');
      s.exec("UPDATE fence SET phase='frozen' WHERE id=1");
      return true;
    });
  }
  partHex(offset) { return toHex(this.ctx.storage.sql.exec('SELECT bytes FROM pieces WHERE offset=?', offset).one().bytes); }
  partMatches(offset, byte) {
    const expected = new Uint8Array(partSize).fill(byte).buffer;
    return this.ctx.storage.sql.exec('SELECT bytes = ? AS matches FROM pieces WHERE offset = ?', expected, offset).one().matches === 1;
  }
  currentPartMatches(offset, byte) {
    const expected = new Uint8Array(partSize).fill(byte).buffer;
    return this.ctx.storage.sql.exec('SELECT substr(CAST(value AS BLOB), ?, ?) = ? AS matches FROM data WHERE id = 1', offset + 1, partSize, expected).one().matches === 1;
  }
  evict() { this.ctx.abort('synthetic eviction'); }
}
const reject = async (p, message) => { try { await p; } catch (e) { check(String(e).includes(message), `unexpected rejection: ${e}`); return; } throw Error(`expected rejection: ${message}`); };
export default { async fetch(request, env) {
 try {
  if (env.MAPI_LOCAL_TEST !== '1' || new URL(request.url).hostname !== '127.0.0.1') return new Response('Not found', {status: 404});
  const supplied = request.headers.get('authorization') ?? '';
  const expected = `Bearer ${env.TEST_TOKEN ?? ''}`;
  if (!env.TEST_TOKEN || supplied.length !== expected.length) return new Response('Unauthorized', {status: 401});
  let mismatch = 0; for (let i=0; i<expected.length; i++) mismatch |= expected.charCodeAt(i) ^ supplied.charCodeAt(i);
  if (mismatch) return new Response('Unauthorized', {status: 401});
  const name = crypto.randomUUID(); let source = env.SOURCE.getByName(name);
  await source.seed(8_300_000);
  const first = await source.advance(); check(first.next === partSize, 'first page');
  try { await source.evict(); } catch {} source = env.SOURCE.getByName(name);
  let state = await source.state(); check(state.progress.next_offset === partSize && state.parts === 1, 'durable checkpoint lost');
  while (state.progress.next_offset < state.progress.total) { await source.advance(); state = await source.state(); }
  check(state.phase === 'active' && state.marker === token && state.size === 8_300_000 && state.pending === 0, 'source changed before freeze');
  check(await source.freeze(), 'freeze failed'); check((await source.state()).phase === 'frozen', 'freeze not durable');
  const pendingName = crypto.randomUUID(); let pendingOwner = env.SOURCE.getByName(pendingName);
  await pendingOwner.seed(64);
  const interrupted = pendingOwner.advance(true).then(() => false, () => true);
  for (let i=0; i<100 && !await pendingOwner.held(); i++) await new Promise(resolve => setTimeout(resolve, 1));
  check(await pendingOwner.held(), 'pending reservation not held');
  try { await pendingOwner.evict(); } catch {}
  check(await interrupted, 'eviction did not interrupt reservation');
  pendingOwner = env.SOURCE.getByName(pendingName);
  const pendingBefore = await pendingOwner.state();
  check(pendingBefore.progress.next_offset === 0 && pendingBefore.pending === 1 && pendingBefore.phase === 'active', 'pending reservation lost on eviction');
  await pendingOwner.advance();
  const pendingAfter = await pendingOwner.state();
  check(pendingAfter.progress.next_offset === 64 && pendingAfter.pending === 0 && pendingAfter.phase === 'active', 'pending reservation did not resume');
  const name2 = crypto.randomUUID(); const stale = env.SOURCE.getByName(name2); await stale.seed(64);
  const inFlight = stale.advance(true);
  for (let i=0; i<100 && !await stale.held(); i++) await new Promise(resolve => setTimeout(resolve, 1));
  check(await stale.held(), 'reservation not held'); await stale.mutate(); await stale.release();
  await reject(inFlight, 'stale finalization');
  const staleState = await stale.state(); check(staleState.phase === 'active' && staleState.marker === null && staleState.progress.next_offset === 0 && staleState.size === 7 && staleState.pending === 1, 'mutation or pending reservation changed');
  await reject(stale.freeze(), 'stale freeze');
  const fullyStale = env.SOURCE.getByName(crypto.randomUUID()); await fullyStale.seed(64); await fullyStale.advance();
  await fullyStale.mutate(); await reject(fullyStale.freeze(), 'stale freeze');
  const fullyStaleState = await fullyStale.state();
  check(fullyStaleState.phase === 'active' && fullyStaleState.progress.next_offset === 64 && fullyStaleState.size === 7, 'completed stale snapshot changed source');
  // An out-of-band write of the same byte length is invisible to the marker.
  // The toy mechanism then accepts pages from different source versions; this
  // negative control must not be interpreted as a safe production snapshot.
  const mixed = env.SOURCE.getByName(crypto.randomUUID()), mixedSize = 2 * partSize + 3;
  await mixed.seed(mixedSize);
  await mixed.advance();
  await mixed.mutateWithoutInvalidating(mixedSize);
  check((await mixed.state()).marker === token, 'negative control unexpectedly invalidated marker');
  while ((await mixed.state()).progress.next_offset < mixedSize) await mixed.advance();
  check(await mixed.partMatches(0, 0x78), 'first page did not retain the original value');
  check(await mixed.partMatches(partSize, 0x79), 'later page did not read the changed value');
  check(await mixed.currentPartMatches(0, 0x79) && await mixed.currentPartMatches(partSize, 0x79), 'current source does not match the changed version');
  check(await mixed.freeze(), 'negative control did not demonstrate marker-only acceptance');
  check((await mixed.state()).phase === 'frozen', 'negative control did not preserve the toy frozen state');
  const malformed = env.SOURCE.getByName(crypto.randomUUID()); await malformed.seedMalformed(); await malformed.advance();
  check(await malformed.partHex(0) === '80ff00', 'malformed bytes changed');
  return Response.json({ok:true,nearLimitBytes:8300000,pages:state.parts,eviction:true,pendingReservationResume:true,staleFinalization:true,atomicFreeze:true,uncoordinatedWriterMixAccepted:true,malformedBytesPreserved:true});
 } catch(e) { return Response.json({ok:false,error:String(e),stack:e.stack},{status:500}); }
}};
