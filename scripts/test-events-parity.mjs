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
const quote = name => '"' + name.replaceAll('"', '""') + '"';
function literal(v) { if (v === null) return 'NULL'; if (typeof v === 'bigint' || typeof v === 'number') return String(v); if (v instanceof Uint8Array) return "X'" + Buffer.from(v).toString('hex') + "'"; if (v.includes('\0')) return "CAST(X'" + Buffer.from(v).toString('hex') + "' AS TEXT)"; return "'" + v.replaceAll("'", "''") + "'"; }
function exportFixture(db) {
 const schema = db.prepare("SELECT name, type, sql FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY rowid").all(); const tables = schema.filter(s => s.type === 'table'); const statements = tables.map(s => s.sql);
 for (const { name } of tables) { const cols = db.prepare(`PRAGMA table_xinfo(${quote(name)})`).all().filter(c => c.hidden === 0).map(c => quote(c.name)).join(', '); const rows = db.prepare(`SELECT ${cols} FROM ${quote(name)}`); rows.setReadBigInts(true); for (const row of rows.iterate()) statements.push(`INSERT INTO ${quote(name)} (${cols}) VALUES (${Object.values(row).map(literal).join(', ')})`); }
 return statements.concat(schema.filter(s => s.type !== 'table').map(s => s.sql));
}
async function port() { const socket = createServer().listen(0, '127.0.0.1'); await once(socket, 'listening'); const n = socket.address().port; await new Promise(done => socket.close(done)); return n; }
const dir = await mkdtemp(resolve(tmpdir(), 'mapi-events-')); let native, server, diagnostics = '';
try {
 native = await startLocalZitadel({ dir: resolve(dir, 'native'), projectName: 'Events parity' }); await native.seedUser();
 const other = await bootstrapProject({ baseUrl: native.handle.baseUrl, projectName: 'Unclaimed project' });
 const dataDir = resolve(dir, 'native/.zitadel/local/nextgen-data'), db = new DatabaseSync(resolve(dataDir, 'zitadel.db'));
 let statements;
 try {
  // Synthetic fixture only: install the normal owning-team assignment to test
  // both claimed and unclaimed visibility; actual event rows remain upstream writes.
  const now = BigInt(Date.now()) * 1000000n, project = native.handle.projectId, team = 'team_events_test';
  db.prepare('INSERT INTO teams (project_id,id,name,created_at,updated_at) VALUES (?,?,?,?,?)').run(project, team, 'Synthetic owning team', now, now);
  db.prepare("INSERT INTO authz_assignments (id,project_id,catalog_id,principal_type,principal_id,object_type,relation,scope_kind,created_at,updated_at) VALUES (?,?,'cat_sys_1','team',?,'project','team','project',?,?)").run('grant_events_test', project, team, now, now);
  const count = db.prepare("SELECT count(*) AS n FROM events WHERE project_id = ? AND category = 'admin'").get(project).n; assert.ok(count >= 2, 'need multiple real upstream mutation events');
  statements = exportFixture(db);
 } finally { db.close(); }
 const keysDir = resolve(dataDir, 'master-keys'), files = await readdir(keysDir); assert.equal(files.length, 1); const key = { id: files[0], pem: await readFile(resolve(keysDir, files[0]), 'utf8') };
 await writeFile('worker/generated/events-fixture.json', JSON.stringify({ projectId: native.handle.projectId, statements }), { mode: 0o600 });
 let object = await readFile(process.env.MAPI_EVENTS_NO_INLINE === '1' ? 'worker/generated/events-noinline-adapter-test-object.js' : 'worker/generated/events-adapter-test-object.js', 'utf8'); object = object.replace('"./fixture.json"', '"./events-fixture.json"'); await writeFile('worker/generated/events-test-object.js', object);
 const envPath = resolve(dir, 'vars'); await writeFile(envPath, `MAPI_MASTER_KEY=${Buffer.from(JSON.stringify(key)).toString('base64')}\nMAPI_LOCAL_TEST=1\n`, { mode: 0o600 });
 const p = await port(), inspector = await port();
 server = spawn(process.execPath, [resolve('node_modules/wrangler/bin/wrangler.js'), 'dev', '--local', '--config', 'scripts/events-test.wrangler.jsonc', '--env-file', envPath, '--ip', '127.0.0.1', '--port', String(p), '--inspector-port', String(inspector), '--persist-to', resolve(dir, 'state')], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, WRANGLER_LOG_PATH: resolve(dir, 'wrangler.log'), WRANGLER_SEND_METRICS: 'false' } });
 for (const stream of [server.stdout, server.stderr]) stream.on('data', c => { diagnostics = (diagnostics + c.toString()).slice(-12000); });
 const worker = `http://127.0.0.1:${p}`;
 for (let i = 0; ; i++) { if (server.exitCode !== null || i === 100) throw Error('Workerd unavailable'); try { await fetch(worker + '/livez'); break; } catch { await setTimeout(200); } }
 const project = native.handle.projectId, secret = native.handle.projectSecret, preview = native.handle.previewSecret;
 async function compare(path, token) {
  async function run(base) { const response = await fetch(base + path, { headers: { accept: 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, signal: AbortSignal.timeout(15000) }); return { status: response.status, body: await response.json() }; }
  const [n, w] = await Promise.all([run(native.handle.baseUrl), run(worker)]); assert.deepEqual(w, n, path); return w;
 }
 let cursor = '', eventId, eventType, pages = 0; const seen = new Set();
 do {
  const path = `/api/v1/events?project_id=${project}&category=admin&limit=1${cursor ? `&page_token=${encodeURIComponent(cursor)}` : ''}`;
  const response = await compare(path, secret); assert.equal(response.status, 200); assert.ok(response.body.events.length <= 1);
  for (const event of response.body.events) { assert.ok(!seen.has(event.id), 'duplicate page event'); seen.add(event.id); eventId ??= event.id; eventType ??= event.event_type; }
  cursor = response.body.next_page_token ?? ''; pages++; assert.ok(pages < 100, 'pagination did not finish');
 } while (cursor);
 assert.ok(seen.size >= 2 && pages >= 2, 'expected multiple real event pages');
 assert.equal((await compare(`/api/v1/events/${eventId}?project_id=${project}`, secret)).status, 200);
 assert.equal((await compare(`/events/${eventId}?project_id=${project}`, secret)).status, 200);
 assert.equal((await compare(`/events?project_id=${project}&category=admin&limit=2`, secret)).status, 200);
 const filtered = await compare(`/api/v1/events?project_id=${project}&event_type=${encodeURIComponent(eventType)}`, secret); assert.equal(filtered.status, 200); assert.ok(filtered.body.events.length > 0); assert.ok(filtered.body.events.every(e => e.event_type === eventType));
 assert.equal((await compare(`/api/v1/events/event_missing?project_id=${project}`, secret)).status, 404);
 assert.equal((await compare(`/api/v1/events?project_id=${other.projectId}`, secret)).status, 404);
 assert.equal((await compare(`/api/v1/events?project_id=${project}`, null)).status, 401);
 assert.equal((await compare(`/api/v1/events/${eventId}?project_id=${project}`, null)).status, 401);
 assert.equal((await compare(`/api/v1/events?project_id=${project}`, preview)).status, 403);
 assert.equal((await compare(`/api/v1/events/${eventId}?project_id=${project}`, preview)).status, 403);
 assert.equal((await compare(`/api/v1/events?project_id=${project}`, other.projectSecret)).status, 404);
 assert.equal((await compare(`/api/v1/events/${eventId}?project_id=${project}`, other.projectSecret)).status, 404);
 assert.equal((await compare(`/api/v1/events?project_id=${other.projectId}`, other.projectSecret)).body.events.length, 0);
 assert.equal((await compare(`/api/v1/events/${eventId}?project_id=${other.projectId}`, other.projectSecret)).status, 404);
 assert.equal((await compare(`/api/v1/events?project_id=${project}&limit=0`, secret)).status, 400);
 assert.equal((await compare(`/api/v1/events?project_id=${project}&page_token=invalid`, secret)).status, 400);
 console.log(`Native and workerd events list/read parity passed across ${pages} pages and ${seen.size} audit events, with credential and project isolation.`);
} catch (error) { if (diagnostics) console.error(diagnostics); throw error; }
finally { if (server && server.exitCode === null && server.signalCode === null) { const stop = once(server, 'exit'); server.kill('SIGTERM'); await stop; } if (native) await native.stop(); await rm('worker/generated/events-fixture.json', { force: true }); await rm('worker/generated/events-test-object.js', { force: true }); await rm(dir, { recursive: true, force: true }); }
