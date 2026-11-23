import { DurableObject } from 'cloudflare:workers';
import { initializeProjectFence, freezeProject } from '../worker/relocation.js';
import { beginChunkExport, exportChunk } from '../worker/relocation-chunks.js';

export class ExportReplayIntegrity extends DurableObject {
  setup(count = 1) {
    const s = this.ctx.storage;
    s.sql.exec('CREATE TABLE items (id TEXT PRIMARY KEY, value TEXT NOT NULL)');
    for (let index = 0; index < count; index++) s.sql.exec('INSERT INTO items VALUES (?, ?)', `key-${String(index).padStart(3, '0')}`, 'original');
    initializeProjectFence(s, 'project', 'source', 1);
    freezeProject(s, 'project', 1, 'move');
    beginChunkExport(s, 'project', 1, 'move', ['items']);
  }
  chunk(interrupt = false) { return exportChunk(this.ctx.storage, 'project', 1, 'move', 0, interrupt); }
  chunkAt(index) { return exportChunk(this.ctx.storage, 'project', 1, 'move', index); }
  change(sql, ...args) { this.ctx.storage.sql.exec(sql, ...args); }
  async startHeldReplay() {
    // Test-only scheduling hook: pause the first digest call in this isolate.
    // No production entry point exposes a callback or changes hash behavior.
    let announce;
    const announced = new Promise(resolve => { announce = resolve; });
    const gate = new Promise(resolve => { this.releaseDigest = resolve; });
    const original = crypto.subtle.digest;
    let first = true;
    crypto.subtle.digest = (...args) => {
      if (first) {
        first = false;
        announce(true);
        return gate.then(() => original.apply(crypto.subtle, args));
      }
      return original.apply(crypto.subtle, args);
    };
    this.pendingReplay = exportChunk(this.ctx.storage, 'project', 1, 'move', 0)
      .then(value => ({ rejected: false, value }), error => ({ rejected: true, error: String(error) }))
      .finally(() => { crypto.subtle.digest = original; });
    return Promise.race([announced, this.pendingReplay.then(() => false)]);
  }
  async finishHeldReplay() {
    this.releaseDigest();
    return this.pendingReplay;
  }
  snapshot() {
    const sql = this.ctx.storage.sql;
    return JSON.stringify({
      checkpoint: sql.exec('SELECT * FROM mapi_chunk_export').toArray(),
      chunks: sql.exec('SELECT * FROM mapi_chunk_export_data ORDER BY chunk_index').toArray(),
      fence: sql.exec('SELECT * FROM mapi_relocation_project').toArray(),
      items: sql.exec('SELECT * FROM items').toArray(),
    });
  }
}

async function rejects(fn) {
  try { await fn(); } catch { return; }
  throw Error('Expected export replay to reject');
}

export default {
  async fetch(request, env) {
    try {
      const id = crypto.randomUUID();
      const owner = env.OWNER.getByName(id);
      await owner.setup();
      await rejects(() => owner.chunk(true));
      const reserved = JSON.parse(await owner.snapshot());
      if (reserved.checkpoint[0].next_chunk !== 0 || reserved.chunks[0].digest !== null) throw Error('Reserved checkpoint changed');
      // An unexpected digest at the current checkpoint cannot result from a
      // successful atomic finalize; retry must reject without changing state.
      const digestBytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(reserved.chunks[0].content));
      const reservedDigest = [...new Uint8Array(digestBytes)].map(byte => byte.toString(16).padStart(2, '0')).join('');
      await owner.change('UPDATE mapi_chunk_export_data SET digest = ?', reservedDigest);
      let before = await owner.snapshot();
      await rejects(() => owner.chunk());
      if (await owner.snapshot() !== before) throw Error('Inconsistent reserved checkpoint changed');
      await owner.change('UPDATE mapi_chunk_export_data SET digest = NULL');
      const finalized = await owner.chunk();
      if (!/^[0-9a-f]{64}$/.test(finalized.digest)) throw Error('Legitimate reserved retry failed');
      const replay = await owner.chunk();
      if (JSON.stringify(replay) !== JSON.stringify(finalized)) throw Error('Valid replay differs');
      for (const digest of [null, '', 'malformed']) {
        await owner.change('UPDATE mapi_chunk_export_data SET digest = ?', digest);
        before = await owner.snapshot();
        await rejects(() => owner.chunk());
        if (await owner.snapshot() !== before) throw Error('Rejected finalized replay changed state');
      }
      await owner.change('UPDATE mapi_chunk_export_data SET digest = ?, content = ?', finalized.digest, 'corrupt');
      before = await owner.snapshot();
      await rejects(() => owner.chunk());
      if (await owner.snapshot() !== before) throw Error('Corrupt finalized replay changed state');
      const changedContent = finalized.content.replace('original', 'tampered');
      if (changedContent === finalized.content) throw Error('Expected fixture content not found');
      const changedBytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(changedContent));
      const changedDigest = [...new Uint8Array(changedBytes)].map(byte => byte.toString(16).padStart(2, '0')).join('');
      await owner.change('UPDATE mapi_chunk_export_data SET digest = ?, content = ?', changedDigest, changedContent);
      before = await owner.snapshot();
      await rejects(() => owner.chunk());
      if (await owner.snapshot() !== before) throw Error('Changed predecessor replay changed state');
      await owner.change('DELETE FROM mapi_chunk_export_data');
      before = await owner.snapshot();
      await rejects(() => owner.chunk());
      if (await owner.snapshot() !== before) throw Error('Missing finalized replay changed state');
      const concurrent = env.OWNER.getByName(`${id}-concurrent`);
      await concurrent.setup();
      const [first, second] = await Promise.all([concurrent.chunk(), concurrent.chunk()]);
      if (JSON.stringify(first) !== JSON.stringify(second)) throw Error('Concurrent identical export retries differ');
      const racing = env.OWNER.getByName(`${id}-race`);
      await racing.setup(65);
      const predecessor = await racing.chunkAt(0);
      const altered = predecessor.content.replace('original', 'tampered');
      if (altered === predecessor.content) throw Error('Expected race fixture content not found');
      const alteredBytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(altered));
      const alteredDigest = [...new Uint8Array(alteredBytes)].map(byte => byte.toString(16).padStart(2, '0')).join('');
      await racing.change('UPDATE mapi_chunk_export_data SET content = ?, digest = ? WHERE chunk_index = 0', altered, alteredDigest);
      const held = await racing.startHeldReplay();
      // If preflight rejected immediately, the second chunk still must work;
      // if hashing was reached, advance the source before releasing the hash.
      await racing.chunkAt(1);
      const beforeRaceResult = await racing.snapshot();
      const outcome = await racing.finishHeldReplay();
      if (!outcome.rejected) throw Error(`Tampered replay accepted after cursor advance (held=${held})`);
      if (await racing.snapshot() !== beforeRaceResult) throw Error('Rejected racing replay changed state');
      const validRace = env.OWNER.getByName(`${id}-valid-race`);
      await validRace.setup(65);
      const validPredecessor = await validRace.chunkAt(0);
      if (!(await validRace.startHeldReplay())) throw Error('Valid replay did not reach digest barrier');
      await validRace.chunkAt(1);
      const beforeValidResult = await validRace.snapshot();
      const validOutcome = await validRace.finishHeldReplay();
      if (validOutcome.rejected || JSON.stringify(validOutcome.value) !== JSON.stringify(validPredecessor)) throw Error('Valid racing replay failed');
      if (await validRace.snapshot() !== beforeValidResult) throw Error('Valid racing replay changed state');
      return Response.json({ ok: true });
    } catch (error) { return Response.json({ error: String(error?.stack ?? error) }, { status: 500 }); }
  },
};
