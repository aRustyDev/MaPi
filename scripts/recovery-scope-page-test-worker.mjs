// Synthetic local-only exercise of the real registry capture method. The
// registry status and owner RPC are deliberately test doubles.
import { DurableObject } from 'cloudflare:workers';
import { ProjectRegistry } from '../worker/registry.js';
import { readOwnerRecoveryScopes, RECOVERY_SCOPE_BYTES } from '../worker/recovery-scopes.js';

const project = 'proj_test', recoveryId = 'recovery_test';
const scope = id => JSON.stringify({ v: 1, kind: 'user-update', args: [project, id] });
const check = (condition, message) => { if (!condition) throw Error(message); };
const bytes = value => new TextEncoder().encode(JSON.stringify(value)).length;

export class ScopePageOwner extends DurableObject {
  makePage() {
    const sql = this.ctx.storage.sql;
    sql.exec('CREATE TABLE IF NOT EXISTS mapi_revision_scopes (scope TEXT PRIMARY KEY, stamp INTEGER NOT NULL)');
    sql.exec('DELETE FROM mapi_revision_scopes');
    for (const id of ['a', '\uE000', '\u{10000}']) sql.exec('INSERT INTO mapi_revision_scopes VALUES (?, 1)', scope(id));
    return readOwnerRecoveryScopes(sql, project, null);
  }
  echo(page) { return page; }
}

export class ScopePageRunner extends DurableObject {
  async run() {
    const sql = this.ctx.storage.sql, owner = this.env.OWNER.getByName('scope-page-owner');
    sql.exec('CREATE TABLE IF NOT EXISTS mapi_recovery_scope_progress (project_id TEXT PRIMARY KEY, recovery_id TEXT NOT NULL, cursor TEXT, row_count INTEGER NOT NULL, digest TEXT NOT NULL, done INTEGER NOT NULL)');
    sql.exec('CREATE TABLE IF NOT EXISTS mapi_recovery_scope_anchors (recovery_id TEXT NOT NULL, project_id TEXT NOT NULL, scope TEXT NOT NULL, stamp TEXT NOT NULL, PRIMARY KEY (recovery_id, project_id, scope))');
    sql.exec('CREATE TABLE IF NOT EXISTS mapi_project_recoveries (project_id TEXT PRIMARY KEY, recovery_id TEXT NOT NULL, phase TEXT NOT NULL, clock_kind TEXT NOT NULL, clock_highwater TEXT NOT NULL)');
    sql.exec('DELETE FROM mapi_project_recoveries');
    sql.exec("INSERT INTO mapi_project_recoveries VALUES (?, ?, 'anchored', 'revision', '100')", project, recoveryId);
    const reset = () => { sql.exec('DELETE FROM mapi_recovery_scope_progress'); sql.exec('DELETE FROM mapi_recovery_scope_anchors'); };
    let supplied;
    const fake = {
      ctx: { storage: this.ctx.storage },
      env: { MAPI_RELOCATION_ENABLED: '1', MAPI_RELOCATION_CONTROL_TOKEN: 'local-test', NEXTGEN_APPLICATION: {
        getByName: () => ({ recoveryScopePage: () => owner.echo(supplied) }),
      } },
      recoveryStatus: () => ({ recovery_id: recoveryId, phase: 'anchored', clock_kind: 'revision', clock_highwater: '100', object_name: 'test-owner' }),
    };
    const capture = () => ProjectRegistry.prototype.captureRecoveryScopes.call(fake, 'local-test', project, recoveryId);
    const snapshot = () => JSON.stringify({
      progress: sql.exec('SELECT * FROM mapi_recovery_scope_progress ORDER BY project_id').toArray(),
      anchors: sql.exec('SELECT * FROM mapi_recovery_scope_anchors ORDER BY scope').toArray(),
    });
    const base = scope('a');
    const seedCheckpoint = () => {
      reset();
      sql.exec('INSERT INTO mapi_recovery_scope_progress VALUES (?, ?, ?, 1, ?, 0)', project, recoveryId, base, 'a'.repeat(64));
      sql.exec('INSERT INTO mapi_recovery_scope_anchors VALUES (?, ?, ?, ?)', recoveryId, project, base, '1');
    };
    const rejectWithoutChange = async (label, page) => {
      supplied = page;
      const before = snapshot();
      let rejected = false;
      try { await capture(); } catch { rejected = true; }
      check(rejected && snapshot() === before, `${label} advanced recovery capture`);
    };

    reset();
    supplied = { rows: [{ scope: base, stamp: '1' }], cursor: null, done: false };
    let initialRejected = false;
    try { await capture(); } catch { initialRejected = true; }
    const initial = sql.exec('SELECT cursor, row_count, digest, done FROM mapi_recovery_scope_progress WHERE project_id = ?', project).one();
    check(initialRejected && initial.cursor === null && initial.row_count === 0 && initial.digest === '' && initial.done === 0 &&
      sql.exec('SELECT COUNT(*) AS n FROM mapi_recovery_scope_anchors').one().n === 0, 'Initial malformed page changed evidence');

    const produced = await owner.makePage();
    check(JSON.stringify(Object.keys(produced)) === JSON.stringify(['rows', 'cursor', 'done']) &&
      produced.rows.every(row => JSON.stringify(Object.keys(row)) === JSON.stringify(['scope', 'stamp'])), 'Producer RPC wire field order changed');
    check(produced.rows.length === 3 && produced.rows[1].scope === scope('\uE000') && produced.rows[2].scope === scope('\u{10000}'), 'Producer BINARY order differs');
    reset(); supplied = produced;
    const captured = await capture();
    check(captured.done && captured.count === 3, 'Producer page was not accepted');

    seedCheckpoint();
    const low = scope('\uE000'), high = scope('\u{10000}');
    await rejectWithoutChange('reversed Unicode page', { rows: [{ scope: high, stamp: '1' }, { scope: low, stamp: '1' }], cursor: low, done: false });
    await rejectWithoutChange('duplicate page row', { rows: [{ scope: low, stamp: '1' }, { scope: low, stamp: '1' }], cursor: low, done: false });
    await rejectWithoutChange('non-advancing cursor', { rows: [{ scope: base, stamp: '1' }], cursor: base, done: false });
    await rejectWithoutChange('empty nonterminal', { rows: [], cursor: base, done: false });
    await rejectWithoutChange('empty terminal cursor', { rows: [], cursor: low, done: true });
    await rejectWithoutChange('foreign scope', { rows: [{ scope: JSON.stringify({ v: 1, kind: 'user-update', args: ['another_project', 'z'] }), stamp: '1' }], cursor: JSON.stringify({ v: 1, kind: 'user-update', args: ['another_project', 'z'] }), done: true });
    await rejectWithoutChange('stamp above high-water', { rows: [{ scope: low, stamp: '101' }], cursor: low, done: false });
    await rejectWithoutChange('unexpected row property', { rows: [{ scope: low, stamp: '1', extra: true }], cursor: low, done: false });
    await rejectWithoutChange('different wire field order', { done: false, cursor: low, rows: [{ scope: low, stamp: '1' }] });
    const lone = scope('\uD800');
    await rejectWithoutChange('unpaired surrogate', { rows: [{ scope: lone, stamp: '1' }], cursor: lone, done: false });
    const huge = 'z'.repeat(RECOVERY_SCOPE_BYTES);
    await rejectWithoutChange('oversized cursor', { rows: [], cursor: huge, done: true });

    // Backslashes expand once in the scope JSON and again when the scope is
    // encoded as a page string. Test the actual encoded page, not raw text.
    const makePage = n => { const s = scope('z' + '\\'.repeat(n)); return { rows: [{ scope: s, stamp: '1' }], cursor: s, done: false }; };
    let lo = 0, hi = RECOVERY_SCOPE_BYTES;
    while (lo + 1 < hi) { const mid = Math.floor((lo + hi) / 2); if (bytes(makePage(mid)) <= RECOVERY_SCOPE_BYTES) lo = mid; else hi = mid; }
    const within = makePage(lo), over = makePage(hi);
    check(bytes(within) <= RECOVERY_SCOPE_BYTES && bytes(over) > RECOVERY_SCOPE_BYTES, 'Encoded page boundary not exercised');
    await rejectWithoutChange('encoded page over limit', over);
    supplied = within;
    const next = await capture();
    check(!next.done && next.count === 2, 'Boundary page was rejected');
    supplied = { rows: [], cursor: within.cursor, done: true };
    const terminal = await capture();
    check(terminal.done && terminal.count === 2, 'Valid empty terminal page was rejected');
    return { ok: true, withinBytes: bytes(within), overBytes: bytes(over), producerFieldOrder: true, binaryOrder: true, initialEmptyCheckpoint: true };
  }
}

export default { fetch(request, env) { return env.RUNNER.getByName('scope-page-runner').run().then(result => Response.json(result)); } };
