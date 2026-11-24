// Synthetic-only staging entry. The public fetch, application and registry are
// exactly the frozen candidate; only this private coordinator adds restart RPCs.
import worker, { NextgenApplication, ProjectRegistry } from './phase1-owner.js';
import { RelocationCoordinator as BaseCoordinator } from './relocation-coordinator.js';
export { NextgenApplication, ProjectRegistry };
export default worker;

export class RelocationCoordinator extends BaseCoordinator {
  constructor(ctx, env) { super(ctx, env); this.bootId = crypto.randomUUID(); }
  #authorize(secret, origin, projectId, moveId) {
    const expected = this.env.MAPI_RELOCATION_CONTROL_TOKEN;
    if (this.env.MAPI_RESTART_REHEARSAL !== '1' || this.env.MAPI_RELOCATION_ENABLED !== '1' || !expected || typeof secret !== 'string' || secret.length !== expected.length) throw Error('Restart rehearsal denied');
    let mismatch = 0; for (let i = 0; i < secret.length; i++) mismatch |= secret.charCodeAt(i) ^ expected.charCodeAt(i);
    if (mismatch || origin !== this.env.MAPI_RESTART_ORIGIN || moveId !== this.env.MAPI_RESTART_MOVE_ID || typeof projectId !== 'string') throw Error('Restart rehearsal identity mismatch');
  }
  async restartProbe(secret, origin, projectId, moveId) {
    this.#authorize(secret, origin, projectId, moveId);
    const state = await this.env.PROJECT_REGISTRY.getByName('projects').relocationStatus(secret, projectId);
    if (!state.route || state.route.origin !== origin || state.route.project_id !== projectId || (state.move && state.move.move_id !== moveId)) throw Error('Restart rehearsal project mismatch');
    const sql = this.ctx.storage.sql;
    const exists = sql.exec("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='mapi_restart_rehearsal'").toArray().length;
    const markers = exists ? sql.exec('SELECT sequence, stage, boot_id, detail FROM mapi_restart_rehearsal ORDER BY sequence').toArray() : [];
    return { bootId: this.bootId, markers, route: state.route, move: state.move };
  }
  async restartAt(secret, origin, projectId, moveId, stage) {
    this.#authorize(secret, origin, projectId, moveId);
    if (!['frozen', 'importing', 'committed', 'activated'].includes(stage)) throw Error('Invalid restart stage');
    const registry = this.env.PROJECT_REGISTRY.getByName('projects');
    let { route, move } = await registry.relocationStatus(secret, projectId);
    if (!route || route.origin !== origin || route.project_id !== projectId) throw Error('Restart rehearsal project mismatch');
    if (stage === 'frozen') {
      if (move) throw Error('Freeze restart must start a new move');
      move = await registry.beginRelocation(secret, origin, projectId, moveId);
      const source = this.env.NEXTGEN_APPLICATION.getByName(move.source_object);
      await source.armRelocation(secret, projectId, moveId);
      await source.freezeRelocation(secret, { projectId, origin, objectName: move.source_object, generation: move.generation }, moveId);
      ({ route, move } = await registry.relocationStatus(secret, projectId));
    }
    if (!move || move.move_id !== moveId) throw Error('Restart move mismatch');
    const source = this.env.NEXTGEN_APPLICATION.getByName(move.source_object);
    const target = this.env.NEXTGEN_APPLICATION.getByName(move.destination_object);
    const sourceState = await source.relocationAttestation(secret, projectId);
    if (sourceState?.state !== 'frozen' || sourceState.move_id !== moveId) throw Error('Source is not frozen');
    let detail = '';
    if (stage === 'frozen') {
      if (move.phase !== 'moving') throw Error('Invalid freeze phase');
      detail = move.source_object;
    } else if (stage === 'importing') {
      if (move.phase !== 'moving') throw Error('Invalid import phase');
      const checkpoint = await target.relocationImportStatus(secret, projectId, moveId);
      if (!checkpoint || checkpoint.done || checkpoint.next_chunk < 2) throw Error('Import has not reached a durable intermediate checkpoint');
      detail = String(checkpoint.next_chunk);
    } else {
      if (move.phase !== 'committed' || route.object_name !== move.destination_object || route.generation !== move.generation + 1) throw Error('Cutover has not committed');
      if (stage === 'activated') await target.activateRelocation(secret, projectId, moveId);
      const targetState = await target.relocationAttestation(secret, projectId);
      if (targetState?.state !== (stage === 'committed' ? 'staged' : 'active')) throw Error('Destination stage differs');
      detail = String(route.generation);
    }
    this.ctx.storage.transactionSync(() => {
      const sql = this.ctx.storage.sql;
      sql.exec('CREATE TABLE IF NOT EXISTS mapi_restart_rehearsal (sequence INTEGER PRIMARY KEY, stage TEXT UNIQUE NOT NULL, boot_id TEXT NOT NULL, detail TEXT NOT NULL)');
      const count = sql.exec('SELECT COUNT(*) AS n FROM mapi_restart_rehearsal').one().n;
      const expected = ['frozen', 'importing', 'committed', 'activated'][count];
      if (stage !== expected) throw Error('Restart stages must be exercised in order');
      sql.exec('INSERT INTO mapi_restart_rehearsal VALUES (?, ?, ?, ?)', count + 1, stage, this.bootId, detail);
    });
    await this.ctx.storage.sync();
    this.ctx.abort(`Synthetic coordinator restart after ${stage}`);
  }
}
