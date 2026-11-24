import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Names are generated here, never selected from an existing Worker. This
// produces files only; it neither checks the account nor deploys anything.
export async function makeRehearsalConfigs({ directory, local = false, ownerOrigin, routerOrigin, accountId, subdomain }) {
  const id = randomBytes(16).toString('hex');
  const stem = `mapi-p1-rehearsal-${id}`;
  const names = { owner: `${stem}-owner`, router: `${stem}-router`, control: `${stem}-control`, caller: `${stem}-caller` };
  if (!local) {
    if (!/^[0-9a-f]{32}$/.test(accountId ?? '') || !/^[a-z0-9-]+$/.test(subdomain ?? '')) throw Error('Account ID and workers.dev subdomain are required');
    ownerOrigin = `https://${names.owner}.${subdomain}.workers.dev`;
    routerOrigin = `https://${names.router}.${subdomain}.workers.dev`;
  } else if (![ownerOrigin, routerOrigin].every(value => /^http:\/\/127\.0\.0\.1:\d+$/.test(value ?? ''))) throw Error('Local rehearsal requires two loopback origins');
  const root = process.cwd(), common = { compatibility_date: '2026-11-19', preview_urls: false, observability: { enabled: true, head_sampling_rate: 1, logs: { enabled: true, invocation_logs: true, head_sampling_rate: 1 } } };
  const owner = { ...common, name: names.owner, main: resolve(root, 'worker/phase1-restart-owner.js'), workers_dev: !local,
    assets: { directory: resolve(root, 'worker/assets'), binding: 'ASSETS', run_worker_first: true },
    durable_objects: { bindings: [
      { name: 'NEXTGEN_APPLICATION', class_name: 'NextgenApplication' },
      { name: 'PROJECT_REGISTRY', class_name: 'ProjectRegistry' },
      { name: 'RELOCATION_COORDINATOR', class_name: 'RelocationCoordinator' },
    ] },
    migrations: [{ tag: 'v1', new_sqlite_classes: ['NextgenApplication', 'ProjectRegistry', 'RelocationCoordinator'] }],
    vars: { MAPI_APP_ORIGIN: ownerOrigin, MAPI_OFFICIAL_LOGIN: '1', MAPI_OIDC_EXPERIMENTAL: '1', MAPI_MANAGEMENT_ENABLED: '1', MAPI_RELOCATION_ENABLED: local ? '1' : '0', MAPI_FENCE_WRITERS_DRAINED: local ? '1' : '0', MAPI_RESTART_REHEARSAL: '0', ...(local ? { MAPI_LOCAL_TEST: '1' } : {}) } };
  const router = { ...common, name: names.router, main: resolve(root, 'worker/secondary-router.js'), workers_dev: !local, services: [{ binding: 'MAPI_OWNER', service: names.owner }], vars: { MAPI_ROUTER_ORIGIN: routerOrigin } };
  const control = { ...common, name: names.control, main: resolve(root, 'worker/phase1-restart-control.js'), workers_dev: false,
    durable_objects: { bindings: [
      { name: 'RELOCATION_COORDINATOR', class_name: 'RelocationCoordinator', script_name: names.owner },
      { name: 'PROJECT_REGISTRY', class_name: 'ProjectRegistry', script_name: names.owner },
      { name: 'NEXTGEN_APPLICATION', class_name: 'NextgenApplication', script_name: names.owner },
    ] },
    vars: { MAPI_REHEARSAL_SYNTHETIC_ONLY: local ? '1' : '0', MAPI_RESTART_REHEARSAL: '0', MAPI_REHEARSAL_ORIGIN: ownerOrigin } };
  const caller = { ...common, name: names.caller, main: resolve(root, 'worker/phase1-caller.js'), workers_dev: false,
    services: [{ binding: 'PHASE1_CONTROL', service: names.control, ...(!local ? { remote: true } : {}) }], vars: { MAPI_PHASE1_LOCAL_CALLER: '1' } };
  if (!local) for (const config of [owner, router, control, caller]) config.account_id = accountId;
  await mkdir(directory, { mode: 0o700 });
  for (const [name, config] of Object.entries({ owner, router, control, caller })) await writeFile(resolve(directory, `${name}.json`), JSON.stringify(config, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  const manifest = { id, local, names, ownerOrigin, routerOrigin, namespaceVerification: 'pending', deploymentsCreated: false };
  await writeFile(resolve(directory, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  return manifest;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const directory = process.argv[2];
  if (!directory) throw Error('Supply a new directory for generated rehearsal configs');
  console.log(JSON.stringify(await makeRehearsalConfigs({ directory: resolve(directory), accountId: process.env.CLOUDFLARE_ACCOUNT_ID, subdomain: process.env.MAPI_REHEARSAL_WORKERS_SUBDOMAIN }), null, 2));
}
