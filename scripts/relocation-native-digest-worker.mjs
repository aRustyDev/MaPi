import { DurableObject } from 'cloudflare:workers';
import { digestRelocationPage } from '../worker/relocation-manifest.js';

const route = { projectId: 'native-digest', origin: 'https://native.example', objectName: 'source', generation: 1 };
const manifest = { version: 1, ...route, moveId: 'move', tables: ['large_fixture', 'small_fixture'] };

export class DigestFixture extends DurableObject {
  setup() {
    const sql = this.ctx.storage.sql;
    sql.exec('CREATE TABLE mapi_owner_fence (singleton INTEGER PRIMARY KEY, project_id TEXT, origin TEXT, object_name TEXT, generation INTEGER, state TEXT, move_id TEXT)');
    sql.exec("INSERT INTO mapi_owner_fence VALUES (1, ?, ?, ?, 1, 'frozen', 'move')", route.projectId, route.origin, route.objectName);
    sql.exec('CREATE TABLE mapi_relocation_project (project_id TEXT PRIMARY KEY, object_name TEXT, generation INTEGER, state TEXT, move_id TEXT)');
    sql.exec("INSERT INTO mapi_relocation_project VALUES (?, 'target', 2, 'staged', 'move')", route.projectId);
    sql.exec('CREATE TABLE large_fixture (id TEXT PRIMARY KEY, value TEXT, data BLOB, number INTEGER, absent TEXT)');
    const value = 'a'.repeat(65535) + 'é😀' + 'z'.repeat(90000);
    const data = new Uint8Array(70000);
    for (let i = 0; i < data.length; i++) data[i] = i % 251;
    sql.exec('INSERT INTO large_fixture VALUES (?, ?, ?, 9223372036854775807, NULL)', 'key', value, data.buffer);
    sql.exec('CREATE TABLE small_fixture (id INTEGER PRIMARY KEY, value TEXT)');
    sql.exec("INSERT INTO small_fixture VALUES (1, 'small')");
  }
  digest(role, table, cursor) { return digestRelocationPage(this.ctx.storage, manifest, role, table, cursor); }
}

export default {
  async fetch(request, env) {
    const source = env.PROJECT.getByName('source');
    const destination = env.PROJECT.getByName('destination');
    await source.setup();
    await destination.setup();
    const result = {};
    for (const table of manifest.tables) {
      let cursor = null;
      const pages = [];
      for (;;) {
        const left = await source.digest('source', table, cursor);
        const right = await destination.digest('destination', table, cursor);
        if (JSON.stringify(left) !== JSON.stringify(right)) throw Error('Owner digest differs');
        pages.push(left);
        if (left.done) break;
        if (pages.length > 100) throw Error('Digest did not finish');
        cursor = left.cursor;
      }
      result[table] = pages;
    }
    return Response.json(result);
  },
};
