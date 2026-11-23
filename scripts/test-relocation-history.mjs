// Local synthetic transfer-journal test. It has no Wrangler config or hosted
// target and does not exercise the real Go owner or a project cutover.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

const secret = randomBytes(32).toString('base64url');
const source = `
import { DurableObject } from 'cloudflare:workers';
import { initializeProjectFence, freezeProject } from './worker/relocation.js';
import { beginChunkExport, exportChunk, beginChunkImport, importChunk, chunkImportStatus } from './worker/relocation-chunks.js';
import { restoreRelocationMetadata } from './worker/relocation-manifest.js';
import { transferHistoryStatus, sourceTransferHistory, destinationTransferHistory } from './worker/relocation-history.js';
const sourceRoute = { projectId:'project', origin:'https://synthetic.invalid', objectName:'source', generation:1 };
const targetRoute = { ...sourceRoute, objectName:'target' };
const rejects = async fn => { try { await fn(); } catch { return; } throw Error('Expected history rejection'); };
export class Owner extends DurableObject {
  setupSource() {
    this.ctx.storage.sql.exec('CREATE TABLE users (id TEXT PRIMARY KEY, data BLOB NOT NULL)');
    for (let i = 0; i < 128; i++) this.ctx.storage.sql.exec('INSERT INTO users VALUES (?, ?)', 'user-' + String(i).padStart(3, '0'), new Uint8Array(2048));
    initializeProjectFence(this.ctx.storage, 'project', 'source', 1);
    freezeProject(this.ctx.storage, 'project', 1, 'move');
    beginChunkExport(this.ctx.storage, 'project', 1, 'move', ['users']);
  }
  setupTarget() {
    this.ctx.storage.sql.exec('CREATE TABLE users (id TEXT PRIMARY KEY, data BLOB NOT NULL)');
    this.ctx.storage.sql.exec('CREATE TABLE mapi_schema_version (version INTEGER NOT NULL)');
    this.ctx.storage.sql.exec('INSERT INTO mapi_schema_version VALUES (1)');
    this.ctx.storage.sql.exec('CREATE TABLE mapi_project_origin (origin TEXT NOT NULL)');
    this.ctx.storage.sql.exec('CREATE TABLE mapi_recovery_epoch (epoch TEXT NOT NULL)');
    this.ctx.storage.sql.exec("INSERT INTO mapi_recovery_epoch VALUES ('old')");
    this.ctx.storage.sql.exec('CREATE TABLE goose_db_version (id INTEGER PRIMARY KEY AUTOINCREMENT)');
    beginChunkImport(this.ctx.storage, 'project', 1, 'move', 'target', ['users']);
  }
  exportChunk(index) { return exportChunk(this.ctx.storage, 'project', 1, 'move', index); }
  importChunk(chunk) { return importChunk(this.ctx.storage, 'project', chunk); }
  importStatus() { return chunkImportStatus(this.ctx.storage, 'project'); }
  sourceStatus(digest) { return transferHistoryStatus(this.ctx.storage, 'source', sourceRoute, 'move', digest); }
  targetStatus(digest) { return transferHistoryStatus(this.ctx.storage, 'destination', targetRoute, 'move', digest); }
  sourceHistory(digest, index) { return sourceTransferHistory(this.ctx.storage, sourceRoute, 'move', digest, index); }
  targetHistory(digest, index) { return destinationTransferHistory(this.ctx.storage, targetRoute, 'move', digest, index); }
  restoreMetadata() { return restoreRelocationMetadata(this.ctx.storage, { projectId:'project', generation:1, moveId:'move', schemaVersion:1, origin:sourceRoute.origin, recoveryEpoch:'new', sequences:[] }); }
  extraReceipt(index) { this.ctx.storage.sql.exec('INSERT INTO mapi_chunk_import_data VALUES (?, ?, ?)', 'project', index, 'a'.repeat(64)); }
  removeReceipt(index) { this.ctx.storage.sql.exec('DELETE FROM mapi_chunk_import_data WHERE project_id=? AND chunk_index=?', 'project', index); }
  extraSource(index) { this.ctx.storage.sql.exec('INSERT INTO mapi_chunk_export_data VALUES (?, ?, ?, ?)', 'project', index, '{}', 'a'.repeat(64)); }
  deleteReceipt(index) { this.ctx.storage.sql.exec('DELETE FROM mapi_chunk_import_data WHERE project_id=? AND chunk_index=?', 'project', index); }
  alterSource(index) { this.ctx.storage.sql.exec('UPDATE mapi_chunk_export_data SET content=? WHERE project_id=? AND chunk_index=?', '{}', 'project', index); }
}
export default { async fetch(request, env) {
  if (new URL(request.url).hostname !== '127.0.0.1' || request.headers.get('authorization') !== 'Bearer ' + env.TEST_SECRET) return new Response(null, { status:404 });
  try {
    const source = env.OWNER.getByName('source'), target = env.OWNER.getByName('target');
    await source.setupSource(); await target.setupTarget();
    let index = 0, final;
    for (;;) {
      const chunk = await source.exportChunk(index); await target.importChunk(chunk); index++;
      if ((await target.importStatus()).done) { final = chunk.digest; break; }
      if (index > 20) throw Error('Unexpected synthetic transfer length');
    }
    if (index < 3) throw Error('Synthetic transfer did not exercise intermediate history');
    const a = await source.sourceStatus(final), b = await target.targetStatus(final);
    if (a.total !== index || b.total !== index || a.digest !== final || b.digest !== final) throw Error('History status differs');
    let previous = '';
    for (let i = 0; i < index; i++) {
      const x = await source.sourceHistory(final, i), y = await target.targetHistory(final, i);
      if (x.index !== i || y.index !== i || x.previous !== previous || x.chunkDigest !== y.chunkDigest || x.done !== (i === index - 1)) throw Error('History chain differs');
      previous = x.chunkDigest;
    }
    if (previous !== final) throw Error('History final digest differs');
    await target.restoreMetadata();
    const restored = await target.targetStatus(final);
    if (restored.total !== index || restored.digest !== final) throw Error('Staged history changed after metadata restore');
    if ((await target.targetHistory(final, 0)).chunkDigest !== (await source.sourceHistory(final, 0)).chunkDigest) throw Error('Restored metadata changed history');
    await target.extraReceipt(0.5);
    await rejects(() => target.targetHistory(final, 1));
    await target.removeReceipt(0.5);
    await source.extraSource(index - 0.5);
    await rejects(() => source.sourceHistory(final, index - 1));
    await target.deleteReceipt(1);
    await rejects(() => target.targetHistory(final, 1));
    await source.alterSource(1);
    await rejects(() => source.sourceHistory(final, 1));
    await rejects(() => source.sourceHistory(final, index));
    return Response.json({ ok:true, chunks:index });
  } catch { return Response.json({ ok:false }, { status:500 }); }
} };
`;
const result = await build({ stdin: { contents: source, resolveDir: process.cwd(), sourcefile: 'synthetic-relocation-history.js', loader: 'js' }, bundle:true, write:false, format:'esm', platform:'neutral', target:'es2022', external:['cloudflare:workers'] });
const mf = new Miniflare(convertV4MiniflareOptions({ workers: [{ name:'synthetic-transfer-history', compatibilityDate:'2026-11-19', modules:[{ type:'ESModule', path:'worker.js', contents:result.outputFiles[0].text }], durableObjects:{ OWNER:{ className:'Owner', useSQLite:true } }, bindings:{ TEST_SECRET:secret } }], host:'127.0.0.1', port:0, telemetry:{ enabled:false } }));
try {
  const response = await mf.dispatchFetch('http://127.0.0.1/', { headers:{ authorization:'Bearer ' + secret } });
  assert.equal(response.status, 200, 'Synthetic history verification failed');
  const body = await response.json();
  assert.equal(body.ok, true); assert.ok(body.chunks >= 3);
  console.log(`Synthetic transfer history verified across ${body.chunks} chunks`);
} finally { await mf.dispose(); }
