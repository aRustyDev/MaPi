// Read-only account inventory. Never deploys or enables relocation.
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { deriveEnabledConfigs } from './relocation-rehearsal-enable-config.mjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
export function checkInventory(manifest, configs, inventory, before = null, options = {}) {
  const enabled = options.enabled === true;
  const fixture = options.fixture;
  if (manifest.local || !/^[0-9a-f]{32}$/.test(manifest.id ?? '')) throw Error('Not a generated hosted rehearsal');
  const stem = `mapi-p1-rehearsal-${manifest.id}`;
  for (const role of ['owner', 'router', 'control', 'caller']) {
    if (manifest.names?.[role] !== `${stem}-${role}` || configs[role]?.name !== manifest.names[role]) throw Error('Rehearsal Worker name mismatch');
    if (configs[role].routes || configs[role].route || configs[role].preview_urls !== false) throw Error('Unexpected route or preview');
    const obs = configs[role].observability;
    if (obs?.enabled !== true || obs.head_sampling_rate !== 1 || obs.logs?.enabled !== true || obs.logs.invocation_logs !== true || obs.logs.head_sampling_rate !== 1) throw Error('Complete invocation logging is required');
  }
  const owner = configs.owner, control = configs.control, router = configs.router, caller = configs.caller;
  const host = value => { const url = new URL(value); if (url.protocol !== 'https:' || url.port || url.pathname !== '/' || url.search || url.hash || url.username || url.password) throw Error('Unexpected rehearsal origin'); return url.hostname; };
  const ownerHost = host(manifest.ownerOrigin), routerHost = host(manifest.routerOrigin);
  const suffix = ownerHost.slice(owner.name.length + 1);
  if (!ownerHost.startsWith(owner.name + '.') || !/^[a-z0-9-]+\.workers\.dev$/.test(suffix) || routerHost !== `${router.name}.${suffix}` || owner.vars?.MAPI_APP_ORIGIN !== manifest.ownerOrigin || router.vars?.MAPI_ROUTER_ORIGIN !== manifest.routerOrigin || control.vars?.MAPI_REHEARSAL_ORIGIN !== manifest.ownerOrigin) throw Error('Rehearsal origin mismatch');
  for (const [role, entry] of Object.entries({ owner: 'phase1-owner.js', router: 'secondary-router.js', control: 'relocation-rehearsal-control.js', caller: 'phase1-caller.js' })) if (configs[role].main !== resolve('worker', entry)) throw Error('Unexpected rehearsal Worker entry');
  const value = enabled ? '1' : '0';
  if (owner.vars?.MAPI_RELOCATION_ENABLED !== value || owner.vars?.MAPI_FENCE_WRITERS_DRAINED !== value || control.vars?.MAPI_REHEARSAL_SYNTHETIC_ONLY !== value) throw Error('Hosted rehearsal mode differs');
  if (enabled && (owner.vars.MAPI_PHASE1_ALLOW_BOOTSTRAP !== '1' || control.vars.MAPI_REHEARSAL_PROJECT_ID !== fixture?.projectId || control.vars.MAPI_REHEARSAL_MOVE_ID !== fixture?.moveId || control.vars.MAPI_REHEARSAL_OTHER_ORIGIN !== fixture?.otherOrigin || control.vars.MAPI_REHEARSAL_OTHER_PROJECT_ID !== fixture?.otherProjectId)) throw Error('Enabled fixture settings differ');
  const controlBindings = control.durable_objects?.bindings;
  const expectedControl = { NEXTGEN_APPLICATION: 'NextgenApplication', PROJECT_REGISTRY: 'ProjectRegistry', RELOCATION_COORDINATOR: 'RelocationCoordinator' };
  if (control.workers_dev !== false || caller.workers_dev !== false || !Array.isArray(controlBindings) || controlBindings.length !== 3 || controlBindings.some(binding => binding.script_name !== owner.name || expectedControl[binding.name] !== binding.class_name) || new Set(controlBindings.map(binding => binding.name)).size !== 3) throw Error('Control binding mismatch');
  if (router.services?.length !== 1 || router.services[0].binding !== 'MAPI_OWNER' || router.services[0].service !== owner.name || caller.services?.length !== 1 || caller.services[0].binding !== 'PHASE1_CONTROL' || caller.services[0].service !== control.name || caller.services[0].remote !== true) throw Error('Service binding mismatch');
  const expectedClasses = ['NextgenApplication', 'ProjectRegistry', 'RelocationCoordinator'];
  const bindings = owner.durable_objects?.bindings;
  const expectedBindings = { NEXTGEN_APPLICATION: 'NextgenApplication', PROJECT_REGISTRY: 'ProjectRegistry', RELOCATION_COORDINATOR: 'RelocationCoordinator' };
  if (!Array.isArray(bindings) || bindings.length !== 3 || bindings.some(binding => binding.script_name || expectedBindings[binding.name] !== binding.class_name) || new Set(bindings.map(binding => binding.class_name)).size !== 3) throw Error('Owner namespaces are not new local classes');
  if (JSON.stringify(owner.migrations) !== JSON.stringify([{ tag: 'v1', new_sqlite_classes: expectedClasses }])) throw Error('Unexpected owner migrations');
  if (!Array.isArray(inventory.scripts) || !Array.isArray(inventory.namespaces) || inventory.namespaces.some(ns => typeof ns.id !== 'string' || typeof ns.script !== 'string' || typeof ns.class !== 'string')) throw Error('Incomplete account inventory');
  const names = Object.values(manifest.names), scripts = new Map(inventory.scripts.map(script => [script.id, script]));
  const belonging = inventory.namespaces.filter(ns => names.includes(ns.script));
  if (!before) {
    if (names.some(name => scripts.has(name)) || belonging.length) throw Error('Rehearsal Worker or namespace already exists');
    return { stage: 'before', checkedAt: new Date().toISOString(), names: manifest.names, namespaceIds: inventory.namespaces.map(ns => ns.id) };
  }
  if (JSON.stringify(before.names) !== JSON.stringify(manifest.names) || !Array.isArray(before.namespaceIds)) throw Error('Pre-deployment inventory does not match');
  if (![owner.name, router.name, control.name].every(name => scripts.has(name)) || scripts.has(caller.name)) throw Error('Unexpected deployed Worker set');
  if (belonging.length !== 3 || belonging.some(ns => ns.script !== owner.name || !expectedClasses.includes(ns.class) || ns.use_sqlite !== true || before.namespaceIds.includes(ns.id)) || new Set(belonging.map(ns => ns.id)).size !== 3 || new Set(belonging.map(ns => ns.class)).size !== 3) throw Error('Namespace provenance differs');
  if (enabled) {
    const sorted = entries => entries.map(item => `${item.class}:${item.id}:${item.script}`).sort();
    if (!Array.isArray(options.disabledReport?.namespaces) || !isDeepStrictEqual(sorted(belonging), sorted(options.disabledReport.namespaces))) throw Error('Enabled deployment changed namespace identities');
  }
  const deployedControl = scripts.get(control.name);
  if (!(deployedControl.routes === null || (Array.isArray(deployedControl.routes) && deployedControl.routes.length === 0)) || inventory.controlSubdomain?.enabled !== false || inventory.controlSubdomain?.previews_enabled !== false || inventory.controlPrivacy?.zonesComplete !== true || inventory.controlPrivacy?.domainsComplete !== true || inventory.controlPrivacy?.routeMatches !== 0 || inventory.controlPrivacy?.domainMatches !== 0) throw Error('Control Worker may be publicly routed');
  const versions = {};
  for (const role of ['owner', 'router', 'control']) {
    const proof = inventory.active?.[role], selected = inventory.approved?.[role], approved = enabled ? selected?.versionId : selected;
    if (!proof || typeof approved !== 'string' || !/^[0-9a-f-]{36}$/i.test(approved) || proof.deployment?.versions?.length !== 1 || proof.deployment.versions[0].percentage !== 100 || proof.deployment.versions[0].version_id !== approved || proof.version?.id !== approved) throw Error(`Active version not approved: ${role}`);
    const etag = proof.version?.resources?.script?.etag;
    if (enabled && (!/^[0-9a-f]{64}$/i.test(selected?.etag ?? '') || etag !== selected.etag || etag !== options.disabledReport?.versions?.[role]?.etag)) throw Error(`Deployed script hash differs: ${role}`);
    const obs = proof.settings?.observability;
    if (obs?.enabled !== true || obs.head_sampling_rate !== 1 || obs.logs?.enabled !== true || obs.logs.invocation_logs !== true || obs.logs.head_sampling_rate !== 1) throw Error(`Deployed invocation logging not verified: ${role}`);
    const bindings = proof.version?.resources?.bindings;
    if (!Array.isArray(bindings)) throw Error(`Version bindings unavailable: ${role}`);
    const expectedFlags = role === 'owner' ? { MAPI_RELOCATION_ENABLED: value, MAPI_FENCE_WRITERS_DRAINED: value, MAPI_APP_ORIGIN: manifest.ownerOrigin, ...(enabled ? { MAPI_PHASE1_ALLOW_BOOTSTRAP: '1' } : {}) } : role === 'control' ? { MAPI_REHEARSAL_SYNTHETIC_ONLY: value, MAPI_REHEARSAL_ORIGIN: manifest.ownerOrigin, ...(enabled ? { MAPI_REHEARSAL_PROJECT_ID: fixture.projectId, MAPI_REHEARSAL_MOVE_ID: fixture.moveId, MAPI_REHEARSAL_OTHER_ORIGIN: fixture.otherOrigin, MAPI_REHEARSAL_OTHER_PROJECT_ID: fixture.otherProjectId } : {}) } : { MAPI_ROUTER_ORIGIN: manifest.routerOrigin };
    for (const [name, text] of Object.entries(expectedFlags)) {
      const matching = bindings.filter(binding => binding.name === name);
      if (matching.length !== 1 || matching[0].type !== 'plain_text' || matching[0].text !== text) throw Error(`Deployed setting differs: ${role}/${name}`);
    }
    if (enabled && role !== 'router') {
      const required = role === 'owner' ? ['MAPI_MASTER_KEY', 'MAPI_OPERATOR_TOKEN', 'MAPI_RELOCATION_CONTROL_TOKEN', 'MAPI_PHASE1_CONTROL_TOKEN'] : ['MAPI_REHEARSAL_OPERATOR_TOKEN', 'MAPI_RELOCATION_CONTROL_TOKEN', 'MAPI_PHASE1_CONTROL_TOKEN'];
      for (const name of required) if (bindings.filter(binding => binding.name === name && binding.type === 'secret_text').length !== 1) throw Error(`Deployed secret binding missing: ${role}/${name}`);
    }
    const sensitive = bindings.filter(binding => ['durable_object_namespace', 'service'].includes(binding.type));
    const expected = role === 'owner' || role === 'control' ? [['NEXTGEN_APPLICATION', 'NextgenApplication'], ['PROJECT_REGISTRY', 'ProjectRegistry'], ['RELOCATION_COORDINATOR', 'RelocationCoordinator']] : [];
    const objectBindings = sensitive.filter(binding => binding.type === 'durable_object_namespace');
    if (objectBindings.length !== expected.length) throw Error(`Unexpected object bindings: ${role}`);
    for (const [name, klass] of expected) {
      const found = objectBindings.find(binding => binding.name === name), ns = belonging.find(item => item.class === klass);
      if (!found || found.class_name !== klass || (found.script_name && found.script_name !== owner.name) || (role === 'control' && found.script_name !== owner.name) || (found.namespace_id && found.namespace_id !== ns.id) || found.environment || found.dispatch_namespace) throw Error(`Deployed object binding differs: ${role}/${name}`);
    }
    const services = sensitive.filter(binding => binding.type === 'service');
    if ((role === 'router' && (services.length !== 1 || services[0].name !== 'MAPI_OWNER' || services[0].service !== owner.name || ![undefined, 'production'].includes(services[0].environment) || services[0].entrypoint)) || (role !== 'router' && services.length)) throw Error(`Deployed service binding differs: ${role}`);
    versions[role] = { deploymentId: proof.deployment.id, versionId: approved, ...(typeof etag === 'string' ? { etag } : {}) };
  }
  return { stage: enabled ? 'enabled' : 'after', checkedAt: new Date().toISOString(), names: manifest.names, namespaces: belonging.map(({ id, script, class: klass }) => ({ id, script, class: klass })), versions, controlPrivacy: { ...inventory.controlPrivacy, workersDevEnabled: inventory.controlSubdomain.enabled, previewsEnabled: inventory.controlSubdomain.previews_enabled }, ...(enabled ? { enabledFlagsVerified: true } : { disabledFlagsVerified: true }) };
}

export function checkEnabledTransition(manifest, original, enabled, fixture, disabledReport) {
  if (!disabledReport || disabledReport.stage !== 'after' || disabledReport.disabledFlagsVerified !== true || !isDeepStrictEqual(disabledReport.names, manifest.names)) throw Error('Verified disabled deployment required');
  if (['owner', 'router', 'control'].some(role => !/^[0-9a-f]{64}$/i.test(disabledReport.versions?.[role]?.etag ?? ''))) throw Error('Disabled deployment script hashes are missing');
  if (!/^[0-9a-f]{64}$/i.test(disabledReport.reviewedWasmSha256 ?? '')) throw Error('Reviewed disabled Wasm hash is missing');
  const expected = deriveEnabledConfigs(manifest, original.owner, original.control, fixture);
  if (!isDeepStrictEqual(enabled.owner, expected.owner) || !isDeepStrictEqual(enabled.control, expected.control) || !isDeepStrictEqual(enabled.router, original.router) || !isDeepStrictEqual(enabled.caller, original.caller)) throw Error('Enabled configs exceed the reviewed changes');
}

export function checkDisabledRebaseline(previous, current, code, wasmSha256) {
  if (!previous || previous.stage !== 'after' || previous.disabledFlagsVerified !== true || current.stage !== 'after' || current.disabledFlagsVerified !== true || previous.accountId !== current.accountId || !isDeepStrictEqual(previous.names, current.names) || !isDeepStrictEqual(previous.hashes, current.hashes)) throw Error('Disabled rebaseline identity differs');
  const sorted = entries => entries.map(item => `${item.class}:${item.id}:${item.script}`).sort();
  if (!Array.isArray(previous.namespaces) || !isDeepStrictEqual(sorted(previous.namespaces), sorted(current.namespaces))) throw Error('Disabled rebaseline changed namespace identities');
  for (const role of ['owner', 'control']) if (current.versions?.[role]?.versionId === previous.versions?.[role]?.versionId || !/^[0-9a-f]{64}$/i.test(current.versions?.[role]?.etag ?? '')) throw Error(`Disabled ${role} version or code hash is invalid`);
  if (!isDeepStrictEqual(current.versions?.router, previous.versions?.router)) throw Error('Disabled router deployment changed');
  if (!code || code.wasmSha256 !== wasmSha256 || ['owner', 'router', 'control'].some(role => !/^[0-9a-f]{64}$/i.test(code[role] ?? '') || code[role] !== current.versions?.[role]?.etag)) throw Error('Reviewed disabled rebaseline code differs');
}

export async function cloudflareInventory(account, token, manifest, stage, approved) {
  const root = `https://api.cloudflare.com/client/v4/accounts/${account}`;
  async function request(url) { const response = await fetch(url, { headers: { authorization: `Bearer ${token}` }, redirect: 'error' }); const body = await response.json(); if (!response.ok || body.success !== true) throw Error(`Cloudflare inventory failed: HTTP ${response.status}`); return body; }
  const get = path => request(root + path);
  const scripts = (await get('/workers/scripts')).result;
  function lastPage(info, page, requested, actual) {
    if (!info || (info.page !== undefined && info.page !== page) || (info.count !== undefined && info.count !== actual)) throw Error('Incomplete inventory pagination');
    if (Number.isSafeInteger(info.total_pages) && info.total_pages >= 1) return info.total_pages;
    if (!Number.isSafeInteger(info.total_count) || info.total_count < 0 || !Number.isSafeInteger(info.per_page) || info.per_page < 1 || info.per_page > requested) throw Error('Incomplete inventory pagination');
    return Math.max(1, Math.ceil(info.total_count / info.per_page));
  }
  const namespaces = [];
  for (let page = 1; ; page++) {
    const result = await get(`/workers/durable_objects/namespaces?page=${page}&per_page=1000`);
    if (!Array.isArray(result.result)) throw Error('Incomplete namespace pagination');
    const pages = lastPage(result.result_info, page, 1000, result.result.length);
    if (page > pages) throw Error('Incomplete namespace pagination');
    namespaces.push(...result.result);
    if (page === pages) { if (result.result_info.total_count !== undefined && namespaces.length !== result.result_info.total_count) throw Error('Namespace inventory changed during pagination'); break; }
  }
  const controlSubdomain = stage !== 'before' ? (await get(`/workers/scripts/${encodeURIComponent(manifest.names.control)}/subdomain`)).result : null;
  let controlPrivacy = null;
  if (stage !== 'before') {
    const zones = [];
    for (let page = 1; ; page++) {
      const result = await request(`https://api.cloudflare.com/client/v4/zones?account.id=${encodeURIComponent(account)}&type=full,partial,secondary,internal&page=${page}&per_page=50`);
      if (!Array.isArray(result.result) || result.result.some(zone => typeof zone.id !== 'string' || zone.account?.id !== account)) throw Error('Incomplete account zone inventory');
      const pages = lastPage(result.result_info, page, 50, result.result.length);
      if (page > pages) throw Error('Incomplete account zone inventory');
      zones.push(...result.result);
      if (page === pages) { if (result.result_info.total_count !== undefined && zones.length !== result.result_info.total_count) throw Error('Zone inventory changed during pagination'); break; }
    }
    let routeMatches = 0;
    for (const zone of zones) {
      const result = await request(`https://api.cloudflare.com/client/v4/zones/${encodeURIComponent(zone.id)}/workers/routes`);
      if (!Array.isArray(result.result) || result.result.some(route => typeof route.id !== 'string' || (route.script !== undefined && typeof route.script !== 'string'))) throw Error('Incomplete zone route inventory');
      if (result.result_info && Number.isSafeInteger(result.result_info.total_count) && result.result_info.total_count !== result.result.length) throw Error('Zone route inventory is incomplete');
      routeMatches += result.result.filter(route => route.script === manifest.names.control).length;
    }
    const domains = [];
    for (let page = 1; ; page++) {
      const result = await get(`/workers/domains?service=${encodeURIComponent(manifest.names.control)}&page=${page}&per_page=100`);
      if (!Array.isArray(result.result) || result.result.some(domain => typeof domain.service !== 'string')) throw Error('Incomplete Worker domain inventory');
      domains.push(...result.result);
      if (result.result.length === 0 && result.result_info?.total_count === 0) break;
      const pages = lastPage(result.result_info, page, 100, result.result.length);
      if (page > pages) throw Error('Incomplete Worker domain inventory');
      if (page === pages) { if (result.result_info.total_count !== undefined && domains.length !== result.result_info.total_count) throw Error('Worker domain inventory changed during pagination'); break; }
    }
    controlPrivacy = { zonesComplete: true, domainsComplete: true, zoneCount: zones.length, routeMatches, domainMatches: domains.filter(domain => domain.service === manifest.names.control).length };
  }
  const active = {};
  if (stage !== 'before') for (const role of ['owner', 'router', 'control']) {
    const name = encodeURIComponent(manifest.names[role]);
    const deployments = [];
    for (let page = 1; ; page++) {
      const response = await get(`/workers/scripts/${name}/deployments?page=${page}&per_page=100`);
      if (!Array.isArray(response.result?.deployments)) throw Error('Incomplete deployment pagination');
      const pages = lastPage(response.result_info, page, 100, response.result.deployments.length);
      if (page > pages) throw Error('Incomplete deployment pagination');
      deployments.push(...response.result.deployments);
      if (page === pages) { if (response.result_info.total_count !== undefined && deployments.length !== response.result_info.total_count) throw Error('Deployment inventory changed during pagination'); break; }
    }
    const deployment = deployments[0];
    if (!deployment?.versions?.[0]?.version_id) throw Error(`No active deployment: ${role}`);
    const version = (await get(`/workers/scripts/${name}/versions/${encodeURIComponent(deployment.versions[0].version_id)}`)).result;
    const settings = (await get(`/workers/scripts/${name}/settings`)).result;
    active[role] = { deployment, version, settings };
  }
  return { scripts, namespaces, controlSubdomain, controlPrivacy, active, approved };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [directory, stage, suffix] = process.argv.slice(2);
  const account = process.env.CLOUDFLARE_ACCOUNT_ID;
  let token = process.env.CLOUDFLARE_API_TOKEN;
  if (!token && process.env.MAPI_REHEARSAL_WRANGLER_OAUTH_PATH) {
    const config = await readFile(process.env.MAPI_REHEARSAL_WRANGLER_OAUTH_PATH, 'utf8');
    const match = config.match(/^oauth_token\s*=\s*("(?:[^"\\]|\\.)*")/m);
    if (!match) throw Error('Wrangler OAuth token is unavailable');
    token = JSON.parse(match[1]);
  }
  if (!directory || !['before', 'after', 'enabled'].includes(stage) || !/^[0-9a-f]{32}$/.test(account ?? '') || !token) throw Error('Supply generated directory, before, after or enabled, account ID and read-only API token');
  if (suffix && (stage === 'before' || !/^[a-z0-9-]+$/.test(suffix))) throw Error('Invalid report suffix');
  const files = Object.fromEntries(await Promise.all(['manifest', 'owner', 'router', 'control', 'caller'].map(async name => { const bytes = await readFile(resolve(directory, `${name}.json`)); return [name, { bytes, json: JSON.parse(bytes) }]; })));
  const original = Object.fromEntries(['owner', 'router', 'control', 'caller'].map(name => [name, files[name].json]));
  if (Object.values(original).some(config => config.account_id !== account)) throw Error('Account mismatch');
  const hashes = Object.fromEntries(Object.entries(files).map(([name, file]) => [name, digest(file.bytes)]));
  const before = stage !== 'before' ? JSON.parse(await readFile(resolve(directory, 'provenance-before.json'), 'utf8')) : null;
  if (before && (before.accountId !== account || JSON.stringify(before.hashes) !== JSON.stringify(hashes))) throw Error('Generated configs changed since inventory');
  let configs = original, fixture, disabledReport, enabledHashes, wasmSha256;
  if (stage === 'enabled') {
    disabledReport = JSON.parse(await readFile(resolve(directory, 'provenance-after-rebaseline.json'), 'utf8'));
    if (disabledReport.accountId !== account || JSON.stringify(disabledReport.hashes) !== JSON.stringify(hashes)) throw Error('Disabled deployment proof differs');
    const fixtureBytes = await readFile(resolve(directory, 'fixture.private.json'));
    fixture = JSON.parse(fixtureBytes);
    const [ownerBytes, controlBytes] = await Promise.all(['owner-enabled.json', 'control-enabled.json'].map(name => readFile(resolve(directory, name))));
    configs = { ...original, owner: JSON.parse(ownerBytes), control: JSON.parse(controlBytes) };
    checkEnabledTransition(files.manifest.json, original, configs, fixture, disabledReport);
    enabledHashes = { owner: digest(ownerBytes), control: digest(controlBytes), fixture: digest(fixtureBytes) };
    const build = JSON.parse(await readFile(resolve('worker/generated/phase1-owner-manifest.json'), 'utf8'));
    wasmSha256 = digest(await readFile(resolve('worker/generated/phase1-owner.wasm')));
    if (build.wasmSha256 !== wasmSha256 || disabledReport.reviewedWasmSha256 !== wasmSha256) throw Error('Owner Wasm differs from the reviewed disabled build');
  }
  const approvalFile = stage === 'enabled' ? 'approved-enabled-versions.json' : suffix === 'rebaseline' ? 'approved-versions-rebaseline.json' : 'approved-versions.json';
  const approved = stage !== 'before' ? JSON.parse(await readFile(resolve(directory, approvalFile), 'utf8')) : null;
  if (stage === 'enabled' && (approved.wasmSha256 !== wasmSha256 || approved.router?.versionId !== disabledReport.versions?.router?.versionId || approved.owner?.versionId === disabledReport.versions?.owner?.versionId || approved.control?.versionId === disabledReport.versions?.control?.versionId)) throw Error('Approved enabled build or version transition differs');
  const report = checkInventory(files.manifest.json, configs, await cloudflareInventory(account, token, files.manifest.json, stage, approved), before, { enabled: stage === 'enabled', fixture, disabledReport });
  if (stage === 'enabled') {
    const sorted = entries => entries.map(item => `${item.class}:${item.id}:${item.script}`).sort();
    if (!isDeepStrictEqual(sorted(report.namespaces), sorted(disabledReport.namespaces))) throw Error('Enabled deployment changed namespace identities');
    report.enabledHashes = enabledHashes; report.wasmSha256 = wasmSha256;
  }
  report.accountId = account; report.hashes = hashes;
  if (stage === 'after' && suffix === 'rebaseline') {
    const previous = JSON.parse(await readFile(resolve(directory, 'provenance-after-codehash.json'), 'utf8'));
    const code = JSON.parse(await readFile(resolve(directory, 'reviewed-rebaseline-code.json'), 'utf8'));
    const build = JSON.parse(await readFile(resolve('worker/generated/phase1-owner-manifest.json'), 'utf8'));
    const currentWasm = digest(await readFile(resolve('worker/generated/phase1-owner.wasm')));
    if (build.wasmSha256 !== currentWasm) throw Error('Owner Wasm differs from the recorded build');
    checkDisabledRebaseline(previous, report, code, currentWasm);
    report.reviewedWasmSha256 = currentWasm;
  }
  await writeFile(resolve(directory, `provenance-${stage}${suffix ? '-' + suffix : ''}.json`), JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify(report, null, 2));
}
