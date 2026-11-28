import { DurableObject } from 'cloudflare:workers';
import { digestRelocationPage } from '../worker/relocation-manifest.js';
import { readRelocationBlobSlice } from '../worker/sql.js';

const route = { projectId: 'native-digest', origin: 'https://native.example', objectName: 'source', generation: 1 };
const manifest = { version: 1, ...route, moveId: 'move', tables: ['large_fixture', 'small_fixture', 'typed_fixture', 'empty_fixture', 'wide_fixture'] };

export class DigestFixture extends DurableObject {
  setup() {
    const sql = this.ctx.storage.sql;
    sql.exec('CREATE TABLE mapi_owner_fence (singleton INTEGER PRIMARY KEY, project_id TEXT, origin TEXT, object_name TEXT, generation INTEGER, state TEXT, move_id TEXT)');
    sql.exec("INSERT INTO mapi_owner_fence VALUES (1, ?, ?, ?, 1, 'frozen', 'move')", route.projectId, route.origin, route.objectName);
    sql.exec('CREATE TABLE mapi_relocation_project (project_id TEXT PRIMARY KEY, object_name TEXT, generation INTEGER, state TEXT, move_id TEXT)');
    sql.exec("INSERT INTO mapi_relocation_project VALUES (?, 'target', 2, 'staged', 'move')", route.projectId);
    sql.exec('CREATE TABLE large_fixture (id TEXT PRIMARY KEY, value TEXT, data BLOB, number INTEGER, absent TEXT)');
    const data = new Uint8Array(70000);
    for (let i = 0; i < data.length; i++) data[i] = i % 251;
    sql.exec("INSERT INTO large_fixture VALUES (?, ? || 'é😀' || replace(hex(zeroblob(?)), '00', 'zz') || 'z', ?, 9223372036854775807, NULL)", 'key', 'a'.repeat(65535), 4117229, data.buffer);
    sql.exec('CREATE TABLE small_fixture (id INTEGER PRIMARY KEY, value TEXT)');
    sql.exec("INSERT INTO small_fixture VALUES (1, 'small')");
    sql.exec('CREATE TABLE typed_fixture (number INTEGER NOT NULL, binary_key BLOB NOT NULL, value TEXT NOT NULL, PRIMARY KEY(number, binary_key))');
    sql.exec("INSERT INTO typed_fixture VALUES (-9223372036854775808, X'0080', 'small'), (9223372036854775807, X'00FF', replace(hex(zeroblob(32769)), '00', 'zz'))");
    sql.exec('CREATE TABLE empty_fixture (id TEXT PRIMARY KEY, value TEXT)');
    sql.exec('CREATE TABLE wide_fixture (id INTEGER PRIMARY KEY, ' + Array.from({length: 99}, (_, i) => 'c' + i).join(', ') + ')');
    sql.exec('INSERT INTO wide_fixture VALUES (' + ['1', ...Array.from({length: 99}, (_, i) => i % 4 === 0 ? "'text'" : i % 4 === 1 ? "X'00FF'" : i % 4 === 2 ? '1.25' : '9223372036854775807')].join(', ') + ')');
    sql.exec('CREATE TABLE key_probe (id INTEGER PRIMARY KEY, value BLOB)');
    sql.exec("INSERT INTO key_probe VALUES (9223372036854775807, X'0080FF')");
    sql.exec('CREATE TABLE blob_key_probe (id BLOB PRIMARY KEY, value BLOB)');
    sql.exec("INSERT INTO blob_key_probe VALUES (X'0080FF', X'AA00')");
    sql.exec('CREATE TABLE malformed_fixture (id TEXT PRIMARY KEY, value TEXT)');
    sql.exec("INSERT INTO malformed_fixture VALUES ('bad', CAST(zeroblob(65535) || X'80' AS TEXT))");
    sql.exec('CREATE TABLE malformed_small (id TEXT PRIMARY KEY, value TEXT)');
    sql.exec("INSERT INTO malformed_small VALUES ('bad', CAST(X'80' AS TEXT))");
  }
  digest(role, table, cursor) { return digestRelocationPage(this.ctx.storage, manifest, role, table, cursor); }
  keySlices() {
    const integer = readRelocationBlobSlice(this.ctx.storage, 'SELECT value FROM key_probe WHERE id = ?', [{kind:'int',value:'9223372036854775807'}]);
    const blob = readRelocationBlobSlice(this.ctx.storage, 'SELECT value FROM blob_key_probe WHERE id = ?', [{kind:'blob',value:'AID/'}]);
    return { integer: integer.toBase64(), blob: blob.toBase64() };
  }
  async rejectMalformed() {
    const smallManifest = { ...manifest, tables: ['malformed_small'] };
    let rejectedSmall = false;
    try { await digestRelocationPage(this.ctx.storage, smallManifest, 'source', 'malformed_small', null); }
    catch (error) { if (!String(error).includes('Invalid UTF-8 TEXT in relocation row')) throw error; rejectedSmall = true; }
    if (!rejectedSmall) return false;
    const badManifest = { ...manifest, tables: ['malformed_fixture'] };
    const first = await digestRelocationPage(this.ctx.storage, badManifest, 'source', 'malformed_fixture', null);
    try { await digestRelocationPage(this.ctx.storage, badManifest, 'source', 'malformed_fixture', first.cursor); }
    catch (error) { if (String(error).includes('Invalid UTF-8 TEXT in relocation row')) return true; throw error; }
    return false;
  }
}

export default {
  async fetch(request, env) {
    const source = env.PROJECT.getByName('source');
    const destination = env.PROJECT.getByName('destination');
    await source.setup();
    await destination.setup();
    const keySlices = await source.keySlices();
    if (keySlices.integer !== 'AID/' || keySlices.blob !== 'qgA=') throw Error('Typed slice binding differs');
    if (!(await source.rejectMalformed())) throw Error('Malformed TEXT was accepted');
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
        if (pages.length > 300) throw Error('Digest did not finish');
        cursor = left.cursor;
      }
      result[table] = pages;
    }
    return Response.json(result);
  },
};
