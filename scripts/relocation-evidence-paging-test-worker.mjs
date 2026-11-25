import { ProjectRegistry } from '../worker/registry.js';
import { assertEvidenceAppendAllowed, recordEvidencePage } from '../worker/registry-evidence.js';
import { CapacityOwner } from './relocation-text-capacity-worker.mjs';

export { CapacityOwner };
const check = (condition, message) => { if (!condition) throw Error(message); };
const rejects = async (fn, expected) => { try { await fn(); } catch (error) { if (String(error).includes(expected)) return; throw error; } throw Error('Expected rejection'); };

export class PagingRegistry extends ProjectRegistry {
  #boot = crypto.randomUUID();
  boot() { return this.#boot; }
  seedLegacy() {
    return this.ctx.storage.transactionSync(() => {
      const sql = this.ctx.storage.sql;
      sql.exec("INSERT INTO mapi_move_journals VALUES ('synthetic-move-a', 'synthetic-a', 1)");
      sql.exec("INSERT INTO mapi_move_journals VALUES ('synthetic-move-b', 'synthetic-b', 1)");
      // Intentionally interleave two moves and disorder key order relative to
      // rowid order, so the backfill cannot use its cursor as the public cursor.
      for (let i = 0; i < 105; i++) {
        const cursor = JSON.stringify([`k-${String(i).padStart(4, '0')}`]);
        sql.exec("INSERT INTO mapi_move_evidence VALUES ('synthetic-move-a', 'synthetic-a', ?, 'users', ?, NULL, 1, ?, 0)", i % 3, cursor, 'a'.repeat(64));
        if (i % 7 === 0) sql.exec("INSERT INTO mapi_move_evidence VALUES ('synthetic-move-b', 'synthetic-b', 0, 'events', ?, NULL, 1, ?, 0)", cursor, 'b'.repeat(64));
      }
      return true;
    });
  }
  addConcurrent() {
    return this.ctx.storage.transactionSync(() => {
      const sql = this.ctx.storage.sql;
      // This sorts before the first backfill cursor; dual-write must retain it.
      assertEvidenceAppendAllowed(sql, 'synthetic-a', 'synthetic-move-a');
      sql.exec("INSERT INTO mapi_move_evidence VALUES ('synthetic-move-a', 'synthetic-a', 0, 'users', ?, NULL, 1, ?, 0)", JSON.stringify(['a-late-write']), 'c'.repeat(64));
      recordEvidencePage(sql, 'synthetic-a', 'synthetic-move-a');
    });
  }
  addAfterCompletion() {
    return this.ctx.storage.transactionSync(() => {
      const sql = this.ctx.storage.sql;
      assertEvidenceAppendAllowed(sql, 'synthetic-a', 'synthetic-move-a');
      sql.exec("INSERT INTO mapi_move_evidence VALUES ('synthetic-move-a', 'synthetic-a', 99, 'users', ?, NULL, 1, ?, 0)", JSON.stringify(['z-late-write']), 'd'.repeat(64));
      recordEvidencePage(sql, 'synthetic-a', 'synthetic-move-a');
    });
  }
  expected(move) { return this.ctx.storage.sql.exec('SELECT rowid AS sequence FROM mapi_move_evidence WHERE move_id = ? ORDER BY rowid', move).toArray().map(row => row.sequence); }
  progress(move) { return this.ctx.storage.sql.exec('SELECT table_index, cursor, last_sequence, complete FROM mapi_move_evidence_index WHERE move_id = ?', move).toArray()[0] ?? null; }
  setComplete(move, value) { this.ctx.storage.sql.exec('UPDATE mapi_move_evidence_index SET complete = ? WHERE move_id = ?', value, move); }
  setCheckpoint(move, field, value) {
    if (!['table_index', 'cursor', 'last_sequence'].includes(field)) throw Error('Invalid fixture field');
    this.ctx.storage.sql.exec(`UPDATE mapi_move_evidence_index SET ${field} = ? WHERE move_id = ?`, value, move);
  }
  laterCursor(move, index, cursor) { return this.ctx.storage.sql.exec('SELECT cursor_in FROM mapi_move_evidence WHERE move_id = ? AND table_index = ? AND cursor_in > ? ORDER BY cursor_in LIMIT 1', move, index, cursor).one().cursor_in; }
  alterLastOriginal(sequence, cursor) { this.ctx.storage.sql.exec('UPDATE mapi_move_evidence SET cursor_in = ? WHERE rowid = ?', cursor, sequence); }
  removeCheckpointMapping(sequence) {
    const sql = this.ctx.storage.sql;
    const row = sql.exec("SELECT sequence, previous, following FROM mapi_move_evidence_pages WHERE move_id = 'synthetic-move-a' AND sequence = ?", sequence).one();
    sql.exec("DELETE FROM mapi_move_evidence_pages WHERE move_id = 'synthetic-move-a' AND sequence = ?", sequence);
    return row;
  }
  pageCount(move) { return this.ctx.storage.sql.exec('SELECT count(*) AS n FROM mapi_move_evidence_pages WHERE move_id = ?', move).one().n; }
  removeMapping() {
    const sql = this.ctx.storage.sql;
    const row = sql.exec("SELECT sequence, previous, following FROM mapi_move_evidence_pages WHERE move_id = 'synthetic-move-a' ORDER BY sequence LIMIT 1 OFFSET 10").one();
    sql.exec("DELETE FROM mapi_move_evidence_pages WHERE move_id = 'synthetic-move-a' AND sequence = ?", row.sequence);
    return row;
  }
  restoreMapping(row) { this.ctx.storage.sql.exec("INSERT INTO mapi_move_evidence_pages VALUES ('synthetic-move-a', 'synthetic-a', ?, ?, ?)", row.sequence, row.previous, row.following); }
  corruptForeignMapping() {
    const sql = this.ctx.storage.sql;
    const row = sql.exec("SELECT sequence, previous, following FROM mapi_move_evidence_pages WHERE move_id = 'synthetic-move-a' ORDER BY sequence LIMIT 1").one();
    const other = sql.exec("SELECT min(rowid) AS sequence FROM mapi_move_evidence WHERE move_id = 'synthetic-move-b'").one().sequence;
    sql.exec("UPDATE mapi_move_evidence_pages SET sequence = ? WHERE move_id = 'synthetic-move-a' AND sequence = ?", other, row.sequence);
    return { ...row, other };
  }
  restoreForeignMapping(row) { this.ctx.storage.sql.exec("UPDATE mapi_move_evidence_pages SET sequence = ? WHERE move_id = 'synthetic-move-a' AND sequence = ?", row.sequence, row.other); }
  plans() {
    const sql = this.ctx.storage.sql;
    return [
      sql.exec("EXPLAIN QUERY PLAN SELECT rowid FROM mapi_move_evidence INDEXED BY sqlite_autoindex_mapi_move_evidence_1 WHERE move_id = ? AND (table_index, cursor_in) > (?, ?) ORDER BY table_index, cursor_in LIMIT 33", 'synthetic-move-a', 0, '[]').toArray().map(row => row.detail),
      sql.exec("EXPLAIN QUERY PLAN SELECT page.sequence FROM mapi_move_evidence_pages page LEFT JOIN mapi_move_evidence e ON e.rowid = page.sequence WHERE page.move_id = ? AND page.project_id = ? AND page.sequence > ? ORDER BY page.sequence LIMIT 33", 'synthetic-move-a', 'synthetic-a', 0).toArray().map(row => row.detail),
    ];
  }
  evict() { this.ctx.abort('Synthetic registry restart'); }
}

export default {
 async fetch(request, env) {
  try {
   let registry = env.PROJECT_REGISTRY.getByName('projects');
   // Exercise the real Go/Wasm owner before the synthetic legacy journal.
   const origin = 'https://synthetic-evidence.example';
   const owner = env.NEXTGEN_APPLICATION.getByName('source');
   await registry.reserve(origin, 'source');
   const project = await owner.provision('Synthetic evidence', origin, { projectId: null, origin, objectName: 'source', generation: 1 });
   await registry.activate(origin, 'source', project.projectId);
   const route = { projectId: project.projectId, origin, objectName: 'source', generation: 1 };
   const user = await owner.addUser('paging@example.invalid', 'Synthetic-evidence-pass123!', route);
   check(!!user, 'Real Go/Wasm owner did not create synthetic data');
   await registry.seedLegacy();
   const plans = await registry.plans();
   check(plans.every(plan => !plan.some(text => /TEMP B-TREE/i.test(text))), 'Evidence paging query requires unbounded sorting');
   check(plans[0].some(text => /sqlite_autoindex_mapi_move_evidence_1/.test(text)) && plans[1].some(text => /sqlite_autoindex_mapi_move_evidence_pages_1/.test(text)), 'Evidence paging does not use bounded indexes');
   await rejects(() => registry.relocationEvidence('move-secret', 'synthetic-a', 'synthetic-move-a', 0), 'Evidence index preparation in progress');
   const before = await registry.progress('synthetic-move-a');
   check(before && !before.complete && await registry.pageCount('synthetic-move-a') === 32, 'Backfill did not persist a bounded first batch');
   const later = await registry.laterCursor('synthetic-move-a', before.table_index, before.cursor);
   await registry.setCheckpoint('synthetic-move-a', 'cursor', later);
   await rejects(() => registry.relocationEvidence('move-secret', 'synthetic-a', 'synthetic-move-a', 0), 'Invalid evidence paging checkpoint');
   await registry.setCheckpoint('synthetic-move-a', 'cursor', before.cursor);
   await registry.setCheckpoint('synthetic-move-a', 'table_index', before.table_index + 1);
   await rejects(() => registry.relocationEvidence('move-secret', 'synthetic-a', 'synthetic-move-a', 0), 'Invalid evidence paging checkpoint');
   await registry.setCheckpoint('synthetic-move-a', 'table_index', before.table_index);
   await registry.setCheckpoint('synthetic-move-a', 'last_sequence', before.last_sequence + 1);
   await rejects(() => registry.relocationEvidence('move-secret', 'synthetic-a', 'synthetic-move-a', 0), 'Invalid evidence paging checkpoint');
   await registry.setCheckpoint('synthetic-move-a', 'last_sequence', before.last_sequence);
   const missingCheckpoint = await registry.removeCheckpointMapping(before.last_sequence);
   await rejects(() => registry.relocationEvidence('move-secret', 'synthetic-a', 'synthetic-move-a', 0), 'Invalid evidence paging checkpoint');
   await registry.restoreMapping(missingCheckpoint);
   await registry.alterLastOriginal(before.last_sequence, '["synthetic-altered"]');
   await rejects(() => registry.relocationEvidence('move-secret', 'synthetic-a', 'synthetic-move-a', 0), 'Invalid evidence paging checkpoint');
   await registry.alterLastOriginal(before.last_sequence, before.cursor);
   await registry.setComplete('synthetic-move-a', 1);
   await rejects(() => registry.relocationEvidence('move-secret', 'synthetic-a', 'synthetic-move-a', 0), 'Evidence paging checkpoint is incomplete');
   const beforeRejectedAppend = await registry.expected('synthetic-move-a');
   await rejects(() => registry.addAfterCompletion(), 'Evidence paging checkpoint is incomplete');
   check(JSON.stringify(await registry.expected('synthetic-move-a')) === JSON.stringify(beforeRejectedAppend), 'Rejected append changed historical evidence');
   await registry.setComplete('synthetic-move-a', 0);
   const beforeBoot = await registry.boot();
   try { await registry.evict(); throw Error('Synthetic eviction was not observed'); }
   catch (error) { if (String(error).includes('Synthetic eviction was not observed')) throw error; }
   registry = env.PROJECT_REGISTRY.getByName('projects');
   check(await registry.boot() !== beforeBoot, 'Registry did not restart');
   check(JSON.stringify(await registry.progress('synthetic-move-a')) === JSON.stringify(before), 'Eviction lost backfill progress');
   const concurrent = await Promise.allSettled([
     registry.relocationEvidence('move-secret', 'synthetic-a', 'synthetic-move-a', 0),
     registry.addConcurrent(),
   ]);
   check(concurrent[1].status === 'fulfilled', 'Concurrent evidence write failed');
   if (concurrent[0].status === 'rejected') check(String(concurrent[0].reason).includes('Evidence index preparation in progress'), 'Unexpected concurrent paging error');
   let first;
   for (let retries = 0; retries < 10; retries++) {
     try { first = await registry.relocationEvidence('move-secret', 'synthetic-a', 'synthetic-move-a', 0); break; }
     catch (error) { if (!String(error).includes('Evidence index preparation in progress')) throw error; }
   }
   check(first && first.complete, 'Historical evidence indexing did not finish');
   await registry.addAfterCompletion();
   const all = []; let after = 0, page = first;
   for (;;) {
     check(page.pages.every(item => item.table === 'users' && item.sequence > after), 'Foreign or unordered evidence returned');
     for (const item of page.pages) { check(item.sequence > after, 'Evidence sequence did not advance'); all.push(item.sequence); after = item.sequence; }
     check(page.next === after, 'Historical evidence cursor changed semantics');
     if (page.done) break;
     check(page.pages.length > 0, 'Evidence page did not advance');
     page = await registry.relocationEvidence('move-secret', 'synthetic-a', 'synthetic-move-a', after);
   }
   check(JSON.stringify(all) === JSON.stringify(await registry.expected('synthetic-move-a')), 'Evidence rowid ordering or data changed');
   await rejects(() => registry.relocationEvidence('move-secret', 'synthetic-b', 'synthetic-move-a', 0), 'Move evidence not available');
   const other = await registry.relocationEvidence('move-secret', 'synthetic-b', 'synthetic-move-b', 0);
   check(other.pages.every(item => item.table === 'events') && JSON.stringify(other.pages.map(item => item.sequence)) === JSON.stringify(await registry.expected('synthetic-move-b')), 'Other move evidence changed');
   const missing = await registry.removeMapping();
   await rejects(() => registry.relocationEvidence('move-secret', 'synthetic-a', 'synthetic-move-a', 0), 'Invalid evidence paging index');
   await rejects(() => registry.relocationEvidence('move-secret', 'synthetic-a', 'synthetic-move-a', missing.sequence), 'Invalid evidence paging index');
   await registry.restoreMapping(missing);
   const foreign = await registry.corruptForeignMapping();
   await rejects(() => registry.relocationEvidence('move-secret', 'synthetic-a', 'synthetic-move-a', 0), 'Invalid evidence paging index');
   await registry.restoreForeignMapping(foreign);
   return Response.json({ ok: true, pages: all.length });
  } catch (error) { return Response.json({ ok: false, error: String(error), stack: error?.stack }, { status: 500 }); }
 },
};
