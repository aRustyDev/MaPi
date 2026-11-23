// Only for a separately reviewed synthetic deployment. This script provisions
// test data in the generated Workers; it never deploys or targets a caller-
// selected project. Keep the fixture file private until the rehearsal ends.
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createPendingHandoff, exchangeHandoffOnce } from './rehearsal-handoff.mjs';
import { requireEnabledProof } from './relocation-rehearsal-enabled-proof.mjs';

const [directory, action] = process.argv.slice(2);
const operator = process.env.MAPI_REHEARSAL_APP_OPERATOR_TOKEN;
if (!directory || !['prepare', 'verify'].includes(action) || !operator) throw Error('Supply a verified rehearsal directory, prepare or verify, and the application operator token');
const read = async name => JSON.parse(await readFile(resolve(directory, name), 'utf8'));
const manifest = await read('manifest.json'), before = await read('provenance-before.json'), after = await read('provenance-after.json');
if (manifest.local || before.stage !== 'before' || after.stage !== 'after' || JSON.stringify(before.names) !== JSON.stringify(manifest.names) || JSON.stringify(after.names) !== JSON.stringify(manifest.names) || before.accountId !== after.accountId || !Array.isArray(before.namespaceIds) || !Array.isArray(after.namespaces) || after.namespaces.length !== 3 || after.namespaces.some(ns => ns.script !== manifest.names.owner || before.namespaceIds.includes(ns.id)) || new Set(after.namespaces.map(ns => ns.id)).size !== 3 || JSON.stringify(after.namespaces.map(ns => ns.class).sort()) !== JSON.stringify(['NextgenApplication', 'ProjectRegistry', 'RelocationCoordinator'].sort())) throw Error('Rehearsal provenance is incomplete');
for (const name of ['manifest', 'owner', 'router', 'control', 'caller']) {
  const bytes = await readFile(resolve(directory, `${name}.json`));
  const hash = createHash('sha256').update(bytes).digest('hex');
  if (hash !== after.hashes?.[name] || hash !== before.hashes?.[name]) throw Error('Rehearsal configuration changed');
}
const origin = new URL(manifest.ownerOrigin), other = new URL(manifest.routerOrigin);
const suffix = origin.hostname.slice(manifest.names.owner.length + 1);
if (!/^[0-9a-f]{32}$/.test(manifest.id) || manifest.names.owner !== `mapi-p1-rehearsal-${manifest.id}-owner` || manifest.names.router !== `mapi-p1-rehearsal-${manifest.id}-router` || origin.protocol !== 'https:' || other.protocol !== 'https:' || origin.hostname !== `${manifest.names.owner}.${suffix}` || other.hostname !== `${manifest.names.router}.${suffix}` || !/^[a-z0-9-]+\.workers\.dev$/.test(suffix) || origin.origin !== manifest.ownerOrigin || other.origin !== manifest.routerOrigin) throw Error('Rehearsal origin mismatch');
const fixturePath = resolve(directory, 'fixture.private.json');
async function request(base, path, options = {}) { return fetch(new URL(path, base), { ...options, redirect: 'error', signal: AbortSignal.timeout(60000) }); }
async function admin(base, path, body) {
  const response = await request(base, path, { method: body ? 'POST' : 'GET', headers: { authorization: `Bearer ${operator}`, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  if (!response.ok) throw Error(`Synthetic admin ${path} returned HTTP ${response.status}; inspect state before retrying`);
  return response.json();
}
async function login(base, email, password) {
  // Redirect is expected for this endpoint, so handle it without following.
  return fetch(new URL('/login', base), { method: 'POST', headers: { origin: base, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ email, password }), redirect: 'manual', signal: AbortSignal.timeout(60000) });
}
if (action === 'prepare') {
  const fixture = { version: 1, rehearsalId: manifest.id, origin: manifest.ownerOrigin, otherOrigin: manifest.routerOrigin, moveId: `synthetic-${randomUUID()}`, email: `source-${randomUUID()}@example.test`, otherEmail: `other-${randomUUID()}@example.test`, password: `Synthetic-${randomUUID()}!`, state: 'started' };
  await writeFile(fixturePath, JSON.stringify(fixture, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  fixture.projectId = (await admin(fixture.origin, '/_mapi/admin/init', { name: 'Synthetic singleton' })).projectId;
  fixture.otherProjectId = (await admin(fixture.origin, '/_mapi/admin/projects', { name: 'Synthetic other', origin: fixture.otherOrigin })).projectId;
  if (!fixture.projectId || !fixture.otherProjectId || fixture.projectId === fixture.otherProjectId) throw Error('Synthetic project identities differ');
  fixture.userId = (await admin(fixture.origin, '/_mapi/admin/users', { email: fixture.email, password: fixture.password })).userId;
  fixture.otherUserId = (await admin(fixture.otherOrigin, '/_mapi/admin/users', { email: fixture.otherEmail, password: fixture.password })).userId;
  const first = await login(fixture.origin, fixture.email, fixture.password), second = await login(fixture.otherOrigin, fixture.otherEmail, fixture.password);
  if (first.status !== 303 || second.status !== 303) throw Error('Synthetic login failed');
  fixture.cookie = first.headers.get('set-cookie')?.split(';', 1)[0];
  if (!fixture.userId || !fixture.otherUserId || !fixture.cookie) throw Error('Synthetic user or session identity missing');
  const revocable = await login(fixture.origin, fixture.email, fixture.password);
  fixture.revokedCookie = revocable.headers.get('set-cookie')?.split(';', 1)[0];
  if (revocable.status !== 303 || !fixture.revokedCookie || fixture.revokedCookie === fixture.cookie) throw Error('Could not create independent revocable session');
  const sessionPage = await request(fixture.origin, '/app', { headers: { cookie: fixture.revokedCookie } });
  const csrf = (await sessionPage.text()).match(/name="csrf" value="([A-Za-z0-9_-]+)"/)?.[1];
  if (!csrf) throw Error('Revocation CSRF token missing');
  const logout = await fetch(new URL('/logout', fixture.origin), { method: 'POST', headers: { origin: fixture.origin, cookie: fixture.revokedCookie }, body: new URLSearchParams({ csrf }), redirect: 'manual', signal: AbortSignal.timeout(60000) });
  if (logout.status !== 303) throw Error('Synthetic session revocation failed');
  fixture.pendingHandoff = await createPendingHandoff(fixture.origin, fixture.projectId, fixture.email, fixture.password);
  fixture.state = 'prepared';
  await writeFile(fixturePath, JSON.stringify(fixture, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify({ state: fixture.state, projectId: fixture.projectId, otherProjectId: fixture.otherProjectId, moveId: fixture.moveId, userId: fixture.userId }));
} else {
  await requireEnabledProof(directory, { fresh: false });
  const fixture = await read('fixture.private.json');
  if (fixture.state !== 'prepared' || fixture.rehearsalId !== manifest.id || fixture.origin !== manifest.ownerOrigin || fixture.otherOrigin !== manifest.routerOrigin) throw Error('Synthetic fixture mismatch');
  const current = await admin(fixture.origin, '/_mapi/admin/init', { name: 'Synthetic singleton' });
  if (current.projectId !== fixture.projectId) throw Error('Project ID changed');
  const session = await request(fixture.origin, '/app', { headers: { cookie: fixture.cookie } });
  const revoked = await fetch(new URL('/app', fixture.origin), { headers: { cookie: fixture.revokedCookie }, redirect: 'manual', signal: AbortSignal.timeout(60000) });
  const first = await login(fixture.origin, fixture.email, fixture.password), second = await login(fixture.otherOrigin, fixture.otherEmail, fixture.password), cross = await login(fixture.otherOrigin, fixture.email, fixture.password);
  if (session.status !== 200 || revoked.status !== 303 || first.status !== 303 || second.status !== 303 || cross.status !== 401) throw Error('Synthetic session or isolation check failed');
  await exchangeHandoffOnce(fixture.origin, fixture.projectId, fixture.pendingHandoff);
  const postEmail = `post-move-${randomUUID()}@example.test`, postPassword = `Synthetic-${randomUUID()}!`;
  const postUser = await admin(fixture.origin, '/_mapi/admin/users', { email: postEmail, password: postPassword });
  if (!postUser.userId || postUser.userId === fixture.userId || (await login(fixture.origin, postEmail, postPassword)).status !== 303 || (await login(fixture.otherOrigin, postEmail, postPassword)).status !== 401) throw Error('Post-cutover write or isolation failed');
  console.log(JSON.stringify({ ok: true, projectId: fixture.projectId, otherProjectId: fixture.otherProjectId, userId: fixture.userId, postUserId: postUser.userId, checks: ['project-id', 'prior-session', 'revoked-session', 'handoff-single-use', 'moved-login', 'other-login', 'cross-project-rejection', 'post-cutover-write'] }));
}
