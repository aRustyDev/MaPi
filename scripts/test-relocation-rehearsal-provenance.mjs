import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { makeRehearsalConfigs } from './relocation-rehearsal-config.mjs';
import { checkInventory, checkDisabledRebaseline, checkEnabledTransition, cloudflareInventory } from './relocation-rehearsal-provenance.mjs';
import { deriveEnabledConfigs } from './relocation-rehearsal-enable-config.mjs';

const dir = await mkdtemp(resolve(tmpdir(), 'mapi-rehearsal-provenance-'));
try {
  const path = resolve(dir, 'configs');
  const manifest = await makeRehearsalConfigs({ directory: path, accountId: 'a'.repeat(32), subdomain: 'synthetic' });
  const configs = Object.fromEntries(await Promise.all(['owner', 'router', 'control', 'caller'].map(async name => [name, JSON.parse(await readFile(resolve(path, `${name}.json`)))])));
  const oldNamespace = { id: 'old-id', script: 'unrelated', class: 'Old', use_sqlite: true };
  const before = checkInventory(manifest, configs, { scripts: [{ id: 'unrelated' }], namespaces: [oldNamespace] });
  const namespaces = ['NextgenApplication', 'ProjectRegistry', 'RelocationCoordinator'].map((klass, index) => ({ id: `new-${index}`, script: manifest.names.owner, class: klass, use_sqlite: true }));
  const inventory = { scripts: [{ id: manifest.names.owner }, { id: manifest.names.router }, { id: manifest.names.control, routes: null }], namespaces: [oldNamespace, ...namespaces], controlSubdomain: { enabled: false, previews_enabled: false }, controlPrivacy: { zonesComplete: true, domainsComplete: true, routeMatches: 0, domainMatches: 0 } };
  inventory.approved = { owner: '11111111-1111-1111-1111-111111111111', router: '22222222-2222-2222-2222-222222222222', control: '33333333-3333-3333-3333-333333333333' };
  const objectBinding = (name, klass, i, script_name) => ({ name, type: 'durable_object_namespace', class_name: klass, namespace_id: `new-${i}`, ...(script_name ? { script_name } : {}) });
  const bound = {
    owner: [objectBinding('NEXTGEN_APPLICATION', 'NextgenApplication', 0), objectBinding('PROJECT_REGISTRY', 'ProjectRegistry', 1), objectBinding('RELOCATION_COORDINATOR', 'RelocationCoordinator', 2)],
    router: [{ name: 'MAPI_OWNER', type: 'service', service: manifest.names.owner, environment: 'production' }],
    control: [objectBinding('NEXTGEN_APPLICATION', 'NextgenApplication', 0, manifest.names.owner), objectBinding('PROJECT_REGISTRY', 'ProjectRegistry', 1, manifest.names.owner), objectBinding('RELOCATION_COORDINATOR', 'RelocationCoordinator', 2, manifest.names.owner)],
  };
  const flag = (name, text) => ({ name, type: 'plain_text', text });
  bound.owner.push(flag('MAPI_RELOCATION_ENABLED', '0'), flag('MAPI_FENCE_WRITERS_DRAINED', '0'), flag('MAPI_APP_ORIGIN', manifest.ownerOrigin));
  bound.router.push(flag('MAPI_ROUTER_ORIGIN', manifest.routerOrigin));
  bound.control.push(flag('MAPI_REHEARSAL_SYNTHETIC_ONLY', '0'), flag('MAPI_REHEARSAL_ORIGIN', manifest.ownerOrigin));
  inventory.active = Object.fromEntries(['owner', 'router', 'control'].map(role => [role, { deployment: { id: `${role}-deployment`, versions: [{ version_id: inventory.approved[role], percentage: 100 }] }, version: { id: inventory.approved[role], resources: { bindings: bound[role] } }, settings: { observability: configs[role].observability } }]));
  for (const [index, role] of ['owner', 'router', 'control'].entries()) inventory.active[role].version.resources.script = { etag: `${index + 1}`.repeat(64) };
  const fetchBefore = globalThis.fetch, paths = [];
  try {
    globalThis.fetch = async (input, options) => {
      assert.equal(options.headers.authorization, 'Bearer read-token');
      const url = new URL(input); paths.push(url.pathname + url.search);
      if (url.pathname.endsWith('/workers/scripts')) return Response.json({ success: true, result: inventory.scripts });
      if (url.pathname.endsWith('/workers/durable_objects/namespaces')) {
        const page = Number(url.searchParams.get('page'));
        const result = page === 1 ? [oldNamespace, namespaces[0]] : namespaces.slice(1);
        return Response.json({ success: true, result, result_info: { page, per_page: 2, count: result.length, total_count: 4 } });
      }
      if (url.pathname === '/client/v4/zones') return Response.json({ success: true, result: [{ id: 'zone1', account: { id: 'a'.repeat(32) } }], result_info: { page: 1, per_page: 50, total_count: 1, count: 1 } });
      if (url.pathname.endsWith('/workers/routes')) return Response.json({ success: true, result: [] });
      if (url.pathname.endsWith('/workers/domains')) return Response.json({ success: true, result: [], result_info: { page: 1, per_page: 0, total_count: 0, count: 0 } });
      const role = ['owner', 'router', 'control'].find(name => url.pathname.includes(`/scripts/${manifest.names[name]}/`));
      if (!role) throw Error('Unexpected API path');
      if (url.pathname.endsWith('/subdomain')) return Response.json({ success: true, result: inventory.controlSubdomain });
      if (url.pathname.endsWith('/deployments')) return Response.json({ success: true, result: { deployments: url.searchParams.get('page') === '1' ? [inventory.active[role].deployment] : [] }, result_info: { total_pages: 2 } });
      if (url.pathname.endsWith('/settings')) return Response.json({ success: true, result: inventory.active[role].settings });
      if (url.pathname.includes('/versions/')) return Response.json({ success: true, result: inventory.active[role].version });
      throw Error('Unexpected API path');
    };
    const gathered = await cloudflareInventory('a'.repeat(32), 'read-token', manifest, 'after', inventory.approved);
    assert.equal(checkInventory(manifest, configs, gathered, before).namespaces.length, 3);
    assert.ok(paths.some(path => path.includes('namespaces?page=2')));
    assert.equal(paths.filter(path => path.includes('deployments?page=2')).length, 3);
  } finally { globalThis.fetch = fetchBefore; }
  const disabled = checkInventory(manifest, configs, inventory, before);
  assert.equal(disabled.namespaces.length, 3);
  disabled.reviewedWasmSha256 = JSON.parse(await readFile(resolve('worker/generated/phase1-owner-manifest.json'))).wasmSha256;
  const previous = structuredClone(disabled); previous.versions.owner.versionId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'; previous.versions.owner.etag = 'a'.repeat(64); previous.versions.control.versionId = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'; previous.versions.control.etag = 'b'.repeat(64);
  const code = { owner: disabled.versions.owner.etag, router: disabled.versions.router.etag, control: disabled.versions.control.etag, wasmSha256: disabled.reviewedWasmSha256 };
  checkDisabledRebaseline(previous, disabled, code, disabled.reviewedWasmSha256);
  const sameControlCode = structuredClone(previous); sameControlCode.versions.control.etag = disabled.versions.control.etag;
  checkDisabledRebaseline(sameControlCode, disabled, code, disabled.reviewedWasmSha256);
  const unchangedVersion = structuredClone(disabled); unchangedVersion.versions.control.versionId = previous.versions.control.versionId;
  assert.throws(() => checkDisabledRebaseline(previous, unchangedVersion, code, disabled.reviewedWasmSha256));
  const replacedNamespace = structuredClone(disabled); replacedNamespace.namespaces[0].id = 'other';
  assert.throws(() => checkDisabledRebaseline(previous, replacedNamespace, code, disabled.reviewedWasmSha256));
  const badReviewedHash = { ...code, control: 'f'.repeat(64) };
  assert.throws(() => checkDisabledRebaseline(previous, disabled, badReviewedHash, disabled.reviewedWasmSha256));
  await writeFile(resolve(path, 'provenance-after-codehash.json'), JSON.stringify(sameControlCode));
  const approveRebaseline = spawnSync(process.execPath, ['scripts/relocation-rehearsal-approve-rebaseline.mjs', path], { stdio: 'ignore', env: { ...process.env, MAPI_REBASELINE_OWNER_VERSION: disabled.versions.owner.versionId, MAPI_REBASELINE_CONTROL_VERSION: disabled.versions.control.versionId, MAPI_REBASELINE_OWNER_ETAG: code.owner, MAPI_REBASELINE_CONTROL_ETAG: code.control } });
  assert.equal(approveRebaseline.status, 0);
  const fixture = { state: 'prepared', rehearsalId: manifest.id, origin: manifest.ownerOrigin, otherOrigin: manifest.routerOrigin, projectId: 'proj_source', otherProjectId: 'proj_other', moveId: 'synthetic-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' };
  const derived = deriveEnabledConfigs(manifest, configs.owner, configs.control, fixture);
  const enabledConfigs = { ...configs, ...derived };
  checkEnabledTransition(manifest, configs, enabledConfigs, fixture, disabled);
  const changedConfig = structuredClone(enabledConfigs); changedConfig.owner.vars.MAPI_APP_ORIGIN = 'https://unrelated.example';
  assert.throws(() => checkEnabledTransition(manifest, configs, changedConfig, fixture, disabled));
  const live = structuredClone(inventory);
  live.approved = Object.fromEntries(['owner', 'router', 'control'].map((role, i) => [role, { versionId: role === 'router' ? inventory.approved.router : `${i + 4}`.repeat(8) + '-4444-4444-4444-' + '4'.repeat(12), etag: `${i + 1}`.repeat(64) }]));
  for (const role of ['owner', 'router', 'control']) {
    live.active[role].deployment.versions[0].version_id = live.approved[role].versionId;
    live.active[role].version.id = live.approved[role].versionId;
    live.active[role].version.resources.script = { etag: live.approved[role].etag };
  }
  const ownerBindings = live.active.owner.version.resources.bindings, controlBindings = live.active.control.version.resources.bindings;
  for (const name of ['MAPI_RELOCATION_ENABLED', 'MAPI_FENCE_WRITERS_DRAINED']) ownerBindings.find(item => item.name === name).text = '1';
  ownerBindings.push(flag('MAPI_PHASE1_ALLOW_BOOTSTRAP', '1'));
  controlBindings.find(item => item.name === 'MAPI_REHEARSAL_SYNTHETIC_ONLY').text = '1';
  for (const name of ['MAPI_REHEARSAL_PROJECT_ID', 'MAPI_REHEARSAL_MOVE_ID', 'MAPI_REHEARSAL_OTHER_ORIGIN', 'MAPI_REHEARSAL_OTHER_PROJECT_ID']) controlBindings.push(flag(name, enabledConfigs.control.vars[name]));
  for (const name of ['MAPI_MASTER_KEY', 'MAPI_OPERATOR_TOKEN', 'MAPI_RELOCATION_CONTROL_TOKEN', 'MAPI_PHASE1_CONTROL_TOKEN']) ownerBindings.push({ name, type: 'secret_text' });
  for (const name of ['MAPI_REHEARSAL_OPERATOR_TOKEN', 'MAPI_RELOCATION_CONTROL_TOKEN', 'MAPI_PHASE1_CONTROL_TOKEN']) controlBindings.push({ name, type: 'secret_text' });
  assert.equal(checkInventory(manifest, enabledConfigs, live, before, { enabled: true, fixture, disabledReport: disabled }).enabledFlagsVerified, true);
  const wrongEtag = structuredClone(live); wrongEtag.active.owner.version.resources.script.etag = 'f'.repeat(64);
  assert.throws(() => checkInventory(manifest, enabledConfigs, wrongEtag, before, { enabled: true, fixture, disabledReport: disabled }));
  const wrongEnabledBinding = structuredClone(live); wrongEnabledBinding.active.control.version.resources.bindings.find(item => item.name === 'RELOCATION_COORDINATOR').namespace_id = 'old-id';
  assert.throws(() => checkInventory(manifest, enabledConfigs, wrongEnabledBinding, before, { enabled: true, fixture, disabledReport: disabled }));
  const missingSecret = structuredClone(live); missingSecret.active.control.version.resources.bindings = missingSecret.active.control.version.resources.bindings.filter(item => item.name !== 'MAPI_PHASE1_CONTROL_TOKEN');
  assert.throws(() => checkInventory(manifest, enabledConfigs, missingSecret, before, { enabled: true, fixture, disabledReport: disabled }));
  const swapped = structuredClone(live); swapped.namespaces.find(item => item.class === 'ProjectRegistry').id = 'new-swapped';
  for (const role of ['owner', 'control']) swapped.active[role].version.resources.bindings.find(item => item.name === 'PROJECT_REGISTRY').namespace_id = 'new-swapped';
  assert.throws(() => checkInventory(manifest, enabledConfigs, swapped, before, { enabled: true, fixture, disabledReport: disabled }));
  await writeFile(resolve(path, 'provenance-after-rebaseline.json'), JSON.stringify(disabled));
  await writeFile(resolve(path, 'fixture.private.json'), JSON.stringify(fixture));
  const generate = spawnSync(process.execPath, ['scripts/relocation-rehearsal-enable-config.mjs', path], { stdio: 'ignore' });
  assert.equal(generate.status, 0);
  const approve = spawnSync(process.execPath, ['scripts/relocation-rehearsal-approve-enabled.mjs', path], { stdio: 'ignore', env: { ...process.env, MAPI_ENABLED_OWNER_VERSION: live.approved.owner.versionId, MAPI_ENABLED_CONTROL_VERSION: live.approved.control.versionId } });
  assert.equal(approve.status, 0);
  const approvedFile = JSON.parse(await readFile(resolve(path, 'approved-enabled-versions.json')));
  assert.equal(approvedFile.owner.etag, disabled.versions.owner.etag);
  assert.equal(approvedFile.router.versionId, disabled.versions.router.versionId);
  assert.throws(() => checkInventory(manifest, configs, { ...inventory, scripts: [...inventory.scripts, { id: manifest.names.caller }] }, before));
  assert.throws(() => checkInventory(manifest, configs, { ...inventory, namespaces: [oldNamespace, { ...namespaces[0], id: 'old-id' }, ...namespaces.slice(1)] }, before));
  assert.throws(() => checkInventory(manifest, configs, { ...inventory, controlSubdomain: { enabled: true, previews_enabled: false } }, before));
  assert.throws(() => checkInventory(manifest, configs, { ...inventory, controlPrivacy: { ...inventory.controlPrivacy, routeMatches: 1 } }, before));
  assert.throws(() => checkInventory(manifest, configs, { ...inventory, controlPrivacy: null }, before));
  const wrongVersion = structuredClone(inventory); wrongVersion.active.owner.deployment.versions[0].percentage = 50;
  assert.throws(() => checkInventory(manifest, configs, wrongVersion, before));
  const wrongBinding = structuredClone(inventory); wrongBinding.active.control.version.resources.bindings[0].script_name = 'existing-owner';
  assert.throws(() => checkInventory(manifest, configs, wrongBinding, before));
  const wrongEnvironment = structuredClone(inventory); wrongEnvironment.active.router.version.resources.bindings[0].environment = 'other';
  assert.throws(() => checkInventory(manifest, configs, wrongEnvironment, before));
  const missingLogs = structuredClone(inventory); missingLogs.active.router.settings.observability.logs.invocation_logs = false;
  assert.throws(() => checkInventory(manifest, configs, missingLogs, before));
  const enabledMove = structuredClone(inventory); enabledMove.active.owner.version.resources.bindings.find(binding => binding.name === 'MAPI_RELOCATION_ENABLED').text = '1';
  assert.throws(() => checkInventory(manifest, configs, enabledMove, before));
  assert.throws(() => checkInventory(manifest, configs, inventory));
  const changed = structuredClone(configs); changed.control.durable_objects.bindings[0].script_name = 'existing-owner';
  assert.throws(() => checkInventory(manifest, changed, inventory, before));
  console.log('Verified fresh names, namespace provenance, private control and existing-owner rejection.');
} finally { await rm(dir, { recursive: true, force: true }); }
