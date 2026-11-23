import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Pure configuration transformation: it never uploads or activates a Worker.
export function deriveEnabledConfigs(manifest, owner, control, fixture) {
  if (manifest.local || fixture?.state !== 'prepared' || fixture.rehearsalId !== manifest.id || fixture.origin !== manifest.ownerOrigin || fixture.otherOrigin !== manifest.routerOrigin || !/^proj_[A-Za-z0-9_-]+$/.test(fixture.projectId ?? '') || !/^proj_[A-Za-z0-9_-]+$/.test(fixture.otherProjectId ?? '') || fixture.projectId === fixture.otherProjectId || !/^synthetic-[0-9a-f-]{36}$/i.test(fixture.moveId ?? '')) throw Error('Prepared synthetic fixture identity differs');
  const enabledOwner = structuredClone(owner), enabledControl = structuredClone(control);
  Object.assign(enabledOwner.vars, { MAPI_RELOCATION_ENABLED: '1', MAPI_FENCE_WRITERS_DRAINED: '1', MAPI_PHASE1_ALLOW_BOOTSTRAP: '1', MAPI_RESTART_REHEARSAL: '1', MAPI_RESTART_ORIGIN: fixture.origin, MAPI_RESTART_MOVE_ID: fixture.moveId });
  Object.assign(enabledControl.vars, { MAPI_REHEARSAL_SYNTHETIC_ONLY: '1', MAPI_RESTART_REHEARSAL: '1', MAPI_REHEARSAL_PROJECT_ID: fixture.projectId, MAPI_REHEARSAL_MOVE_ID: fixture.moveId, MAPI_REHEARSAL_OTHER_ORIGIN: fixture.otherOrigin, MAPI_REHEARSAL_OTHER_PROJECT_ID: fixture.otherProjectId });
  return { owner: enabledOwner, control: enabledControl };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const directory = process.argv[2]; if (!directory) throw Error('Supply a reviewed rehearsal directory');
  const read = async name => JSON.parse(await readFile(resolve(directory, name), 'utf8'));
  const manifest = await read('manifest.json'), after = await read('provenance-after-rebaseline.json'), fixture = await read('fixture.private.json');
  if (after.stage !== 'after' || after.disabledFlagsVerified !== true || !/^[0-9a-f]{64}$/i.test(after.reviewedWasmSha256 ?? '') || JSON.stringify(after.names) !== JSON.stringify(manifest.names)) throw Error('Verified disabled rebaseline is required');
  const configs = deriveEnabledConfigs(manifest, await read('owner.json'), await read('control.json'), fixture);
  for (const role of ['owner', 'control']) await writeFile(resolve(directory, `${role}-enabled.json`), JSON.stringify(configs[role], null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  console.log('Created enabled-candidate config files only; no Worker was uploaded or enabled.');
}
