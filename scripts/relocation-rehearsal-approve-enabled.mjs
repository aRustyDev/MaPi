import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { checkEnabledTransition } from './relocation-rehearsal-provenance.mjs';

const directory = process.argv[2], ownerVersion = process.env.MAPI_ENABLED_OWNER_VERSION, controlVersion = process.env.MAPI_ENABLED_CONTROL_VERSION;
if (!directory || ![ownerVersion, controlVersion].every(value => /^[0-9a-f-]{36}$/i.test(value ?? ''))) throw Error('Supply the rehearsal directory and reviewed owner/control version IDs');
const read = async name => JSON.parse(await readFile(resolve(directory, name), 'utf8'));
const manifest = await read('manifest.json'), disabled = await read('provenance-after-rebaseline.json'), fixture = await read('fixture.private.json');
const original = Object.fromEntries(await Promise.all(['owner', 'router', 'control', 'caller'].map(async name => [name, await read(`${name}.json`)])));
const enabled = { ...original, owner: await read('owner-enabled.json'), control: await read('control-enabled.json') };
checkEnabledTransition(manifest, original, enabled, fixture, disabled);
if (ownerVersion === disabled.versions.owner.versionId || controlVersion === disabled.versions.control.versionId) throw Error('Enabled versions must differ from the disabled versions');
const build = JSON.parse(await readFile(resolve('worker/generated/phase1-owner-manifest.json'), 'utf8'));
const wasmSha256 = createHash('sha256').update(await readFile(resolve('worker/generated/phase1-owner.wasm'))).digest('hex');
if (build.wasmSha256 !== wasmSha256) throw Error('Owner Wasm differs from the recorded build');
const approved = {
  owner: { versionId: ownerVersion, etag: disabled.versions.owner.etag },
  router: { versionId: disabled.versions.router.versionId, etag: disabled.versions.router.etag },
  control: { versionId: controlVersion, etag: disabled.versions.control.etag },
  wasmSha256,
};
await writeFile(resolve(directory, 'approved-enabled-versions.json'), JSON.stringify(approved, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
console.log('Recorded reviewed enabled version IDs and disabled code hashes; no Worker was changed.');
