import { DurableObject } from 'cloudflare:workers';
import { initializeProjectFence, assertProjectWritable, freezeProject, snapshotProject, stageProject, activateProject, retireProject, initializeRouteGeneration, registerRouteGeneration, readRouteGeneration, beginRelocation, commitRelocation, projectFenceStatus } from '../worker/relocation.js';
import { execute } from '../worker/sql.js';
const tables = ['users', 'sessions', 'events'];
const check = (v, message) => { if (!v) throw Error(message); };
const rejects = async (fn, message) => { try { await fn(); } catch { return; } throw Error(message); };
export class RelocationProject extends DurableObject {
  constructor(ctx, env) { super(ctx, env); this.s = ctx.storage; this.s.sql.exec('CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, precise INTEGER, data BLOB)'); this.s.sql.exec('CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, user_id TEXT REFERENCES users(id))'); this.s.sql.exec('CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, kind TEXT)'); }
  init(id, object) { initializeProjectFence(this.s, id, object); }
  seed(id) { this.s.transactionSync(() => { assertProjectWritable(this.s, id, 1); this.s.sql.exec("INSERT INTO users VALUES ('u', 9223372036854775807, X'00FF01')"); this.s.sql.exec("INSERT INTO sessions VALUES ('s', 'u')"); this.s.sql.exec("INSERT INTO events VALUES ('e', 'created')"); }); }
  big(id) { this.s.transactionSync(() => { assertProjectWritable(this.s, id, 1); this.s.sql.exec("INSERT INTO users VALUES ('large', 0, ?)", new Uint8Array(550000).buffer); }); }
  write(id, gen, event) { this.s.transactionSync(() => { assertProjectWritable(this.s, id, gen); this.s.sql.exec('INSERT INTO events VALUES (?, ?)', event, 'write'); }); }
  freeze(id, gen, move) { freezeProject(this.s, id, gen, move); }
  snapshot(id, gen, move) { return snapshotProject(this.s, id, gen, move, tables); }
  stage(snapshot, object, fail) { return stageProject(this.s, snapshot, tables, object, fail); }
  status(id) { return projectFenceStatus(this.s, id); }
  activate(id, gen, move, route) { activateProject(this.s, id, gen, move, route); }
  retire(id, gen, move, route) { retireProject(this.s, id, gen, move, route); }
  rows() { return tables.map((table) => execute(this.s, { statement: `SELECT * FROM ${table}`, args: [], query: true }).rows); }
  evict() { this.ctx.abort('eviction test'); }
}
export class RelocationRegistry extends DurableObject {
  constructor(ctx, env) { super(ctx, env); this.s = ctx.storage; this.s.sql.exec('CREATE TABLE IF NOT EXISTS project_routes (project_id TEXT PRIMARY KEY, origin TEXT NOT NULL, object_name TEXT NOT NULL UNIQUE, state TEXT NOT NULL)'); initializeRouteGeneration(this.s); }
  register(id, object) { const origin = `https://${id}.test`; this.s.sql.exec("INSERT OR IGNORE INTO project_routes VALUES (?, ?, ?, 'active')", id, origin, object); registerRouteGeneration(this.s, id, origin, object); }
  begin(id, source, dest, gen, move) { return beginRelocation(this.s, id, source, dest, gen, move); }
  commit(id, gen, move, frozen, staged) { return commitRelocation(this.s, id, gen, move, frozen, staged); }
  route(id) { return readRouteGeneration(this.s, id); }
  target(id) { return this.s.sql.exec('SELECT object_name FROM project_routes WHERE project_id = ?', id).one().object_name; }
  evict() { this.ctx.abort('eviction test'); }
}
export default { async fetch(request, env) {
  try {
    const n = crypto.randomUUID(); const a = `a-${n}`, d = `d-${n}`, b = `b-${n}`, big = `big-${n}`;
    const source = env.PROJECT.get(env.PROJECT.idFromName(a)); const target = env.PROJECT.get(env.PROJECT.idFromName(d)); const other = env.PROJECT.get(env.PROJECT.idFromName(b)); const huge = env.PROJECT.get(env.PROJECT.idFromName(big)); const registry = env.REGISTRY.get(env.REGISTRY.idFromName(n));
    await source.init('p', a); await other.init('other', b); await huge.init('large', big); await source.seed('p'); await registry.register('p', a);
    await registry.register('race', `race-${n}`); const contenders = await Promise.allSettled([registry.begin('race', `race-${n}`, `dest1-${n}`, 1, 'move1'), registry.begin('race', `race-${n}`, `dest2-${n}`, 1, 'move2')]); check(contenders.filter((r) => r.status === 'fulfilled').length === 1, 'competing moves both won');
    const move = await registry.begin('p', a, d, 1, 'move'); await registry.begin('p', a, d, 1, 'move');
    await rejects(() => registry.begin('p', a, b, 1, 'conflict'), 'conflicting relocation accepted');
    await source.freeze('p', 1, 'move'); await source.freeze('p', 1, 'move'); await rejects(() => source.write('p', 1, 'stale'), 'fenced write succeeded'); await other.write('other', 1, 'other-write');
    const snapshot = await source.snapshot('p', 1, 'move'); check((await source.snapshot('p', 1, 'move')).digest === snapshot.digest, 'snapshot retry changed');
    await rejects(() => target.stage(snapshot, d, 1), 'injected import did not fail'); check((await target.rows()).every((rows) => rows.length === 0), 'failed import persisted rows'); check(await target.status('p') === null, 'failed import persisted checkpoint');
    await rejects(() => target.stage({ ...snapshot, content: snapshot.content + ' ' }, d, 0), 'bad digest accepted'); await target.stage(snapshot, d, 0); await target.stage(snapshot, d, 0);
    await rejects(() => target.activate('p', 2, 'move', move), 'premature activation');
    const frozen = await source.status('p'), staged = await target.status('p'); await rejects(() => registry.commit('p', 1, 'move', frozen, { ...staged, object_name: 'wrong' }), 'wrong destination accepted');
    const route = await registry.commit('p', 1, 'move', frozen, staged); check(await registry.target('p') === d && route.generation === 2, 'registry cutover failed'); await registry.commit('p', 1, 'move', frozen, staged);
    await rejects(() => target.write('p', 2, 'premature'), 'staged destination writable'); await target.activate('p', 2, 'move', route); await target.activate('p', 2, 'move', route); await source.retire('p', 1, 'move', route); await source.retire('p', 1, 'move', route);
    await rejects(() => source.write('p', 1, 'old-owner'), 'retired source writable'); await rejects(() => target.write('p', 1, 'old-generation'), 'stale destination generation accepted'); await target.write('p', 2, 'after');
    const rows = await target.rows(); check(rows[0][0][1].integer === '9223372036854775807' && rows[0][0][2].blob === 'AP8B' && rows[1].length === 1 && rows[2].length === 2, 'relocation lost data');
    await rejects(() => registry.begin('p', a, b, 1, 'stale-move'), 'stale move accepted');
    const d2 = `d2-${n}`, target2 = env.PROJECT.get(env.PROJECT.idFromName(d2)); await registry.begin('p', d, d2, 2, 'move2'); await target.freeze('p', 2, 'move2'); const snapshot2 = await target.snapshot('p', 2, 'move2'); await target2.stage(snapshot2, d2, 0); const route2 = await registry.commit('p', 2, 'move2', await target.status('p'), await target2.status('p')); await target2.activate('p', 3, 'move2', route2); await target.retire('p', 2, 'move2', route2); await rejects(() => target.activate('p', 2, 'move', route), 'late activation revived previous owner');
    await huge.big('large'); await huge.freeze('large', 1, 'big-move'); await rejects(() => huge.snapshot('large', 1, 'big-move'), 'oversized snapshot accepted');
    await rejects(() => target2.evict(), 'eviction should abort'); await rejects(() => registry.evict(), 'eviction should abort'); const revivedTarget = env.PROJECT.get(env.PROJECT.idFromName(d2)); const revivedRegistry = env.REGISTRY.get(env.REGISTRY.idFromName(n)); check((await revivedTarget.status('p')).state === 'active' && (await revivedRegistry.route('p')).generation === 3, 'checkpoint lost after eviction');
    return Response.json({ ok: true });
  } catch (error) { return Response.json({ ok: false, error: String(error), stack: error?.stack }, { status: 500 }); }
}};
