// Native/workerd test of the pinned generated TypeScript client. Synthetic data only.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout } from 'node:timers/promises';
import { startLocalZitadel, bootstrapProject } from '@zitadel/testing';
import { createZitadelClient } from '@zitadel/api/client';
import { ApiError, apiErrorCode } from '@zitadel/api/runtime/fetch';

const packageInfo = JSON.parse(await readFile(resolve('node_modules/@zitadel/api/package.json'), 'utf8'));
assert.equal(packageInfo.version, '0.7.0', 'SDK must match pinned Nextgen');
const quote = (name) => '"' + name.replaceAll('"', '""') + '"';
const literal = (v) => v === null ? 'NULL' : typeof v === 'bigint' || typeof v === 'number' ? String(v) :
  v instanceof Uint8Array ? "X'" + Buffer.from(v).toString('hex') + "'" :
  v.includes('\0') ? "CAST(X'" + Buffer.from(v).toString('hex') + "' AS TEXT)" : "'" + v.replaceAll("'", "''") + "'";
function exportFixture(db) {
  const schema = db.prepare("SELECT name, type, sql FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY rowid").all();
  const tables = schema.filter((s) => s.type === 'table'), statements = tables.map((s) => s.sql);
  for (const { name } of tables) {
    const columns = db.prepare(`PRAGMA table_xinfo(${quote(name)})`).all().filter((c) => c.hidden === 0).map((c) => quote(c.name)).join(', ');
    const rows = db.prepare(`SELECT ${columns} FROM ${quote(name)}`); rows.setReadBigInts(true);
    for (const row of rows.iterate()) statements.push(`INSERT INTO ${quote(name)} (${columns}) VALUES (${Object.values(row).map(literal).join(', ')})`);
  }
  return statements.concat(schema.filter((s) => s.type !== 'table').map((s) => s.sql));
}
async function port() {
  const socket = createServer().listen(0, '127.0.0.1'); await once(socket, 'listening');
  const { port } = socket.address(); await new Promise((done) => socket.close(done)); return port;
}
async function failure(call) {
  try { await call(); throw Error('Expected an SDK error'); }
  catch (error) { if (!(error instanceof ApiError)) throw error; return { status: error.status, code: apiErrorCode(error) ?? null }; }
}

const dir = await mkdtemp(resolve(tmpdir(), 'mapi-sdk-api-'));
let native, server;
const fixturePath = 'worker/generated/sdk-api-fixture.json', objectPath = 'worker/generated/sdk-api-test-object.js';
try {
  native = await startLocalZitadel({ dir: resolve(dir, 'native'), projectName: 'Synthetic SDK API parity' });
  const users = await native.seedUsers(3);
  const foreign = await bootstrapProject({ baseUrl: native.handle.baseUrl, projectName: 'Synthetic SDK foreign project' });
  const data = resolve(dir, 'native/.zitadel/local/nextgen-data');
  const db = new DatabaseSync(resolve(data, 'zitadel.db')); let statements;
  try { statements = exportFixture(db); } finally { db.close(); }
  const keyDir = resolve(data, 'master-keys'), keys = await readdir(keyDir); assert.equal(keys.length, 1);
  const key = { id: keys[0], pem: await readFile(resolve(keyDir, keys[0]), 'utf8') };
  await writeFile(fixturePath, JSON.stringify({ projectId: native.handle.projectId, statements }), { mode: 0o600 });
  const object = (await readFile('worker/generated/management-test-object.js', 'utf8')).replace('"./fixture.json"', '"./sdk-api-fixture.json"');
  if (!object.includes('"./sdk-api-fixture.json"')) throw Error('Management fixture anchor changed');
  await writeFile(objectPath, object, { mode: 0o600 });
  const envPath = resolve(dir, 'vars');
  await writeFile(envPath, `MAPI_MASTER_KEY=${Buffer.from(JSON.stringify(key)).toString('base64')}\nMAPI_LOCAL_TEST=1\n`, { mode: 0o600 });
  const p = await port(), inspector = await port();
  server = spawn(process.execPath, [resolve('node_modules/wrangler/bin/wrangler.js'), 'dev', '--local', '--config', 'scripts/sdk-api-test.wrangler.jsonc', '--env-file', envPath, '--ip', '127.0.0.1', '--port', String(p), '--inspector-port', String(inspector), '--persist-to', resolve(dir, 'state')],
    { stdio: ['ignore', 'ignore', 'ignore'], env: { ...process.env, WRANGLER_LOG_PATH: resolve(dir, 'wrangler.log'), WRANGLER_SEND_METRICS: 'false' } });
  const worker = `http://127.0.0.1:${p}`;
  for (let i = 0; ; i++) { if (server.exitCode !== null || i === 100) throw Error('workerd unavailable'); try { await fetch(worker + '/livez'); break; } catch { await setTimeout(200); } }

  const project = native.handle.projectId, secret = native.handle.projectSecret;
  async function exercise(base) {
    let transformed = 0, errors = 0;
    const api = createZitadelClient({ baseUrl: base, token: secret, onResponse: (body) => { transformed++; return body; } });
    const deny = createZitadelClient({ baseUrl: base, onError: (error) => { errors++; throw error; } });
    const scoped = createZitadelClient({ baseUrl: base, token: foreign.projectSecret });
    const first = await api.queryUsers({ limit: 1 }, { project_id: project });
    assert.equal(first.users.length, 1); assert.ok(first.next_page_token, 'fixture must span pages');
    const pages = []; for await (const page of api.queryUsers.pages({ limit: 1 }, { project_id: project })) pages.push(page);
    const paged = []; for await (const item of api.queryUsers.items({ limit: 1 }, { project_id: project })) paged.push(item);
    const all = await api.queryUsers.all({ limit: 1 }, { project_id: project });
    const ids = (values) => values.map((v) => v.id).sort();
    assert.ok(pages.length >= 3); assert.equal(new Set(ids(all)).size, all.length, 'duplicate pagination item'); assert.deepEqual(ids(paged), ids(all));
    assert.deepEqual(ids(pages.flatMap((page) => page.users)), ids(all));
    for (const u of users) assert.ok(ids(all).includes(u.id));
    assert.equal((await api.getUser(users[0].id)).id, users[0].id);
    const missing = await failure(() => api.getUser('user_00000000000000000000000000'));
    const badCursor = await failure(() => api.queryUsers({ page_token: 'not-a-valid-cursor' }, { project_id: project }));
    const noCredential = await failure(() => deny.getUser(users[0].id));
    const foreignCredential = await failure(() => scoped.queryUsers({}, { project_id: project }));
    assert.equal(missing.status, 404); assert.equal(badCursor.status, 400); assert.equal(noCredential.status, 401);
    assert.ok(foreignCredential.status >= 400 && foreignCredential.status < 500);
    const raced = await Promise.all(Array.from({ length: 16 }, (_, i) => i % 2 ? failure(() => deny.getUser(users[0].id)) : api.getUser(users[0].id)));
    for (let i = 0; i < raced.length; i++) if (i % 2) assert.equal(raced[i].status, noCredential.status); else assert.equal(raced[i].id, users[0].id);
    assert.ok(transformed >= pages.length * 3 && errors >= 9, 'response/error hooks not invoked');
    return { ids: ids(all), pages: pages.length, missing, badCursor, noCredential, foreignCredential };
  }
  const nativeResult = await exercise(native.handle.baseUrl);
  const workerResult = await exercise(worker);
  assert.deepEqual(workerResult, nativeResult, 'generated client behavior differs');
  // The documented base URL may already end with the API prefix.
  const prefixed = createZitadelClient({ baseUrl: `${worker}/api/v1`, token: secret });
  assert.equal((await prefixed.getUser(users[0].id)).id, users[0].id);
  console.log(`Pinned @zitadel/api 0.7.0: native/workerd user reads, ${workerResult.pages} cursor pages, SDK hooks, auth errors and concurrent credential isolation passed.`);
} finally {
  if (server && server.exitCode === null && server.signalCode === null) { const stop = once(server, 'exit'); server.kill('SIGTERM'); await stop; }
  if (native) await native.stop();
  await rm(fixturePath, { force: true }); await rm(objectPath, { force: true }); await rm(dir, { recursive: true, force: true });
}
