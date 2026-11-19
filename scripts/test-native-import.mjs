import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { startLocalZitadel, bootstrapProject, connectZitadel } from '@zitadel/testing';
import { client } from './parity.mjs';

const quote = name => '"' + name.replaceAll('"', '""') + '"';
function literal(value) {
  if (value === null) return 'NULL';
  if (typeof value === 'bigint' || typeof value === 'number') return String(value);
  if (value instanceof Uint8Array) return "X'" + Buffer.from(value).toString('hex') + "'";
  if (value.includes('\0')) return "CAST(X'" + Buffer.from(value).toString('hex') + "' AS TEXT)";
  return "'" + value.replaceAll("'", "''") + "'";
}
function snapshot(db) {
  const objects = db.prepare("SELECT name,type,sql FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY rowid").all();
  const tables = objects.filter(x => x.type === 'table');
  const statements = tables.map(x => x.sql);
  for (const table of tables) {
    const columns = db.prepare(`PRAGMA table_xinfo(${quote(table.name)})`).all().filter(x => x.hidden === 0).map(x => quote(x.name)).join(', ');
    const query = db.prepare(`SELECT ${columns} FROM ${quote(table.name)}`); query.setReadBigInts(true);
    for (const row of query.iterate()) statements.push(`INSERT INTO ${quote(table.name)} (${columns}) VALUES (${Object.values(row).map(literal).join(', ')})`);
  }
  return statements.concat(objects.filter(x => x.type !== 'table').map(x => x.sql));
}
async function port() {
  const socket = createServer().listen(0, '127.0.0.1'); await once(socket, 'listening');
  const p = socket.address().port; await new Promise(done => socket.close(done)); return p;
}
const directory = await mkdtemp(resolve(tmpdir(), 'mapi-native-import-'));
const generated = ['worker/generated/native-import-object.js', 'worker/generated/native-import-fixture.json'];
let native, server, db, stderr = '';
try {
  native = await startLocalZitadel({ dir: resolve(directory, 'native'), projectName: 'Synthetic native import' });
  const user = await native.seedUser();
  const other = { ...native.handle, ...await bootstrapProject({ baseUrl: native.handle.baseUrl, projectName: 'Second synthetic native project' }) };
  const fixture = { ...native.handle, user, otherProjectId: other.projectId, otherProjectSecret: other.projectSecret };
  const original = client(native.handle.baseUrl, fixture);
  assert.equal((await original.send('POST', '/auth_attempts', { body: { project_id: other.projectId }, token: other.projectSecret })).status, 201);
  const otherUser = await connectZitadel(other).seedUser();
  const foreign = client(native.handle.baseUrl, { ...other, user: otherUser });
  const foreignSession = foreign.session(await foreign.exchange(await foreign.mint()));
  const foreignCsrf = foreign.ok(await foreign.send('GET', `/sessions/me/csrf?project_id=${encodeURIComponent(other.projectId)}`, { token: null, cookie: foreignSession.cookie })).csrf_token;
  assert.ok(foreignCsrf);
  const foreignHandoff = await foreign.mint();
  const foreignAttempt = await foreign.start();
  const foreignChallenge = foreign.ok(await foreign.send('POST', `/auth_attempts/${foreignAttempt}/challenges`, { body: { method: 'identifier' } }));
  const active = original.session(await original.exchange(await original.mint()));
  const revoked = original.session(await original.exchange(await original.mint()));
  assert.equal((await original.revoke(revoked)).status, 204);
  const pending = await original.mint();
  const keysDir = resolve(directory, 'native/.zitadel/local/nextgen-data/master-keys');
  const keys = await readdir(keysDir); assert.equal(keys.length, 1);
  const master = { id: keys[0], pem: await readFile(resolve(keysDir, keys[0]), 'utf8') };
  // Stop the source before reading: this is a quiesced single-database snapshot.
  await native.stop(); native = undefined;
  db = new DatabaseSync(resolve(directory, 'native/.zitadel/local/nextgen-data/zitadel.db'), { readOnly: true });
  const statements = snapshot(db);
  const auditQuery = db.prepare('SELECT * FROM events WHERE project_id=? ORDER BY id'); auditQuery.setReadBigInts(true);
  const auditObjects = auditQuery.all(fixture.projectId);
  const auditColumns = auditQuery.columns().map(x => x.name);
  const auditRows = auditObjects.map(row => auditColumns.map(column => {
    const value = row[column];
    if (typeof value === 'bigint') return { integer: value.toString() };
    if (value instanceof Uint8Array) return { blob: Buffer.from(value).toString('base64') };
    return value;
  }));
  const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  const auditDigest = digest({ columns: auditColumns, rows: auditRows });
  const sourceUser = db.prepare('SELECT id FROM users WHERE project_id=? AND id=?').get(fixture.projectId, user.id);
  assert.equal(sourceUser?.id, user.id); assert.ok(auditRows.length > 0);
  db.close(); db = undefined;
  // An intentionally small test transport, not an import format for real data.
  assert.ok(statements.length < 10000 && Buffer.byteLength(JSON.stringify(statements)) < 2_000_000);
  await writeFile(generated[1], JSON.stringify({ projectId: fixture.projectId, otherProjectId: fixture.otherProjectId,
    otherUserId: otherUser.id, otherSessionId: foreignSession.id, otherAttemptId: foreignAttempt, statements }), { mode: 0o600 });
  let object = await readFile('worker/index.js', 'utf8');
  object = object.replace('"./generated/nextgen.wasm"', '"./nextgen.wasm"')
    .replace('"./generated/fixture.json"', '"./native-import-fixture.json"')
    .replace('"./wasi.js"', '"../wasi.js"').replace('"./sql.js"', '"../sql.js"');
  const seed = '      for (const statement of fixture.statements) this.ctx.storage.sql.exec(statement);';
  assert.ok(object.includes(seed));
  object = object.replace(seed, '      throw new Error("Native import has not completed");');
  const hook = '  handleRequest(request) {'; assert.ok(object.includes(hook));
  object = object.replace(hook, `  importNative(projectId, failAfter) {\n` +
    `    if (this.env.MAPI_LOCAL_TEST !== '1' || projectId !== fixture.projectId || !Number.isInteger(failAfter) || failAfter < 0) throw new Error('Invalid import');\n` +
    `    this.ctx.storage.transactionSync(() => {\n` +
    `      const sql = this.ctx.storage.sql;\n` +
    `      if (sql.exec("SELECT name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' AND name <> '__miniflare_do_name'").toArray().length) throw new Error('Object is not empty');\n` +
    `      sql.exec('PRAGMA defer_foreign_keys = ON');\n` +
    `      let count = 0; for (const statement of fixture.statements) { sql.exec(statement); if (++count === failAfter) throw new Error('Injected failure'); }\n` +
    `      if (sql.exec('SELECT id FROM projects WHERE id = ?', projectId).toArray().length !== 1) throw new Error('Missing project');\n` +
    `      sql.exec('CREATE TABLE mapi_fixture(version INTEGER PRIMARY KEY)'); sql.exec('INSERT INTO mapi_fixture VALUES (1)');\n` +
    `    });\n` +
    `  }\n` +
    `  importState() {\n` +
    `    const sql = this.ctx.storage.sql; const present = sql.exec("SELECT name FROM sqlite_schema WHERE name = 'mapi_fixture'").toArray().length;\n` +
    `    if (!present) return { imported: false, objects: sql.exec("SELECT name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' AND name <> '__miniflare_do_name'").toArray().length };\n` +
    `    return { imported: true, marker: sql.exec('SELECT COUNT(*) AS n FROM mapi_fixture').one().n, otherProjectRows: sql.exec('SELECT COUNT(*) AS n FROM projects WHERE id=?', fixture.otherProjectId).one().n, otherUserRows: sql.exec('SELECT COUNT(*) AS n FROM users WHERE project_id=? AND id=?', fixture.otherProjectId, fixture.otherUserId).one().n, otherSessionRows: sql.exec('SELECT COUNT(*) AS n FROM sessions WHERE project_id=? AND id=?', fixture.otherProjectId, fixture.otherSessionId).one().n, otherAttemptRows: sql.exec('SELECT COUNT(*) AS n FROM auth_attempts WHERE project_id=? AND id=?', fixture.otherProjectId, fixture.otherAttemptId).one().n, audit: execute(this.ctx.storage, { statement: 'SELECT * FROM events WHERE project_id=? ORDER BY id', args: [{kind:'text',value:fixture.projectId}], query:true }) };\n` +
    `  }\n` +
    `  evictImport() { this.ctx.abort('test eviction'); }\n\n${hook}`);
  await writeFile(generated[0], object, { mode: 0o600 });
  const environment = resolve(directory, 'test.env');
  await writeFile(environment, `MAPI_LOCAL_TEST=1\nMAPI_MASTER_KEY=${Buffer.from(JSON.stringify(master)).toString('base64')}\n`, { mode: 0o600 });
  const p = await port(), inspector = await port();
  server = spawn(process.execPath, [resolve('node_modules/wrangler/bin/wrangler.js'), 'dev', '--local', '--config', 'scripts/native-import-test.wrangler.jsonc', '--env-file', environment, '--ip', '127.0.0.1', '--port', String(p), '--inspector-port', String(inspector), '--persist-to', resolve(directory, 'state')],
    { stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, WRANGLER_LOG_PATH: resolve(directory, 'wrangler.log'), WRANGLER_SEND_METRICS: 'false' } });
  server.stderr.on('data', data => { stderr = (stderr + data.toString()).slice(-8000); });
  const base = `http://127.0.0.1:${p}`;
  for (let i = 0; ; i++) { if (server.exitCode !== null || i === 100) throw Error('workerd not ready'); try { await fetch(base + '/__test/state'); break; } catch { await setTimeout(200); } }
  const request = (path, options = {}) => fetch(base + path, options);
  const imported = client(base, fixture);
  assert.equal((await imported.read(active)).status, 503, 'unimported object served state');
  const sendImport = (projectId, failAfter) => request('/__test/import', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ projectId, failAfter }) });
  assert.equal((await sendImport('proj_wrong', 0)).status, 409);
  assert.equal((await sendImport(fixture.projectId, 20)).status, 409);
  assert.deepEqual(await (await request('/__test/state')).json(), { imported: false, objects: 0 }, 'failed import persisted schema');
  assert.equal((await sendImport(fixture.projectId, 0)).status, 200);
  const state = await (await request('/__test/state')).json();
  assert.equal(state.imported, true); assert.equal(state.marker, 1);
  for (const field of ['otherProjectRows', 'otherUserRows', 'otherSessionRows', 'otherAttemptRows']) assert.equal(state[field], 1, `${field}: fixture must expose whole-database import limitation`);
  assert.equal(digest(state.audit), auditDigest, 'native audit records changed on import');
  assert.equal((await sendImport(fixture.projectId, 0)).status, 409, 'existing object accepted duplicate import');
  const otherClient = client(base, { ...other, user: otherUser });
  const foreignOperations = [
    () => otherClient.send('POST', '/auth_attempts', { body: { project_id: other.projectId } }),
    () => otherClient.send('POST', `/auth_attempts/${foreignAttempt}/challenges`, { body: { method: 'password' } }),
    () => otherClient.send('POST', `/auth_attempts/${foreignAttempt}/challenges/${foreignChallenge.challenge_id}/verify`, { body: { login_name: otherUser.email } }),
    () => otherClient.send('POST', `/auth_attempts/${foreignAttempt}/handoff`),
    () => otherClient.exchange(foreignHandoff),
    () => otherClient.read(foreignSession),
    () => otherClient.send('GET', `/sessions/me/csrf?project_id=${encodeURIComponent(other.projectId)}`, { token: null, cookie: foreignSession.cookie }),
    () => fetch(`${base}/sessions/me?project_id=${encodeURIComponent(other.projectId)}`, { method: 'DELETE', headers: { cookie: foreignSession.cookie, origin: base, 'x-zitadel-csrf': foreignCsrf } }),
    () => otherClient.revoke(foreignSession),
  ];
  const foreignStatuses = [];
  for (const operation of foreignOperations) {
    const response = await operation();
    foreignStatuses.push(response.status);
    assert.ok(response.status >= 400 && response.status < 500, `foreign-project operation returned ${response.status}`);
  }
  assert.deepEqual(foreignStatuses, [403, 403, 403, 403, 403, 401, 401, 401, 403], 'foreign-project route behavior changed');
  const mixedScope = [
    () => imported.send('POST', '/auth_attempts', { body: { project_id: other.projectId } }),
    () => imported.send('POST', '/auth_attempts', { body: { project_id: fixture.projectId }, token: other.projectSecret }),
    () => imported.send('GET', `/sessions/me?project_id=${encodeURIComponent(fixture.projectId)}`, { token: null, cookie: foreignSession.cookie }),
  ];
  for (const operation of mixedScope) {
    const response = await operation();
    assert.ok(response.status >= 400 && response.status < 500, `mixed-project request returned ${response.status}`);
  }
  assert.equal((await imported.read(active)).status, 200, 'active source session lost');
  assert.equal((await imported.read(revoked)).status, 401, 'revoked source session revived');
  const exchanged = await imported.exchange(pending); const pendingSession = imported.session(exchanged);
  assert.ok((await imported.exchange(pending)).status >= 400, 'pending handoff replay succeeded');
  const newSession = imported.session(await imported.exchange(await imported.mint()));
  assert.equal((await imported.read(newSession)).status, 200, 'imported password credential did not authenticate');
  assert.equal((await imported.revoke(active)).status, 204);
  assert.equal((await imported.read(active)).status, 401, 'revocation was not authoritative');
  assert.equal((await request('/__test/evict', { method: 'POST' })).status, 503);
  assert.equal((await imported.read(active)).status, 401, 'revocation lost on eviction');
  assert.equal((await imported.read(revoked)).status, 401, 'source revocation lost on eviction');
  assert.equal((await imported.read(pendingSession)).status, 200, 'imported handoff session lost on eviction');
  assert.equal((await imported.read(newSession)).status, 200, 'new session lost on eviction');
  assert.equal((await (await request('/__test/state')).json()).marker, 1, 'import marker duplicated');
  console.log('Native SQLite snapshot imported locally; user/password, active and revoked sessions, one-time handoff, audit, conflict, rollback and eviction passed.');
} catch (error) { if (stderr) console.error(stderr); throw error; }
finally {
  db?.close(); if (native) await native.stop();
  if (server && server.exitCode === null && server.signalCode === null) { const done = once(server, 'exit'); server.kill('SIGTERM'); await done; }
  await Promise.all(generated.map(path => rm(path, { force: true })));
  await rm(directory, { recursive: true, force: true });
}
