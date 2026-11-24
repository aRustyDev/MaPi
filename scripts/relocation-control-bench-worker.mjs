// Local-only control-path microbenchmark. It does not transfer project data.
import { DurableObject } from 'cloudflare:workers';
import { beginChunkImport } from '../worker/relocation-chunks.js';

const digest = 'a'.repeat(64);
export class ControlProbe extends DurableObject {
  prepare(count) {
    if (this.env.MAPI_LOCAL_TEST !== '1' || ![0, 2048].includes(count)) throw Error('Local fixture only');
    const storage = this.ctx.storage, sql = storage.sql;
    sql.exec('CREATE TABLE users (id TEXT PRIMARY KEY)');
    beginChunkImport(storage, 'project', 1, 'move', `control-${count}`, ['users']);
    storage.transactionSync(() => {
      for (let index = 0; index < count; index++) sql.exec('INSERT INTO mapi_chunk_import_data VALUES (?, ?, ?)', 'project', index, digest);
      sql.exec('UPDATE mapi_chunk_import SET next_chunk = ?, chain = ? WHERE project_id = ?', count, count ? digest : '', 'project');
    });
    return true;
  }
  check(count) {
    if (this.env.MAPI_LOCAL_TEST !== '1' || ![0, 2048].includes(count)) throw Error('Local fixture only');
    beginChunkImport(this.ctx.storage, 'project', 1, 'move', `control-${count}`, ['users']);
    return true;
  }
}
export default { async fetch(request, env) {
  if (env.MAPI_LOCAL_TEST !== '1' || new URL(request.url).hostname !== '127.0.0.1' || request.method !== 'POST') return new Response(null, {status: 404});
  const value = await request.json();
  if (![0, 2048].includes(value.count) || !['prepare', 'check'].includes(value.action)) return new Response(null, {status: 400});
  const object = env.PROBE.getByName(`control-${value.count}`);
  return Response.json({ok: await object[value.action](value.count)});
} };
