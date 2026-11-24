import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { downloadVersionModuleHashes, checkVersionModuleMetadata, checkReviewedEntry, checkReviewedOwnerEntry, checkReviewedEntries } from './phase1-benchmark-inventory.mjs';

const account = 'a'.repeat(32), token = 'private-token-DO-NOT-PRINT';
const roles = ['owner', 'router', 'control'];
const names = Object.fromEntries(roles.map(role => [role, `synthetic-${role}`]));
const versions = Object.fromEntries(roles.map((role, i) => [role, `${String(i + 1).repeat(8)}-1111-1111-1111-111111111111`]));
const contents = { owner: { 'main.js': 'owner', 'main.wasm': '\0asm' }, router: { 'main.js': 'router' }, control: { 'main.js': 'control' } };
const hash = s => createHash('sha256').update(s).digest('hex');
const approved = Object.fromEntries(roles.map(role => [role, { mainModule: 'main.js', moduleTypes: Object.fromEntries(Object.keys(contents[role]).map(name => [name, name.endsWith('.wasm') ? 'application/wasm' : 'application/javascript+module'])), modules: Object.fromEntries(Object.entries(contents[role]).map(([name, body]) => [name, hash(body)])) }]));
function body(role) {
  return { success: true, result: { id: versions[role], main_module: 'main.js', secret: token, modules: Object.entries(contents[role]).map(([name, value]) => ({ name, content_type: approved[role].moduleTypes[name], content_base64: Buffer.from(value).toString('base64') })) } };
}
function fetchMock(transform = (_role, value) => value) {
  return async (input, options) => {
    const url = new URL(input), role = roles.find(role => url.pathname.includes(`/workers/${names[role]}/`));
    assert.ok(role);
    assert.equal(url.search, '?include=modules');
    assert.ok(url.pathname.endsWith(`/versions/${versions[role]}`));
    assert.equal(options.headers.authorization, `Bearer ${token}`);
    assert.equal(options.redirect, 'error');
    return new Response(JSON.stringify(transform(role, body(role))), { headers: { 'content-type': 'application/json' } });
  };
}
const hashes = await downloadVersionModuleHashes(account, token, names, versions, fetchMock());
checkVersionModuleMetadata(approved, hashes);
assert.ok(!JSON.stringify(hashes).includes(token));
async function invalid(fetcher, options) {
  await assert.rejects(downloadVersionModuleHashes(account, token, names, versions, fetcher, options), error => {
    assert.match(error.message, /^Version module download unavailable or invalid: owner$/);
    assert.ok(!String(error.stack).includes(token));
    return true;
  });
}
await invalid(async () => { throw Error(token); });
await invalid(async () => new Response(token, { status: 403 }));
await invalid(async () => new Response(`{ ${token}`));
await invalid(async () => new Response('{}', { headers: { 'content-length': '1000' } }), { responseBytes: 100 });
await invalid(async () => new Response('x'.repeat(101)), { responseBytes: 100 });
await invalid(fetchMock((_r, b) => { b.result.id = versions.router; return b; }));
await invalid(fetchMock((_r, b) => { b.result.modules.push(b.result.modules[0]); return b; }));
await invalid(fetchMock((_r, b) => { b.result.modules = []; return b; }));
await invalid(fetchMock((_r, b) => { b.result.modules[0].content_base64 = 'b3duZXI=\n'; return b; }));
await invalid(fetchMock((_r, b) => { b.result.modules[0].content_base64 = 'b3duZXJ='; return b; }));
await invalid(fetchMock((_r, b) => { b.result.modules[0].name = '../escape'; return b; }));
await invalid(fetchMock((_r, b) => { delete b.result.modules[0].content_type; return b; }));
await invalid(fetchMock((_r, b) => { delete b.result.main_module; return b; }));
await invalid(fetchMock((_r, b) => { b.result.main_module = 'missing.js'; return b; }));
await invalid(fetchMock((_r, b) => { b.result.modules[0].content_type = 'text/plain\nprivate'; return b; }));
const wrongType = await downloadVersionModuleHashes(account, token, names, versions, fetchMock((role, b) => { if (role === 'owner') b.result.modules[0].content_type = 'text/plain'; return b; }));
assert.throws(() => checkVersionModuleMetadata(approved, wrongType), /Version module metadata mismatch: owner/);
const wrongEntrypoint = await downloadVersionModuleHashes(account, token, names, versions, fetchMock((role, b) => { if (role === 'owner') b.result.main_module = 'main.wasm'; return b; }));
assert.throws(() => checkVersionModuleMetadata(approved, wrongEntrypoint), /Version module metadata mismatch: owner/);
for (const mutate of [
  a => { delete a.owner.mainModule; },
  a => { delete a.owner.moduleTypes; },
  a => { delete a.owner.moduleTypes['main.js']; },
  a => { a.owner.moduleTypes['main.js'] = 'text/plain'; },
  a => { a.owner.mainModule = 'missing.js'; },
  a => { a.owner.moduleTypes.extra = 'text/plain'; },
]) { const bad = structuredClone(approved); mutate(bad); assert.throws(() => checkVersionModuleMetadata(bad, hashes), /Version module metadata mismatch: owner/); }

await invalid(fetchMock(), { moduleBytes: 3 });
await assert.rejects(downloadVersionModuleHashes(account, token, names, { ...versions, owner: 'latest' }, fetchMock()), /Version module download unavailable or invalid: owner/);
assert.throws(() => checkVersionModuleMetadata({ ...approved, owner: { modules: { ...approved.owner.modules, 'main.wasm': '0'.repeat(64) } } }, hashes), /Downloaded content mismatch/);
const directory = await mkdtemp(join(tmpdir(), 'mapi-reviewed-entry-'));
try {
  const configs = {};
  for (const role of roles) {
    // Distinct directories let all three roles use the same configured basename.
    const roleDirectory = join(directory, role);
    await mkdir(roleDirectory);
    const configured = join(roleDirectory, 'main.js'), alternate = join(roleDirectory, 'other.js');
    configs[role] = { main: configured };
    await writeFile(configured, contents[role]['main.js']);
    await writeFile(alternate, contents[role]['main.js']);
    await checkReviewedEntry(approved, role, configured);
    const differentName = structuredClone(approved);
    differentName[role].modules['other.js'] = hash(contents[role]['main.js']);
    differentName[role].mainModule = 'other.js';
    await assert.rejects(checkReviewedEntry(differentName, role, configured), /Configured entry differs/);
    await assert.rejects(checkReviewedEntry(approved, role, alternate), /Configured entry differs/);
    await assert.rejects(checkReviewedEntry(approved, role, undefined), /Configured entry differs/);
    const missing = structuredClone(approved);
    delete missing[role].mainModule;
    await assert.rejects(checkReviewedEntry(missing, role, configured), /Configured entry differs/);
    const missingDigest = structuredClone(approved);
    delete missingDigest[role].modules['main.js'];
    await assert.rejects(checkReviewedEntry(missingDigest, role, configured), /Configured entry differs/);
    const wrongDigest = structuredClone(approved);
    wrongDigest[role].modules['main.js'] = 'f'.repeat(64);
    await assert.rejects(checkReviewedEntry(wrongDigest, role, configured), /Configured entry differs/);
    await writeFile(configured, 'changed');
    await assert.rejects(checkReviewedEntry(approved, role, configured), /Configured entry differs/);
    await writeFile(configured, contents[role]['main.js']);
  }
  await checkReviewedOwnerEntry(approved, configs.owner.main);
  await assert.rejects(checkReviewedOwnerEntry(approved, undefined), /Owner entry differs from reviewed artifact/);
  // Exercise the same all-role helper that the postflight CLI invokes.
  await checkReviewedEntries(approved, configs);
  checkVersionModuleMetadata(approved, hashes);
  for (const role of roles) {
    const badConfigs = structuredClone(configs);
    delete badConfigs[role].main;
    await assert.rejects(checkReviewedEntries(approved, badConfigs), new RegExp(`Configured entry differs from reviewed artifact: ${role}`));
    const badApproved = structuredClone(approved);
    badApproved[role].modules['main.js'] = 'f'.repeat(64);
    await assert.rejects(checkReviewedEntries(badApproved, configs), new RegExp(`Configured entry differs from reviewed artifact: ${role}`));
  }
  await assert.rejects(checkReviewedEntry(approved, 'caller', 'main.js'), /Invalid entry role/);
} finally { await rm(directory, { recursive: true, force: true }); }
console.log('Mock exact-version module evidence tests passed');
