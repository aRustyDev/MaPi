import { DurableObject } from 'cloudflare:workers';
import { initializeProjectFence, assertProjectWritable, freezeProject, activateProject, retireProject, initializeRouteGeneration, registerRouteGeneration, readRouteGeneration, beginRelocation, commitRelocation, projectFenceStatus } from '../worker/relocation.js';
import { beginChunkExport, exportChunk, beginChunkImport, importChunk, chunkExportStatus, chunkImportStatus } from '../worker/relocation-chunks.js';
import { execute } from '../worker/sql.js';
const tables = ['users', 'sessions', 'events'];
const check = (v, text) => { if (!v) throw Error(text); };
const rejects = async (fn, text) => { try { await fn(); } catch { return; } throw Error(text); };
const hash = async text => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))].map(b => b.toString(16).padStart(2, '0')).join('');
export class ChunkProject extends DurableObject {
 constructor(ctx, env) { super(ctx, env); this.s = ctx.storage; this.s.sql.exec('CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, precise INTEGER, data BLOB)'); this.s.sql.exec('CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, user_id TEXT REFERENCES users(id))'); this.s.sql.exec('CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, user_id TEXT REFERENCES users(id), kind TEXT)'); }
 init(id, name) { initializeProjectFence(this.s, id, name); }
 seed(id) { this.s.transactionSync(() => { assertProjectWritable(this.s, id, 1); for (let i = 0; i < 12; i++) { const key = `u${String(i).padStart(2, '0')}`; const data = new Uint8Array(80_000); data.fill(i); this.s.sql.exec(`INSERT INTO users VALUES (?, ${i % 2 ? '-9223372036854775808' : '9223372036854775807'}, ?)`, key, data.buffer); this.s.sql.exec('INSERT INTO sessions VALUES (?, ?)', `s${i}`, key); this.s.sql.exec('INSERT INTO events VALUES (?, ?, ?)', `e${i}`, key, 'created'); } }); }
 oversized(id) { this.s.transactionSync(() => { assertProjectWritable(this.s, id, 1); this.s.sql.exec("INSERT INTO users VALUES ('large', 0, ?)", new Uint8Array(120_000).buffer); }); }
 write(id, gen) { this.s.transactionSync(() => { assertProjectWritable(this.s, id, gen); this.s.sql.exec("INSERT INTO users VALUES ('later', 0, X'01')"); }); }
 freeze(id, gen, move) { freezeProject(this.s, id, gen, move); }
 beginExport(id, gen, move, order = tables) { beginChunkExport(this.s, id, gen, move, order); }
 chunk(id, gen, move, n, fail) { return exportChunk(this.s, id, gen, move, n, fail); }
 beginImport(id, gen, move, dest, order = tables) { beginChunkImport(this.s, id, gen, move, dest, order); }
 receive(id, env, fail) { return importChunk(this.s, id, env, fail); }
 exportStatus(id) { return chunkExportStatus(this.s, id); }
 importStatus(id) { return chunkImportStatus(this.s, id); }
 status(id) { return projectFenceStatus(this.s, id); }
 activate(id, gen, move, route) { activateProject(this.s, id, gen, move, route); }
 retire(id, gen, move, route) { retireProject(this.s, id, gen, move, route); }
 evidence() { return { users: execute(this.s, { statement: 'SELECT id, precise, data FROM users ORDER BY id', args: [], query: true }).rows, sessions: this.s.sql.exec('SELECT COUNT(*) AS n FROM sessions').one().n, events: this.s.sql.exec('SELECT COUNT(*) AS n FROM events').one().n, fks: this.s.sql.exec('PRAGMA foreign_key_check').toArray() }; }
 evict() { this.ctx.abort('eviction test'); }
}
export class ChunkRegistry extends DurableObject {
 constructor(ctx, env) { super(ctx, env); this.s = ctx.storage; this.s.sql.exec('CREATE TABLE IF NOT EXISTS project_routes (project_id TEXT PRIMARY KEY, origin TEXT NOT NULL, object_name TEXT NOT NULL UNIQUE, state TEXT NOT NULL)'); initializeRouteGeneration(this.s); }
 register(id, name) { const origin = `https://${id}.test`; this.s.sql.exec("INSERT INTO project_routes VALUES (?, ?, ?, 'active')", id, origin, name); registerRouteGeneration(this.s, id, origin, name); }
 begin(id, source, target, generation, move) { return beginRelocation(this.s, id, source, target, generation, move); }
 commit(id, gen, move, frozen, staged) { return commitRelocation(this.s, id, gen, move, frozen, staged); }
 route(id) { return readRouteGeneration(this.s, id); }
}
export default { async fetch(request, env) {
 try {
  const n = crypto.randomUUID(), a = `source-${n}`, b = `destination-${n}`, r = `registry-${n}`; let source = env.PROJECT.getByName(a), target = env.PROJECT.getByName(b); const registry = env.REGISTRY.getByName(r);
  await source.init('p', a); await source.seed('p'); await registry.register('p', a); await registry.begin('p', a, b, 1, 'move'); await source.freeze('p', 1, 'move');
  await rejects(() => source.write('p', 1), 'frozen source writable'); await source.beginExport('p', 1, 'move'); await target.beginImport('p', 1, 'move', b); await target.beginImport('p', 1, 'move', b);
  await rejects(() => source.chunk('p', 1, 'move', 2, false), 'out-of-order export accepted');
  await rejects(() => source.chunk('p', 1, 'move', 0, true), 'export interruption did not occur'); check((await source.exportStatus('p')).next_chunk === 0, 'export cursor advanced before hash');
  await rejects(() => source.evict(), 'source eviction must abort'); source = env.PROJECT.getByName(a);
  let total = 0, nChunks = 0, first;
  for (;;) {
   const part = await source.chunk('p', 1, 'move', nChunks, false); total += new TextEncoder().encode(part.content).length; const payload = JSON.parse(part.content);
   if (nChunks === 0) {
    first = part; await rejects(() => target.receive('p', { ...part, content: part.content + ' ' }, 0), 'tampered chunk accepted');
    const future = await source.chunk('p', 1, 'move', 1, false); await rejects(() => target.receive('p', future, 0), 'out-of-order import accepted');
    await rejects(() => target.receive('p', part, 1), 'import interruption did not occur'); check((await target.importStatus('p')).next_chunk === 0, 'failed chunk advanced checkpoint'); check((await target.evidence()).users.length === 0, 'failed chunk persisted rows');
   }
   await target.receive('p', part, 0); await target.receive('p', part, 0);
   if (nChunks === 0) { const altered = part.content + ' '; await rejects(async () => target.receive('p', { content: altered, digest: await hash(altered) }, 0), 'conflicting replay accepted'); }
   nChunks++;
   if (nChunks === 4) {
    await rejects(() => target.write('p', 2), 'partially imported destination writable');
    await rejects(() => target.evict(), 'target eviction must abort'); target = env.PROJECT.getByName(b);
    await rejects(() => source.evict(), 'source eviction must abort'); source = env.PROJECT.getByName(a);
    check((await target.importStatus('p')).next_chunk === nChunks && (await source.exportStatus('p')).next_chunk === nChunks, 'chunk checkpoints lost after eviction');
    await target.receive('p', first, 0);
   }
   if (payload.done) break;
   if (nChunks > 100) throw Error('Too many chunks');
  }
  check(total > 512 * 1024 && nChunks > 4, 'fixture did not exceed previous limit');
  const frozen = await source.status('p'), staged = await target.status('p'); check(staged.state === 'staged' && staged.digest === frozen.digest, 'final digest mismatch');
  const evidence = await target.evidence(); check(evidence.users.length === 12 && evidence.sessions === 12 && evidence.events === 12 && !evidence.fks.length, 'missing data or invalid foreign keys');
  check(evidence.users[0][1].integer === '9223372036854775807' && evidence.users[1][1].integer === '-9223372036854775808', 'int64 changed');
  check(Uint8Array.fromBase64(evidence.users[4][2].blob).length === 80_000 && Uint8Array.fromBase64(evidence.users[4][2].blob)[0] === 4, 'blob changed');
  const huge = env.PROJECT.getByName(`huge-${n}`); await huge.init('huge', `huge-${n}`); await huge.oversized('huge'); await huge.freeze('huge', 1, 'big-move'); await huge.beginExport('huge', 1, 'big-move'); await rejects(() => huge.chunk('huge', 1, 'big-move', 0, false), 'oversized row accepted'); check((await huge.exportStatus('huge')).next_chunk === 0, 'oversized row advanced checkpoint');
  const badSource = env.PROJECT.getByName(`bad-source-${n}`), badTarget = env.PROJECT.getByName(`bad-target-${n}`); await badSource.init('bad', `bad-source-${n}`); await badSource.seed('bad'); await badSource.freeze('bad', 1, 'bad-move');
  const reverse = ['events', 'sessions', 'users']; await badSource.beginExport('bad', 1, 'bad-move', reverse); await badTarget.beginImport('bad', 1, 'bad-move', `bad-target-${n}`, reverse);
  const invalidOrder = await badSource.chunk('bad', 1, 'bad-move', 0, false); await rejects(() => badTarget.receive('bad', invalidOrder, 0), 'foreign-key dependency violation accepted');
  check((await badTarget.importStatus('bad')).next_chunk === 0 && (await badTarget.evidence()).events === 0, 'foreign-key failure persisted rows or checkpoint');
  const route = await registry.commit('p', 1, 'move', frozen, staged); await target.activate('p', 2, 'move', route); await source.retire('p', 1, 'move', route);
  await rejects(() => source.write('p', 1), 'retired source writable'); await rejects(() => target.write('p', 1), 'stale generation accepted'); await target.write('p', 2);
  return Response.json({ ok: true, bytes: total, chunks: nChunks });
 } catch (error) { return Response.json({ ok: false, error: String(error), stack: error?.stack }, { status: 500 }); }
}};
