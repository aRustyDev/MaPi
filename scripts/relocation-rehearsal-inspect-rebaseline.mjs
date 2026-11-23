import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { cloudflareInventory, checkInventory } from './relocation-rehearsal-provenance.mjs';

const directory = process.argv[2], account = process.env.CLOUDFLARE_ACCOUNT_ID;
let token = process.env.CLOUDFLARE_API_TOKEN;
if (!token && process.env.MAPI_REHEARSAL_WRANGLER_OAUTH_PATH) {
  const text = await readFile(process.env.MAPI_REHEARSAL_WRANGLER_OAUTH_PATH, 'utf8');
  const match = text.match(/^oauth_token\s*=\s*("(?:[^"\\]|\\.)*")/m);
  if (!match) throw Error('Wrangler OAuth token is unavailable');
  token = JSON.parse(match[1]);
}
if (!directory || !/^[0-9a-f]{32}$/.test(account ?? '') || !token) throw Error('Supply the rehearsal directory, account ID and read-only credentials');
const read = async name => JSON.parse(await readFile(resolve(directory, name), 'utf8'));
const manifest = await read('manifest.json'), before = await read('provenance-before.json'), previous = await read('provenance-after-codehash.json');
const configs = Object.fromEntries(await Promise.all(['owner', 'router', 'control', 'caller'].map(async name => [name, await read(`${name}.json`)])));
if (before.accountId !== account || previous.accountId !== account || Object.values(configs).some(config => config.account_id !== account)) throw Error('Account differs');
for (const name of ['manifest', 'owner', 'router', 'control', 'caller']) {
  const hash = createHash('sha256').update(await readFile(resolve(directory, `${name}.json`))).digest('hex');
  if (hash !== before.hashes?.[name] || hash !== previous.hashes?.[name]) throw Error('Disabled configuration differs');
}
const inventory = await cloudflareInventory(account, token, manifest, 'after', null);
inventory.approved = Object.fromEntries(['owner', 'router', 'control'].map(role => [role, inventory.active?.[role]?.deployment?.versions?.[0]?.version_id]));
const report = checkInventory(manifest, configs, inventory, before);
const sorted = entries => entries.map(item => `${item.class}:${item.id}:${item.script}`).sort();
if (!isDeepStrictEqual(sorted(previous.namespaces), sorted(report.namespaces))) throw Error('Rebaseline changed namespace identities');
for (const role of ['owner', 'control']) {
  if (report.versions[role].versionId === previous.versions[role].versionId || !/^[0-9a-f]{64}$/i.test(report.versions[role].etag ?? '')) throw Error(`Disabled ${role} version or code hash is invalid`);
  const bindings = inventory.active[role].version.resources.bindings;
  if (bindings.filter(item => item.name === 'MAPI_PHASE1_CONTROL_TOKEN' && item.type === 'secret_text').length !== 1) throw Error(`Missing disabled ${role} Phase 1 secret binding`);
}
if (!isDeepStrictEqual(report.versions.router, previous.versions.router)) throw Error('Router deployment changed');
console.log(JSON.stringify({ checkedAt: report.checkedAt, versions: report.versions, namespaceIdsUnchanged: true, controlPrivacy: report.controlPrivacy, disabledFlagsVerified: report.disabledFlagsVerified }, null, 2));
