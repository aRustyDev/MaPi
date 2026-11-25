// Synthetic staging only. This Worker owns fresh namespaces and accepts no
// caller-selected project, database, SQL, or other fixture data.
import { NextgenApplication, ProjectRegistry } from '../worker/phase1-owner.js';

export { ProjectRegistry };

export class RelocationTextStagingOwner extends NextgenApplication {
  addTextFixture(projectId, userId) {
    const sql = this.ctx.storage.sql;
    this.ctx.storage.transactionSync(() => {
      sql.exec("INSERT INTO user_attributes (project_id, user_id, key, value) VALUES (?, ?, 'utf8-valid', ?)", projectId, userId, '"é😀�"');
      sql.exec("INSERT INTO user_attributes (project_id, user_id, key, value) VALUES (?, ?, 'utf8-invalid', CAST(X'228022' AS TEXT))", projectId, userId);
    });
  }

  removeInvalidTextFixture(projectId, userId) {
    this.ctx.storage.sql.exec("DELETE FROM user_attributes WHERE project_id = ? AND user_id = ? AND key = 'utf8-invalid'", projectId, userId);
  }

  textFixtureState(projectId, userId) {
    return this.ctx.storage.sql.exec('SELECT key, hex(value) AS bytes FROM user_attributes WHERE project_id = ? AND user_id = ? ORDER BY key', projectId, userId).toArray();
  }
}

const encode = new TextEncoder();
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const check = (condition, message) => { if (!condition) throw Error(message); };

export default {
  async fetch(request, env) {
    const provided = encode.encode(request.headers.get('authorization') ?? '');
    const expected = encode.encode(`Bearer ${env.MAPI_STAGING_PROOF_TOKEN ?? ''}`);
    if (!env.MAPI_STAGING_PROOF_TOKEN || provided.length !== expected.length || !crypto.subtle.timingSafeEqual(provided, expected) ||
        request.method !== 'POST' || new URL(request.url).pathname !== '/verify') return new Response(null, { status: 404 });
    const secret = env.MAPI_RELOCATION_CONTROL_TOKEN;
    const registry = env.PROJECT_REGISTRY.getByName('projects');
    const run = crypto.randomUUID();
    const origin = `https://${run}.example.test`, objectName = `source-${run}`, moveId = `move-${run}`;
    const source = env.NEXTGEN_APPLICATION.getByName(objectName);
    let stage = 'Go project and user creation';
    try {
      await registry.reserve(origin, objectName);
      const { projectId } = await source.provision('SQLite TEXT staging proof', origin, { projectId: null, origin, objectName, generation: 1 });
      await registry.activate(origin, objectName, projectId);
      const route = { projectId, origin, objectName, generation: 1 };
      const { userId } = await source.addUser('fixture@example.test', 'Synthetic-password-123!', route);
      const written = await source.textFixtureState(projectId, userId);
      check(written.some(row => row.key === 'email' && row.bytes === '2266697874757265406578616D706C652E7465737422'), 'Go user attribute was not stored');

      stage = 'read-only rejection before freeze';
      await source.addTextFixture(projectId, userId);
      const before = await source.textFixtureState(projectId, userId);
      check(before.some(row => row.key === 'utf8-invalid' && row.bytes === '228022') &&
        before.some(row => row.key === 'utf8-valid' && row.bytes === '22C3A9F09F9880EFBFBD22'), 'Fixture bytes differ');
      let rejected = false;
      try { await registry.beginRelocation(secret, origin, projectId, moveId); }
      catch (error) { if (!String(error).includes('Invalid UTF-8 TEXT')) throw error; rejected = true; }
      const status = await registry.relocationStatus(secret, projectId);
      check(rejected && status.route?.state === 'active' && status.intent?.move_id === moveId && !status.move &&
        same(before, await source.textFixtureState(projectId, userId)), 'Rejection changed the source or route');
      await source.addUser('still-active@example.test', 'Synthetic-password-123!', route);
      await source.removeInvalidTextFixture(projectId, userId);

      stage = 'valid TEXT export and import';
      const move = await registry.beginRelocation(secret, origin, projectId, moveId);
      const target = env.NEXTGEN_APPLICATION.getByName(move.destination_object);
      await target.reserveMoveDestination(secret, { ...route, objectName: move.destination_object, generation: 2 }, moveId);
      await target.prepareRelocation(secret, projectId, moveId);
      await source.beginRelocationExport(secret, projectId, moveId);
      await target.beginRelocationImport(secret, projectId, moveId);
      let chunks = 0;
      while (!(await target.relocationImportStatus(secret, projectId, moveId)).done) {
        check(chunks < 256, 'Too many chunks for the synthetic fixture');
        await target.importRelocationChunk(secret, projectId, moveId, chunks++);
      }
      await target.restoreRelocationMetadata(secret, projectId, moveId);
      check(same(await target.textFixtureState(projectId, userId), await source.textFixtureState(projectId, userId)), 'Destination bytes differ');

      stage = 'transfer history';
      for (let index = 1; index <= chunks; index++) {
        const history = await registry.verifyRelocationHistory(secret, projectId, moveId);
        check(history.nextIndex === index && history.done === (index === chunks), 'Transfer history did not advance');
      }

      stage = 'reconciliation';
      let pages = 0;
      do { check(++pages <= 256, 'Too many reconciliation pages for the synthetic fixture'); }
      while (!(await registry.reconcileRelocation(secret, projectId, moveId)).done);
      stage = 'cutover guard';
      let cutoverBlocked = false;
      try { await registry.commitRelocation(secret, projectId, moveId); }
      catch (error) { if (!String(error).includes('independent archive proof is not configured')) throw error; cutoverBlocked = true; }
      check(cutoverBlocked && (await registry.resolve(origin)).state === 'moving', 'Synthetic route cut over');
      return Response.json({ goBridge: true, rejectedBeforeFreeze: true, sourceBytesPreserved: true, validBytesMatched: true, chunks, pages, cutoverBlocked });
    } catch (error) {
      console.error(`SQLite TEXT staging proof failed during ${stage}`, error?.message);
      return Response.json({ stage }, { status: 500 });
    }
  },
};
