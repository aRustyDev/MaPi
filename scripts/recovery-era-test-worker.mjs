// Local proof only. These classes are not bound to an application deployment.
import { DurableObject } from 'cloudflare:workers';

const check = (value, message) => { if (!value) throw new Error(message); };
const rejects = async (fn, message) => { try { await fn(); } catch { return; } throw new Error(message); };

export class RecoveryRegistry extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS route (id TEXT PRIMARY KEY, era TEXT NOT NULL, state TEXT NOT NULL)');
  }
  init() {
    this.ctx.storage.sql.exec("INSERT OR IGNORE INTO route VALUES ('p', ?, 'active')", crypto.randomUUID());
    return this.read();
  }
  read() { return this.ctx.storage.sql.exec("SELECT * FROM route WHERE id = 'p'").one(); }
  begin(expected) {
    return this.ctx.storage.transactionSync(() => {
      const previous = this.read();
      if (previous.state !== 'active' || previous.era !== expected) throw new Error('Stale recovery');
      const era = crypto.randomUUID();
      this.ctx.storage.sql.exec("UPDATE route SET era = ?, state = 'recovering' WHERE id = 'p'", era);
      return this.read();
    });
  }
  activate(era) {
    this.ctx.storage.transactionSync(() => {
      const current = this.read();
      if (current.state !== 'recovering' || current.era !== era) throw new Error('Stale activation');
      this.ctx.storage.sql.exec("UPDATE route SET state = 'active' WHERE id = 'p'");
    });
  }
}

export class RecoveryProject extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.s = ctx.storage;
    this.s.sql.exec('CREATE TABLE IF NOT EXISTS owner (id TEXT PRIMARY KEY, era TEXT NOT NULL, state TEXT NOT NULL, revision INTEGER NOT NULL)');
    this.s.sql.exec('CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY)');
    this.s.sql.exec('CREATE TABLE IF NOT EXISTS handoffs (id TEXT PRIMARY KEY)');
    this.s.sql.exec('CREATE TABLE IF NOT EXISTS commits (id TEXT PRIMARY KEY)');
    this.pending = new Map();
  }
  registry() { return this.env.REGISTRY.getByName('control'); }
  state() { return this.s.sql.exec("SELECT * FROM owner WHERE id = 'p'").one(); }
  async init() {
    const route = await this.registry().read();
    check(route.state === 'active', 'Registry not active');
    this.s.transactionSync(() => {
      this.s.sql.exec("INSERT OR IGNORE INTO owner VALUES ('p', ?, 'active', 0)", route.era);
      this.s.sql.exec("INSERT OR IGNORE INTO sessions VALUES ('old-session')");
      this.s.sql.exec("INSERT OR IGNORE INTO handoffs VALUES ('old-handoff')");
    });
  }
  async admit(era) {
    const route = await this.registry().read();
    const owner = this.state();
    check(route.state === 'active' && route.era === era && owner.state === 'active' && owner.era === era, 'Fenced');
    return owner;
  }
  async startVerification(era, id) {
    const snapshot = await this.admit(era);
    await new Promise((resolve) => this.pending.set(id, resolve));
    await this.admit(era);
    this.s.transactionSync(() => {
      const current = this.state();
      check(current.state === 'active' && current.era === era && current.revision === snapshot.revision, 'Stale verification');
      this.s.sql.exec('INSERT INTO commits VALUES (?)', id);
    });
  }
  waiting(id) { return this.pending.has(id); }
  release(id) { const finish = this.pending.get(id); if (!finish) throw new Error('No pending job'); this.pending.delete(id); finish(); }
  freeze(era) {
    this.s.transactionSync(() => {
      const current = this.state();
      check(current.era === era && current.state === 'active', 'Stale freeze');
      this.s.sql.exec("UPDATE owner SET state = 'frozen' WHERE id = 'p'");
    });
  }
  // Emulates the database contents immediately after PITR, without the PITR API.
  simulateRestore(oldEra) {
    check(this.state().state === 'frozen', 'Restore without freeze');
    this.s.transactionSync(() => {
      this.s.sql.exec("UPDATE owner SET era = ?, state = 'active', revision = 0 WHERE id = 'p'", oldEra);
      this.s.sql.exec("INSERT OR IGNORE INTO sessions VALUES ('old-session')");
      this.s.sql.exec("INSERT OR IGNORE INTO handoffs VALUES ('old-handoff')");
    });
  }
  async reconcile(era) {
    const route = await this.registry().read();
    check(route.state === 'recovering' && route.era === era, 'Recovery era mismatch');
    this.s.transactionSync(() => {
      this.s.sql.exec('DELETE FROM sessions');
      this.s.sql.exec('DELETE FROM handoffs');
      this.s.sql.exec("UPDATE owner SET era = ?, state = 'active', revision = 0 WHERE id = 'p'", era);
    });
  }
  counts() {
    return { sessions: this.s.sql.exec('SELECT COUNT(*) AS n FROM sessions').one().n,
      handoffs: this.s.sql.exec('SELECT COUNT(*) AS n FROM handoffs').one().n,
      commits: this.s.sql.exec('SELECT COUNT(*) AS n FROM commits').one().n };
  }
  evict() { this.ctx.abort('test eviction'); }
}

export default { async fetch(request, env) {
  try {
    const registry = env.REGISTRY.getByName('control');
    const owner = env.PROJECT.getByName('project');
    const old = await registry.init();
    await owner.init();
    await owner.admit(old.era);
    const pending = owner.startVerification(old.era, 'stale-job');
    const settled = pending.then(() => false, () => true);
    for (let i = 0; i < 50 && !(await owner.waiting('stale-job')); i++) await new Promise(resolve => setTimeout(resolve, 10));
    check(await owner.waiting('stale-job'), 'Verification did not suspend');
    const recovery = await registry.begin(old.era);
    await rejects(() => registry.begin(old.era), 'Concurrent recovery accepted');
    await rejects(() => owner.admit(old.era), 'Registry recovery did not stop admission');
    await owner.freeze(old.era);
    await owner.simulateRestore(old.era);
    await rejects(() => owner.admit(old.era), 'Restored old owner admitted before reconciliation');
    await owner.reconcile(recovery.era);
    await rejects(() => owner.admit(recovery.era), 'Owner admitted before registry activation');
    await registry.activate(recovery.era);
    await rejects(() => owner.admit(old.era), 'Old route admitted after recovery');
    await owner.admit(recovery.era);
    await owner.release('stale-job');
    check(await settled, 'Pre-restore verifier committed');
    const counts = await owner.counts();
    check(counts.sessions === 0 && counts.handoffs === 0 && counts.commits === 0, 'Recovery did not invalidate state');
    await rejects(() => owner.evict(), 'Eviction failed');
    await env.PROJECT.getByName('project').admit(recovery.era);
    return Response.json({ ok: true });
  } catch (error) { return Response.json({ ok: false, error: String(error), stack: error?.stack }, { status: 500 }); }
} };
