import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { makeRehearsalConfigs } from './relocation-rehearsal-config.mjs';
import { deriveEnabledConfigs } from './relocation-rehearsal-enable-config.mjs';
import { requireEnabledProof } from './relocation-rehearsal-enabled-proof.mjs';

const dir = await mkdtemp(resolve(tmpdir(), 'mapi-rehearsal-fixture-'));
const savedFetch = globalThis.fetch, savedArgs = process.argv;
try {
  const path = resolve(dir, 'configs'), accountId = 'a'.repeat(32);
  const manifest = await makeRehearsalConfigs({ directory: path, accountId, subdomain: 'synthetic' });
  const hashes = {};
  for (const name of ['manifest', 'owner', 'router', 'control', 'caller']) hashes[name] = createHash('sha256').update(await readFile(resolve(path, `${name}.json`))).digest('hex');
  const before = { stage: 'before', accountId, names: manifest.names, namespaceIds: ['existing'], hashes };
  const after = { stage: 'after', accountId, names: manifest.names, hashes, namespaces: ['NextgenApplication', 'ProjectRegistry', 'RelocationCoordinator'].map((klass, i) => ({ id: `new-${i}`, class: klass, script: manifest.names.owner })) };
  await writeFile(resolve(path, 'provenance-before.json'), JSON.stringify(before));
  await writeFile(resolve(path, 'provenance-after.json'), JSON.stringify(after));
  const users = new Map();
  const sessions = new Set(); let nextSession = 0, exchanges = 0;
  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(input);
    assert.ok([manifest.ownerOrigin, manifest.routerOrigin].includes(url.origin));
    if (url.pathname === '/_mapi/admin/init') return Response.json({ projectId: 'proj_one' });
    if (url.pathname === '/_mapi/admin/projects') return Response.json({ projectId: 'proj_two' });
    if (url.pathname === '/_mapi/admin/users') { const body = JSON.parse(options.body); const id = users.has(url.origin) ? 'user-three' : url.origin === manifest.ownerOrigin ? 'user-one' : 'user-two'; users.set(url.origin, body); return Response.json({ userId: id }); }
    if (url.pathname === '/login') { const user = users.get(url.origin); const matches = user && options.body.get('email') === user.email && options.body.get('password') === user.password; const cookie = `session=${++nextSession}`; if (matches) sessions.add(cookie); return new Response(null, { status: matches ? 303 : 401, headers: matches ? { 'set-cookie': `${cookie}; Path=/` } : {} }); }
    if (url.pathname === '/app') return sessions.has(options.headers.cookie) ? new Response('<input name="csrf" value="synthetic_csrf">') : new Response(null, { status: 303 });
    if (url.pathname === '/logout') { sessions.delete(options.headers.cookie); return new Response(null, { status: 303 }); }
    if (url.pathname === '/__nextgen/flows') return Response.json({ id: 'flow-synthetic', step: { fields: [{ name: 'email' }, { name: 'password' }] } }, { status: 201, headers: { 'set-cookie': '_zflow=synthetic; Path=/' } });
    if (url.pathname === '/__nextgen/flows/flow-synthetic/submit') return Response.json({ handoff_token: 'handoff-synthetic' });
    if (url.pathname === '/__nextgen/sessions/exchange') return new Response(null, { status: ++exchanges === 1 ? 200 : 401 });
    throw Error('Unexpected synthetic request');
  };
  process.env.MAPI_REHEARSAL_APP_OPERATOR_TOKEN = 'synthetic';
  process.argv = ['node', 'fixture', path, 'prepare']; await import('./relocation-rehearsal-fixture.mjs?prepare');
  const fixtureBytes = await readFile(resolve(path, 'fixture.private.json'));
  const fixture = JSON.parse(fixtureBytes);
  const enabled = deriveEnabledConfigs(manifest, JSON.parse(await readFile(resolve(path, 'owner.json'))), JSON.parse(await readFile(resolve(path, 'control.json'))), fixture);
  const ownerBytes = Buffer.from(JSON.stringify(enabled.owner)), controlBytes = Buffer.from(JSON.stringify(enabled.control));
  await writeFile(resolve(path, 'owner-enabled.json'), ownerBytes); await writeFile(resolve(path, 'control-enabled.json'), controlBytes);
  const sha = bytes => createHash('sha256').update(bytes).digest('hex');
  await writeFile(resolve(path, 'provenance-enabled.json'), JSON.stringify({ stage: 'enabled', checkedAt: new Date().toISOString(), enabledFlagsVerified: true, names: manifest.names, enabledHashes: { owner: sha(ownerBytes), control: sha(controlBytes), fixture: sha(fixtureBytes) } }));
  await requireEnabledProof(path);
  await writeFile(resolve(path, 'control-enabled.json'), '{}');
  await assert.rejects(requireEnabledProof(path), /proof differs/);
  await writeFile(resolve(path, 'control-enabled.json'), controlBytes);
  process.argv = ['node', 'fixture', path, 'verify']; await import('./relocation-rehearsal-fixture.mjs?verify');
  assert.equal((await JSON.parse(await readFile(resolve(path, 'fixture.private.json')))).state, 'prepared');
  const changed = structuredClone(after); changed.namespaces[0].id = 'existing';
  await writeFile(resolve(path, 'provenance-after.json'), JSON.stringify(changed));
  await assert.rejects(import('./relocation-rehearsal-fixture.mjs?reject'), /provenance/);
  console.log('Verified synthetic fixture preparation, post-move checks and provenance rejection.');
} finally { globalThis.fetch = savedFetch; process.argv = savedArgs; delete process.env.MAPI_REHEARSAL_APP_OPERATOR_TOKEN; await rm(dir, { recursive: true, force: true }); }
