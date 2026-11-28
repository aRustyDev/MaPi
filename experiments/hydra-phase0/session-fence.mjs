import { DurableObject } from "cloudflare:workers";

// The namespace is keyed by a trusted project/session identifier. This class
// only accepts private lifecycle RPCs from the caller that owns that mapping.
export class SessionFence extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    ctx.storage.transactionSync(() => {
      this.sql.exec(`
        CREATE TABLE IF NOT EXISTS fence (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          epoch INTEGER NOT NULL,
          closed INTEGER NOT NULL CHECK (closed IN (0, 1)),
          cleanup_done INTEGER NOT NULL CHECK (cleanup_done IN (0, 1))
        );
        INSERT OR IGNORE INTO fence VALUES (1, 1, 0, 0);
        CREATE TABLE IF NOT EXISTS grant_ref (
          id TEXT PRIMARY KEY,
          revoked INTEGER NOT NULL DEFAULT 0 CHECK (revoked IN (0, 1))
        );
        CREATE TABLE IF NOT EXISTS cleanup_job (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          session_id TEXT NOT NULL,
          tries INTEGER NOT NULL DEFAULT 0,
          lose_ack INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS test_barrier (
          phase TEXT PRIMARY KEY,
          state TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS attempt (
          id TEXT PRIMARY KEY,
          grant_id TEXT NOT NULL REFERENCES grant_ref(id),
          epoch INTEGER NOT NULL,
          outcome TEXT NOT NULL CHECK (outcome IN ('pending', 'committed', 'cancelled')),
          released INTEGER NOT NULL DEFAULT 0 CHECK (released IN (0, 1))
        );
      `);
    });
  }

  linkGrant(grant) {
    validateID(grant);
    return this.ctx.storage.transactionSync(() => {
      if (this.state().closed) return false;
      this.sql.exec("INSERT OR IGNORE INTO grant_ref (id) VALUES (?)", grant);
      return true;
    });
  }

  admit(grant, attempt) {
    validateID(grant);
    validateID(attempt);
    return this.ctx.storage.transactionSync(() => {
      const { epoch, closed } = this.state();
      if (closed || !this.sql.exec("SELECT 1 FROM grant_ref WHERE id = ?", grant).toArray().length) {
        return null;
      }
      const inserted = this.sql.exec(
        "INSERT OR IGNORE INTO attempt (id, grant_id, epoch, outcome) VALUES (?, ?, ?, 'pending') RETURNING id",
        attempt, grant, epoch,
      );
      return inserted.toArray().length === 1 ? { epoch } : null;
    });
  }

  // The caller supplies a confirmed Postgres receipt or a durable cancellation.
  // A missing commit acknowledgment leaves the attempt pending.
  settle(attempt, outcome) {
    validateID(attempt);
    if (outcome !== "committed" && outcome !== "cancelled") throw new Error("invalid terminal outcome");
    return this.ctx.storage.transactionSync(() => {
      const [row] = this.sql.exec("SELECT outcome FROM attempt WHERE id = ?", attempt).toArray();
      if (!row) return false;
      if (row.outcome === outcome) return true;
      if (row.outcome !== "pending") throw new Error("conflicting terminal outcome");
      this.sql.exec("UPDATE attempt SET outcome = ? WHERE id = ?", outcome, attempt);
      return true;
    });
  }

  release(attempt, epoch) {
    validateID(attempt);
    return this.ctx.storage.transactionSync(() => {
      const current = this.state();
      if (current.closed || current.epoch !== epoch) return false;
      return this.sql.exec(`
        UPDATE attempt SET released = 1
        WHERE id = ? AND epoch = ? AND outcome = 'committed' AND released = 0
        RETURNING id
      `, attempt, epoch).toArray().length === 1;
    });
  }

  async close(session, loseAck = false) {
    if (this.hydra) validateID(session);
    return this.ctx.storage.transaction(async () => {
      this.sql.exec("UPDATE fence SET closed = 1, epoch = epoch + 1 WHERE singleton = 1 AND closed = 0");
      const state = this.state();
      if (this.hydra && !state.cleanup_done) {
        this.sql.exec("INSERT OR IGNORE INTO cleanup_job (id, session_id, lose_ack) VALUES (1, ?, ?)",
          session, loseAck ? 1 : 0);
        if (this.sql.exec("SELECT session_id FROM cleanup_job WHERE id = 1").one().session_id !== session) {
          throw new Error("cleanup session mismatch");
        }
        if (await this.ctx.storage.getAlarm() === null) await this.ctx.storage.setAlarm(Date.now() + 100);
      }
      return state.epoch;
    });
  }

  async alarm() {
    if (this.env.SPIKE_BARRIERS === "true") console.log(JSON.stringify({ event: "mapi.hydra.phase0.alarm", stage: "enter" }));
    const [job] = this.sql.exec(`UPDATE cleanup_job SET tries = tries + 1 WHERE id = 1
      RETURNING session_id, tries, lose_ack`).toArray();
    if (!job || this.state().cleanup_done) {
      if (this.env.SPIKE_BARRIERS === "true") console.log(JSON.stringify({ event: "mapi.hydra.phase0.alarm", stage: "already-settled" }));
      return;
    }
    if (this.env.SPIKE_BARRIERS === "true") console.log(JSON.stringify({ event: "mapi.hydra.phase0.alarm", stage: "start", tries: job.tries }));

    const delay = Math.min(30_000, 1_000 * 2 ** Math.min(job.tries - 1, 5));
    await this.ctx.storage.setAlarm(Date.now() + delay);
    try {
      if (this.env.SPIKE_BARRIERS === "true" && this.barrier("pause_cleanup", "read") === "armed") {
        console.log(JSON.stringify({ event: "mapi.hydra.phase0.alarm", stage: "paused" }));
        return;
      }
      const attempts = this.sql.exec("SELECT id, grant_id FROM attempt WHERE outcome = 'pending' ORDER BY id").toArray();
      for (const { id, grant_id } of attempts) {
        const outcome = await this.hydra({ action: "reconcile", session: job.session_id, grant: grant_id, attempt: id });
        this.settle(id, outcome);
      }
      const status = this.cleanupStatus();
      if (status.state !== "ready") {
        if (this.env.SPIKE_BARRIERS === "true") console.log(JSON.stringify({ event: "mapi.hydra.phase0.alarm", stage: "waiting" }));
        return;
      }
      for (const grant of status.grants) {
        const outcome = await this.hydra({ action: "revoke", session: job.session_id, grant });
        if (outcome !== "revoked") throw new Error("unconfirmed Hydra cleanup");
      }
      if (job.lose_ack) {
        this.sql.exec("UPDATE cleanup_job SET lose_ack = 0 WHERE id = 1");
        if (this.env.SPIKE_BARRIERS === "true") console.log(JSON.stringify({ event: "mapi.hydra.phase0.alarm", stage: "simulated-lost-ack" }));
        return;
      }
      if (this.confirmCleanup(status.epoch, status.grants)) {
        await this.ctx.storage.deleteAlarm();
        if (this.env.SPIKE_BARRIERS === "true") console.log(JSON.stringify({ event: "mapi.hydra.phase0.alarm", stage: "complete" }));
      }
    } catch {
      if (this.env.SPIKE_BARRIERS === "true") console.log(JSON.stringify({ event: "mapi.hydra.phase0.alarm", stage: "retry" }));
      // The durable alarm was re-armed before issuing any remote calls.
    }
  }

  barrier(phase, state) {
    if (!["before_commit", "after_commit", "drop_ack", "pause_cleanup"].includes(phase)) throw new Error("invalid barrier phase");
    if (state === "arrive") {
      this.sql.exec("UPDATE test_barrier SET state = 'arrived' WHERE phase = ? AND state = 'armed'", phase);
    } else if (state !== "read") {
      if (!["armed", "pass", "rollback"].includes(state)) throw new Error("invalid barrier state");
      this.sql.exec(`INSERT INTO test_barrier VALUES (?, ?)
        ON CONFLICT (phase) DO UPDATE SET state = excluded.state`, phase, state);
    }
    const [row] = this.sql.exec("SELECT state FROM test_barrier WHERE phase = ?", phase).toArray();
    return row?.state ?? "pass";
  }

  restart() {
    this.ctx.abort("Phase 0 synthetic restart");
  }

  evidence() {
    return {
      ...this.state(),
      cleanup: this.cleanupStatus().state,
      tries: this.sql.exec("SELECT tries FROM cleanup_job WHERE id = 1").toArray()[0]?.tries ?? 0,
      attempts: this.sql.exec("SELECT id, outcome, released FROM attempt ORDER BY id").toArray(),
    };
  }

  cleanupStatus() {
    const current = this.state();
    if (!current.closed) return { state: "open" };
    if (current.cleanup_done) return { state: "complete" };
    const pending = this.sql.exec("SELECT id FROM attempt WHERE outcome = 'pending' ORDER BY id").toArray();
    if (pending.length) return { state: "waiting", attempts: pending.map(({ id }) => id) };
    const grants = this.sql.exec("SELECT id FROM grant_ref WHERE revoked = 0 ORDER BY id").toArray();
    return { state: "ready", grants: grants.map(({ id }) => id), epoch: current.epoch };
  }

  confirmCleanup(epoch, grants) {
    return this.ctx.storage.transactionSync(() => {
      const current = this.state();
      if (!current.closed || current.epoch !== epoch) return false;
      const job = this.cleanupStatus();
      if (job.state === "complete") return true;
      if (job.state !== "ready" || !Array.isArray(grants) ||
          grants.length !== job.grants.length || job.grants.some((grant, index) => grant !== grants[index])) {
        return false;
      }
      this.sql.exec("UPDATE grant_ref SET revoked = 1 WHERE revoked = 0");
      this.sql.exec("UPDATE fence SET cleanup_done = 1 WHERE singleton = 1");
      return true;
    });
  }

  state() {
    return this.sql.exec("SELECT epoch, closed, cleanup_done FROM fence WHERE singleton = 1").one();
  }
}

function validateID(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) {
    throw new Error("invalid opaque identifier");
  }
}
