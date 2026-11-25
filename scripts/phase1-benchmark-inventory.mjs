// Read-only benchmark inventory. The caller must also launch the reviewed local
// service-binding client; a local config file cannot authenticate a listener.
import { createHash } from 'node:crypto';
import { open, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { allPages, readBenchmarkScripts, readFreshInventory } from './phase1-benchmark-page-inventory.mjs';

const roles = ['owner', 'router', 'control', 'caller'];
const classes = ['NextgenApplication', 'ProjectRegistry', 'RelocationCoordinator'];
const namesByClass = { NEXTGEN_APPLICATION: 'NextgenApplication', PROJECT_REGISTRY: 'ProjectRegistry', RELOCATION_COORDINATOR: 'RelocationCoordinator' };
const sha = value => createHash('sha256').update(value).digest('hex');
const hashPattern = /^[0-9a-f]{64}$/i, uuidPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const MAX_JSON_BYTES = 4 * 1024 * 1024;
export function parseBenchmarkJson(bytes, label) {
  try { if (bytes.byteLength > MAX_JSON_BYTES) throw Error('invalid size'); return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw Error(`Invalid ${label} JSON`); }
}
export async function readBenchmarkJsonFile(path, label, limit = MAX_JSON_BYTES) {
  let file;
  try {
    file = await open(path, 'r');
    const stats = await file.stat();
    if (!stats.isFile() || stats.size > limit) throw Error('invalid size');
    const buffer = Buffer.alloc(limit + 1); let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > limit) throw Error('invalid size');
    const bytes = buffer.subarray(0, length);
    return { bytes, data: parseBenchmarkJson(bytes, label) };
  } catch { throw Error(`Invalid or unreadable ${label} JSON`); }
  finally { if (file) await file.close().catch(() => {}); }
}
export async function readBenchmarkJsonResponse(response, limit = MAX_JSON_BYTES) {
  try {
    const declared = response.headers.get('content-length');
    if (declared !== null && (!/^[0-9]+$/.test(declared) || Number(declared) > limit)) throw Error('invalid size');
    const reader = response.body?.getReader();
    if (!reader) throw Error('missing body');
    const chunks = []; let length = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        length += value.byteLength;
        if (length > limit) { await reader.cancel(); throw Error('invalid size'); }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    return parseBenchmarkJson(Buffer.concat(chunks.map(chunk => Buffer.from(chunk))), 'inventory response');
  } catch { throw Error('Invalid or oversized inventory response'); }
}
export async function hashBenchmarkLocalArtifact(path, limit = 60 * 1024 * 1024) {
  let file;
  try {
    if (!Number.isSafeInteger(limit) || limit < 1) throw Error('invalid bound');
    file = await open(path, 'r');
    const stats = await file.stat();
    if (!stats.isFile() || stats.size > limit) throw Error('invalid size');
    const digest = createHash('sha256'), buffer = Buffer.alloc(65536); let length = 0;
    for (;;) {
      const capacity = Math.min(buffer.length, limit + 1 - length);
      const { bytesRead } = await file.read(buffer, 0, capacity, null);
      if (!bytesRead) break;
      length += bytesRead;
      if (length > limit) throw Error('invalid size');
      digest.update(buffer.subarray(0, bytesRead));
    }
    return digest.digest('hex');
  } catch { throw Error('Local benchmark artifact unavailable or exceeds limit'); }
  finally { if (file) await file.close().catch(() => {}); }
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
export function validOrigin(value, name) {
  let u;
  try { u = new URL(value); } catch { throw Error('Synthetic origin mismatch'); }
  if (u.protocol !== 'https:' || u.origin !== value || u.port || !u.hostname.startsWith(name + '.') || !/^[a-z0-9-]+\.workers\.dev$/.test(u.hostname.slice(name.length + 1))) throw Error('Synthetic origin mismatch');
  return u.hostname.slice(name.length + 1);
}
export function checkBenchmarkConfigs(manifest, configs, account) {
  if (manifest?.local !== false || !/^[0-9a-f]{32}$/.test(manifest.id ?? '') || !/^[0-9a-f]{32}$/i.test(account ?? '')) throw Error('Invalid hosted benchmark identity');
  for (const role of roles) {
    if (manifest.names?.[role] !== `mapi-p1-rehearsal-${manifest.id}-${role}` || configs[role]?.name !== manifest.names[role] || configs[role].account_id !== account || configs[role].routes || configs[role].route || configs[role].preview_urls !== false) throw Error('Unexpected benchmark config identity');
    const o = configs[role].observability;
    if (o?.enabled !== true || o.head_sampling_rate !== 1 || o.logs?.enabled !== true || o.logs.invocation_logs !== true || o.logs.head_sampling_rate !== 1) throw Error('Benchmark logging incomplete');
  }
  if (validOrigin(manifest.ownerOrigin, manifest.names.owner) !== validOrigin(manifest.routerOrigin, manifest.names.router)) throw Error('Synthetic origins differ');
  const { owner, router, control, caller } = configs;
  if (owner.no_bundle !== true || owner.assets?.binding !== 'ASSETS' || owner.assets?.run_worker_first !== true || owner.workers_dev !== true || router.workers_dev !== true || control.workers_dev !== false || caller.workers_dev !== false || owner.vars?.MAPI_APP_ORIGIN !== manifest.ownerOrigin || router.vars?.MAPI_ROUTER_ORIGIN !== manifest.routerOrigin) throw Error('Benchmark ingress mismatch');
  const flags = { MAPI_RELOCATION_ENABLED: '0', MAPI_FENCE_WRITERS_DRAINED: '0', MAPI_PHASE1_ALLOW_BOOTSTRAP: '1', MAPI_OFFICIAL_LOGIN: '1', MAPI_OIDC_EXPERIMENTAL: '1', MAPI_MANAGEMENT_ENABLED: '1' };
  if (Object.entries(flags).some(([key, value]) => owner.vars?.[key] !== value) || Object.keys(owner.vars).some(key => !Object.hasOwn(flags, key) && !['MAPI_APP_ORIGIN', 'MAPI_RUNTIME_DIAGNOSTICS'].includes(key)) || (owner.vars.MAPI_RUNTIME_DIAGNOSTICS !== undefined && owner.vars.MAPI_RUNTIME_DIAGNOSTICS !== '1') || Object.keys(router.vars ?? {}).some(key => key !== 'MAPI_ROUTER_ORIGIN') || Object.keys(control.vars ?? {}).length) throw Error('Unsafe benchmark flags');
  const ownerBindings = owner.durable_objects?.bindings;
  if (!Array.isArray(ownerBindings) || ownerBindings.length !== 3 || ownerBindings.some(b => namesByClass[b.name] !== b.class_name || b.script_name) || new Set(ownerBindings.map(b => b.name)).size !== 3 || !eq(owner.migrations, [{ tag: 'v1', new_sqlite_classes: classes }])) throw Error('Benchmark owner namespace config mismatch');
  const controlBindings = control.durable_objects?.bindings;
  if (!Array.isArray(controlBindings) || controlBindings.length !== 2 || controlBindings.some(b => !['NEXTGEN_APPLICATION', 'PROJECT_REGISTRY'].includes(b.name) || namesByClass[b.name] !== b.class_name || b.script_name !== owner.name) || new Set(controlBindings.map(b => b.name)).size !== 2) throw Error('Benchmark control namespace config mismatch');
  if (router.services?.length !== 1 || router.services[0].binding !== 'MAPI_OWNER' || router.services[0].service !== owner.name || caller.services?.length !== 1 || caller.services[0].binding !== 'PHASE1_CONTROL' || caller.services[0].service !== control.name || caller.services[0].remote !== true || caller.vars?.MAPI_PHASE1_LOCAL_CALLER !== '1') throw Error('Benchmark service config mismatch');
}

export function checkBenchmarkInventory(manifest, configs, account, before, inventory, approved, now = Date.now()) {
  checkBenchmarkConfigs(manifest, configs, account);
  const beforeTime = Date.parse(before?.checkedAt);
  if (before?.inventoryScope !== 'independently-verified-full-account' || before?.accountId !== account || !eq(before.names, manifest.names) || !Array.isArray(before.namespaceIds) || !Number.isFinite(beforeTime) || beforeTime > now || before.namespaceIds.some(id => typeof id !== 'string' || !/^[0-9a-f]{32}$/i.test(id)) || new Set(before.namespaceIds.map(id => id.toLowerCase())).size !== before.namespaceIds.length) throw Error('Invalid benchmark preflight');
  if (inventory?.inventoryScope !== 'independently-verified-full-account') throw Error('Benchmark postflight account inventory scope is unverified');
  const listed = inventory.scripts;
  if (!Array.isArray(listed) || roles.slice(0, 3).some(role => listed.filter(s => s.script_name === manifest.names[role]).length !== 1) || listed.some(s => s.script_name === manifest.names.caller || s.service_name === manifest.names.caller)) throw Error('Unexpected benchmark script inventory');
  const targetNames = new Set(roles.slice(0, 3).map(role => manifest.names[role]));
  if (listed.some(row => (targetNames.has(row.script_name) || targetNames.has(row.service_name)) && (!targetNames.has(row.script_name) || (row.service_name !== undefined && row.service_name !== row.script_name) || ![undefined, '', 'production'].includes(row.environment_name)))) throw Error('Ambiguous benchmark script alias or environment');
  const namespaces = inventory.namespaces?.filter(ns => roles.some(role => ns.script === manifest.names[role]));
  if (!Array.isArray(namespaces) || namespaces.length !== 3 || new Set(namespaces.map(ns => ns.id.toLowerCase())).size !== 3 || new Set(namespaces.map(ns => ns.class)).size !== 3 || namespaces.some(ns => ns.script !== manifest.names.owner || !classes.includes(ns.class) || ns.use_sqlite !== true || before.namespaceIds.some(id => id.toLowerCase() === ns.id.toLowerCase()))) throw Error('Benchmark namespaces are not fresh');
  const expectedSubdomain = validOrigin(manifest.ownerOrigin, manifest.names.owner).replace(/\.workers\.dev$/, '');
  if (inventory.accountSubdomain?.subdomain !== expectedSubdomain || ['owner','router'].some(role => inventory.ingressSubdomains?.[role]?.enabled !== true || inventory.ingressSubdomains[role].previews_enabled !== false)) throw Error('Benchmark ingress subdomain mismatch');
  const privacy = inventory.controlPrivacy;
  if (inventory.controlSubdomain?.enabled !== false || inventory.controlSubdomain?.previews_enabled !== false || privacy?.zoneScope !== 'independently-verified-full-account' || privacy?.zonesComplete !== true || privacy.domainScope !== 'independently-verified-full-account' || privacy.domainsComplete !== true || privacy.routeMatches !== 0 || privacy.domainMatches !== 0) throw Error('Benchmark control is not private');
  const versions = {};
  for (const role of roles.slice(0, 3)) {
    const active = inventory.active?.[role], wanted = approved?.[role], id = wanted?.versionId, etag = wanted?.etag;
    if (!uuidPattern.test(id ?? '') || !hashPattern.test(etag ?? '') || active?.deployment?.versions?.length !== 1 || active.deployment.versions[0].percentage !== 100 || active.deployment.versions[0].version_id !== id || active.version?.id !== id || active.version?.resources?.script?.etag !== etag) throw Error(`Benchmark version mismatch: ${role}`);
    const created = Date.parse(active.version?.metadata?.created_on);
    if (!Number.isFinite(created) || created < beforeTime || created > now) throw Error(`Benchmark version predates preflight: ${role}`);
    const obs = active.settings?.observability;
    if (obs?.enabled !== true || obs.head_sampling_rate !== 1 || obs.logs?.enabled !== true || obs.logs.invocation_logs !== true || obs.logs.head_sampling_rate !== 1) throw Error(`Benchmark logging mismatch: ${role}`);
    const bindings = active.version.resources.bindings;
    if (!Array.isArray(bindings) || new Set(bindings.map(b => b.name)).size !== bindings.length) throw Error(`Benchmark bindings incomplete: ${role}`);
    const allowedTypes = new Set(['durable_object_namespace', 'plain_text', 'secret_text', 'assets', 'service']);
    if (bindings.some(b => !allowedTypes.has(b.type))) throw Error(`Unexpected binding type: ${role}`);
    const expectedVars = configs[role].vars ?? {}, deployedVars = bindings.filter(b => b.type === 'plain_text');
    if (deployedVars.length !== Object.keys(expectedVars).length || deployedVars.some(b => !Object.hasOwn(expectedVars, b.name) || expectedVars[b.name] !== b.text)) throw Error(`Unexpected environment binding: ${role}`);
    const objects = bindings.filter(b => b.type === 'durable_object_namespace');
    const expected = role === 'owner' ? Object.keys(namesByClass) : role === 'control' ? ['NEXTGEN_APPLICATION', 'PROJECT_REGISTRY'] : [];
    if (objects.length !== expected.length) throw Error(`Unexpected object binding: ${role}`);
    for (const name of expected) {
      const b = objects.find(item => item.name === name), ns = namespaces.find(item => item.class === namesByClass[name]);
      if (!b || b.class_name !== ns.class || (role === 'control' ? b.script_name !== manifest.names.owner : b.script_name && b.script_name !== manifest.names.owner) || b.namespace_id !== ns.id || b.environment || b.dispatch_namespace) throw Error(`Object binding mismatch: ${role}/${name}`);
    }
    const services = bindings.filter(b => b.type === 'service');
    if (role === 'router' ? services.length !== 1 || services[0].name !== 'MAPI_OWNER' || services[0].service !== manifest.names.owner || ![undefined, 'production'].includes(services[0].environment) || services[0].entrypoint : services.length !== 0) throw Error(`Service binding mismatch: ${role}`);
    const flags = role === 'owner' ? { MAPI_APP_ORIGIN: manifest.ownerOrigin, MAPI_RELOCATION_ENABLED: '0', MAPI_FENCE_WRITERS_DRAINED: '0', MAPI_PHASE1_ALLOW_BOOTSTRAP: '1', MAPI_OFFICIAL_LOGIN: '1', MAPI_OIDC_EXPERIMENTAL: '1', MAPI_MANAGEMENT_ENABLED: '1' } : role === 'router' ? { MAPI_ROUTER_ORIGIN: manifest.routerOrigin } : {};
    for (const [name, value] of Object.entries(flags)) { const b = bindings.find(item => item.name === name); if (b?.type !== 'plain_text' || b.text !== value) throw Error(`Benchmark flag mismatch: ${role}/${name}`); }
    if (role === 'owner' && bindings.some(b => ['MAPI_LOCAL_TEST', 'MAPI_RECOVERY_INVALIDATION_ENABLED'].includes(b.name))) throw Error('Local recovery flag in hosted owner');
    const secrets = role === 'owner' ? ['MAPI_MASTER_KEY', 'MAPI_OPERATOR_TOKEN', 'MAPI_PHASE1_CONTROL_TOKEN'] : role === 'control' ? ['MAPI_OPERATOR_TOKEN', 'MAPI_PHASE1_CONTROL_TOKEN'] : [];
    for (const name of secrets) if (!bindings.some(b => b.name === name && b.type === 'secret_text')) throw Error(`Benchmark secret binding missing: ${role}/${name}`);
    const allowedSecrets = role === 'owner' ? [...secrets, 'MAPI_RELOCATION_CONTROL_TOKEN'] : secrets;
    if (bindings.some(b => b.type === 'secret_text' && !allowedSecrets.includes(b.name))) throw Error(`Unexpected secret binding: ${role}`);
    const assets = bindings.filter(b => b.type === 'assets');
    if (role === 'owner' ? assets.length !== 1 || assets[0].name !== 'ASSETS' : assets.length !== 0) throw Error('Assets binding mismatch');
    versions[role] = { versionId: id, etag, deploymentId: active.deployment.id };
  }
  return { checkedAt: new Date(now).toISOString(), accountId: account, names: manifest.names, namespaceIds: Object.fromEntries(namespaces.map(ns => [ns.class, ns.id])), versions, controlPrivacy: privacy };
}

// Collection checks pagination consistency but does not prove an atomic
// snapshot or that the token can see every zone. Failures are sanitized.
export async function collectBenchmarkInventory(account, token, manifest, fetcher = fetch) {
  const api = 'https://api.cloudflare.com/client/v4', root = `${api}/accounts/${account}`;
  async function request(url) { let r; try { r = await fetcher(url, { headers: { authorization: `Bearer ${token}` }, redirect: 'error', signal: AbortSignal.timeout(30000) }); } catch { throw Error('Inventory request failed'); } if (!r.ok) throw Error(`Inventory HTTP ${r.status}`); const j = await readBenchmarkJsonResponse(r); if (j.success !== true) throw Error('Inventory rejected'); return j; }
  const get = path => request(root + path);
  const scripts = await readBenchmarkScripts(get);
  const namespaces = await allPages(get, '/workers/durable_objects/namespaces', 1000, row => { if (!row || !/^[0-9a-f]{32}$/i.test(row.id ?? '') || !row.script || !row.class) throw Error('Unknown namespace identity'); }, row => row.id.toLowerCase());
  const accountSubdomain = (await get('/workers/subdomain')).result;
  const controlSubdomain = (await get(`/workers/scripts/${encodeURIComponent(manifest.names.control)}/subdomain`)).result;
  const ingressSubdomains = {};
  for (const role of ['owner','router']) ingressSubdomains[role] = (await get(`/workers/scripts/${encodeURIComponent(manifest.names[role])}/subdomain`)).result;
  const zones = await allPages(path => request(api + path), `/zones?account.id=${encodeURIComponent(account)}&type=full,partial,secondary,internal`, 50, row => { if (!row?.id || row.account?.id !== account) throw Error('Unknown zone'); }, row => row.id);
  let routeMatches = 0;
  for (const zone of zones) {
    // The zone route endpoint documents a complete, unpaginated array.
    const response = await request(`${api}/zones/${encodeURIComponent(zone.id)}/workers/routes`), routes = response.result, info = response.result_info;
    if (!Array.isArray(routes) || routes.some(row => !row?.id || typeof row.pattern !== 'string' || (row.script !== undefined && typeof row.script !== 'string')) || new Set(routes.map(row => row.id)).size !== routes.length) throw Error('Unknown zone routes');
    if (info && ((info.total_count !== undefined && info.total_count !== routes.length) || (info.count !== undefined && info.count !== routes.length) || (info.page !== undefined && info.page !== 1) || (info.total_pages !== undefined && info.total_pages > 1))) throw Error('Incomplete zone route inventory');
    routeMatches += routes.filter(route => route.script === manifest.names.control).length;
  }
  const domains = await allPages(get, `/workers/domains?service=${encodeURIComponent(manifest.names.control)}`, 100, row => { if (!row?.id || typeof row.service !== 'string') throw Error('Unknown domain'); }, row => row.id);
  const controlPrivacy = { zoneScope: 'unknown', zonesComplete: false, domainScope: 'unknown', domainsComplete: false, zoneCount: zones.length, routeMatches, domainMatches: domains.filter(domain => domain.service === manifest.names.control).length };
  const active = {};
  for (const role of roles.slice(0, 3)) {
    const name = encodeURIComponent(manifest.names[role]);
    const deployment = (await get(`/workers/scripts/${name}/deployments?page=1&per_page=1`)).result?.deployments?.[0];
    if (!deployment?.id || !deployment.versions?.[0]?.version_id) throw Error(`No active deployment: ${role}`);
    const version = (await get(`/workers/scripts/${name}/versions/${encodeURIComponent(deployment.versions[0].version_id)}`)).result;
    const settings = (await get(`/workers/scripts/${name}/settings`)).result;
    active[role] = { deployment, version, settings };
  }
  return { inventoryScope: 'unknown', scripts, namespaces, accountSubdomain, ingressSubdomains, controlSubdomain, controlPrivacy, active };
}

// This legacy download is script-scoped and cannot associate its bytes with a
// specific version. Keep it separate from version-specific observations.
export async function downloadScriptHashes(account, token, names, fetcher = fetch) {
  const actual = {};
  for (const role of roles.slice(0, 3)) {
    try {
    const response = await fetcher(`https://api.cloudflare.com/client/v4/accounts/${account}/workers/scripts/${encodeURIComponent(names[role])}`, { headers: { authorization: `Bearer ${token}` }, redirect: 'error', signal: AbortSignal.timeout(30000) });
    if (!response.ok || !(response.headers.get('content-type') ?? '').toLowerCase().startsWith('multipart/')) throw Error(`Script download unavailable: ${role}`);
    const declared = Number(response.headers.get('content-length') ?? 0);
    if (declared > 60 * 1024 * 1024) throw Error('Script download exceeds bound');
    const reader = response.body?.getReader(), chunks = []; let total = 0;
    if (!reader) throw Error('Script download body missing');
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > 60 * 1024 * 1024) { await reader.cancel(); throw Error('Script download exceeds bound'); }
      chunks.push(value);
    }
    const contentType = response.headers.get('content-type').replace(/^multipart\/[^;]+/i, 'multipart/form-data');
    const form = await new Response(new Blob(chunks), { headers: { 'content-type': contentType } }).formData(), modules = {};
    for (const [name, value] of form) {
      if (typeof value === 'string' || Object.hasOwn(modules, name) || value.size > 60 * 1024 * 1024) throw Error(`Unexpected downloaded module: ${role}`);
      modules[name] = sha(new Uint8Array(await value.arrayBuffer()));
    }
    if (!Object.keys(modules).length) throw Error(`Empty script download: ${role}`);
    actual[role] = modules;
    } catch { throw Error(`Script download unavailable or invalid: ${role}`); }
  }
  return actual;
}

// Beta API observation only: a response for an immutable version ID does not
// prove account-wide visibility, propagation, or the caller's live identity.
// Reduce sensitive responses to module hashes and never print or persist bodies.
export async function downloadVersionModuleHashes(account, token, names, versions, fetcher = fetch, limits = {}) {
  const maxResponse = limits.responseBytes ?? 96 * 1024 * 1024;
  const maxModules = limits.moduleBytes ?? 60 * 1024 * 1024;
  if (!/^[0-9a-f]{32}$/i.test(account ?? '') || typeof token !== 'string' || !token || !Number.isSafeInteger(maxResponse) || maxResponse < 1 || maxResponse > 96 * 1024 * 1024 || !Number.isSafeInteger(maxModules) || maxModules < 1 || maxModules > 60 * 1024 * 1024) throw Error('Invalid version download parameters');
  const actual = {};
  for (const role of roles.slice(0, 3)) {
    try {
      const name = names?.[role], version = versions?.[role];
      if (typeof name !== 'string' || !/^[a-z0-9-]{1,128}$/.test(name) || !uuidPattern.test(version ?? '')) throw Error('invalid identity');
      const url = `https://api.cloudflare.com/client/v4/accounts/${account}/workers/workers/${encodeURIComponent(name)}/versions/${encodeURIComponent(version)}?include=modules`;
      const response = await fetcher(url, { headers: { authorization: `Bearer ${token}` }, redirect: 'error', signal: AbortSignal.timeout(30000) });
      if (!response.ok) throw Error('request failed');
      const declared = response.headers.get('content-length');
      if (declared !== null && (!/^[0-9]+$/.test(declared) || Number(declared) > maxResponse)) throw Error('response too large');
      const reader = response.body?.getReader(), chunks = []; let received = 0;
      if (!reader) throw Error('missing body');
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          received += value.byteLength;
          if (received > maxResponse) { await reader.cancel(); throw Error('response too large'); }
          chunks.push(value);
        }
      } finally { reader.releaseLock(); }
      const data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks.map(chunk => Buffer.from(chunk)))));
      if (data?.success !== true || data.result?.id?.toLowerCase() !== version.toLowerCase() || !Array.isArray(data.result.modules) || !data.result.modules.length) throw Error('invalid result');
      const modules = Object.create(null), moduleTypes = Object.create(null); let decodedTotal = 0;
      for (const module of data.result.modules) {
        const { name: moduleName, content_type: contentType, content_base64: base64 } = module ?? {};
        if (typeof moduleName !== 'string' || !/^[A-Za-z0-9_.-]+$/.test(moduleName) || moduleName === '.' || moduleName === '..' || Object.hasOwn(modules, moduleName) || typeof contentType !== 'string' || !/^[\x21-\x7e][\x20-\x7e]{0,254}$/.test(contentType) || contentType.trim() !== contentType || typeof base64 !== 'string' || base64.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) throw Error('invalid module');
        const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
        const size = base64.length / 4 * 3 - padding;
        decodedTotal += size;
        if (size < 0 || decodedTotal > maxModules) throw Error('modules too large');
        const bytes = Buffer.from(base64, 'base64');
        if (bytes.length !== size || bytes.toString('base64') !== base64) throw Error('invalid encoding');
        modules[moduleName] = sha(bytes);
        moduleTypes[moduleName] = contentType;
      }
      const mainModule = data.result.main_module;
      if (typeof mainModule !== 'string' || !Object.hasOwn(modules, mainModule)) throw Error('missing entrypoint');
      actual[role] = { modules, moduleTypes, mainModule };
    } catch { throw Error(`Version module download unavailable or invalid: ${role}`); }
  }
  return actual;
}

export function checkDownloadedModules(approved, actual) {
  for (const role of roles.slice(0, 3)) {
    const expected = approved?.[role]?.modules;
    if (!expected || typeof expected !== 'object' || Array.isArray(expected) || !Object.keys(expected).some(n => /\.(?:m?js)$/.test(n)) || (role === 'owner' && !Object.keys(expected).some(n => n.endsWith('.wasm'))) || Object.values(expected).some(v => !hashPattern.test(v)) || !eq(Object.entries(expected).sort(), Object.entries(actual?.[role] ?? {}).sort())) throw Error(`Downloaded content mismatch: ${role}`);
  }
}

// Compare exact reviewed metadata as well as bytes. No default type or
// entrypoint is inferred when the API or reviewed artifact omits one.
export function checkVersionModuleMetadata(approved, actual) {
  checkDownloadedModules(approved, Object.fromEntries(roles.slice(0, 3).map(role => [role, actual?.[role]?.modules])));
  for (const role of roles.slice(0, 3)) {
    const expected = approved?.[role], observed = actual?.[role];
    const types = expected?.moduleTypes, main = expected?.mainModule;
    if (!types || typeof types !== 'object' || Array.isArray(types) || typeof main !== 'string' || !Object.hasOwn(expected.modules, main) || !/\.(?:m?js)$/.test(main) || observed?.mainModule !== main || !eq(Object.keys(types).sort(), Object.keys(expected.modules).sort()) || Object.values(types).some(t => typeof t !== 'string' || !/^[\x21-\x7e][\x20-\x7e]{0,254}$/.test(t) || t.trim() !== t) || !eq(Object.entries(types).sort(), Object.entries(observed?.moduleTypes ?? {}).sort())) throw Error(`Version module metadata mismatch: ${role}`);
  }
}

export async function checkReviewedEntry(approved, role, mainPath) {
  if (!roles.slice(0, 3).includes(role)) throw Error('Invalid entry role');
  const artifact = approved?.[role];
  if (typeof mainPath !== 'string' || !mainPath || typeof artifact?.mainModule !== 'string' || basename(mainPath) !== artifact.mainModule || !artifact.modules || !Object.hasOwn(artifact.modules, artifact.mainModule) || !hashPattern.test(artifact.modules[artifact.mainModule]) || await hashBenchmarkLocalArtifact(mainPath) !== artifact.modules[artifact.mainModule]) throw Error(`Configured entry differs from reviewed artifact: ${role}`);
}

// Preserve the earlier owner-specific prototype API for existing consumers.
export async function checkReviewedOwnerEntry(approved, ownerMainPath) {
  try { await checkReviewedEntry(approved, 'owner', ownerMainPath); }
  catch { throw Error('Owner entry differs from reviewed artifact'); }
}

export async function checkReviewedEntries(approved, configs) {
  for (const role of roles.slice(0, 3)) await checkReviewedEntry(approved, role, configs?.[role]?.main);
}

export async function checkLocalModules(approved) {
  for (const role of roles.slice(0, 3)) {
    const base = approved?.[role]?.moduleDirectory, modules = approved?.[role]?.modules;
    if (typeof base !== 'string' || !base.startsWith('/') || !modules || typeof modules !== 'object' || Array.isArray(modules) || !Object.keys(modules).length) throw Error(`Reviewed local modules missing: ${role}`);
    for (const [name, expected] of Object.entries(modules)) {
      if (!/^[A-Za-z0-9_.-]+$/.test(name) || name === '.' || name === '..' || !hashPattern.test(expected) || await hashBenchmarkLocalArtifact(resolve(base, name)) !== expected) throw Error(`Reviewed local module mismatch: ${role}`);
    }
  }
}

export async function readBenchmarkConfigs(directory) {
  const files = Object.fromEntries(await Promise.all(['manifest', 'owner', 'router', 'control', 'caller'].map(async name => {
    const parsed = await readBenchmarkJsonFile(resolve(directory, `${name === 'owner' ? 'owner-frozen' : name}.json`), 'benchmark config');
    return [name, parsed];
  })));
  return { manifest: files.manifest.data, configs: Object.fromEntries(roles.map(role => [role, files[role].data])), hashes: Object.fromEntries(Object.entries(files).map(([name, file]) => [name, sha(file.bytes)])) };
}

export async function requireBenchmarkProof(directory, benchmark, now = Date.now()) {
  const { manifest, configs, hashes } = await readBenchmarkConfigs(directory);
  const report = (await readBenchmarkJsonFile(resolve(directory, 'benchmark-provenance-after.json'), 'benchmark report')).data;
  checkBenchmarkConfigs(manifest, configs, report.accountId);
  const checked = Date.parse(report.checkedAt);
  if (report.stage !== 'benchmark-after' || !Number.isFinite(checked) || checked > now || now - checked > 300000 || !eq(report.names, manifest.names) || !eq(report.configHashes, hashes) || report.downloadedBytesMatched !== true || report.controlPrivacy?.routeMatches !== 0 || report.controlPrivacy?.domainMatches !== 0) throw Error('Benchmark provenance is stale or changed');
  if (!Array.isArray(benchmark?.projects) || benchmark.projects.length !== 2 || benchmark.projects[0].origin !== manifest.ownerOrigin || benchmark.projects[1].origin !== manifest.routerOrigin || !benchmark.projects[0].projectId || !benchmark.projects[1].projectId || benchmark.projects[0].projectId === benchmark.projects[1].projectId) throw Error('Benchmark target differs from provenance');
  // These checks cannot prove the live loopback listener used this reviewed
  // caller configuration, or tie script-scoped bytes to the active version.
  // Do not enable hosted writes until both independent gaps are resolved.
  throw Error('Live caller identity and version-specific module bytes remain unverified');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [directory, stage] = process.argv.slice(2), account = process.env.CLOUDFLARE_ACCOUNT_ID, token = process.env.CLOUDFLARE_API_TOKEN;
  if (!directory || !['before', 'after'].includes(stage) || !/^[0-9a-f]{32}$/i.test(account ?? '') || !token) throw Error('Supply benchmark directory, stage, account ID and read-only API token');
  const { manifest, configs, hashes } = await readBenchmarkConfigs(directory);
  checkBenchmarkConfigs(manifest, configs, account);
  const base = `https://api.cloudflare.com/client/v4/accounts/${account}`;
  async function get(path) { let r; try { r = await fetch(base + path, { headers: { authorization: `Bearer ${token}` }, redirect: 'error', signal: AbortSignal.timeout(30000) }); } catch { throw Error('Inventory request failed'); } if (!r.ok) throw Error(`Inventory HTTP ${r.status}`); const j = await readBenchmarkJsonResponse(r); if (j.success !== true) throw Error('Inventory rejected'); return j; }
  let report;
  if (stage === 'before') {
    const inventory = await readFreshInventory(get, manifest.names);
    report = { stage: 'benchmark-before', checkedAt: new Date().toISOString(), accountId: account, names: manifest.names, inventoryScope: 'unknown', namespaceIds: inventory.namespaceIds, configHashes: hashes };
  } else {
    const before = (await readBenchmarkJsonFile(resolve(directory, 'benchmark-provenance-before.json'), 'benchmark preflight')).data;
    const approved = (await readBenchmarkJsonFile(resolve(directory, 'benchmark-approved.json'), 'benchmark approval')).data;
    if (before.stage !== 'benchmark-before' || !eq(before.configHashes, hashes)) throw Error('Preflight configs changed');
    const inventory = await collectBenchmarkInventory(account, token, manifest);
    report = checkBenchmarkInventory(manifest, configs, account, before, inventory, approved);
    await checkLocalModules(approved);
    await checkReviewedEntries(approved, configs);
    checkVersionModuleMetadata(approved, await downloadVersionModuleHashes(account, token, manifest.names, Object.fromEntries(roles.slice(0, 3).map(role => [role, approved[role].versionId]))));
    // Re-query deployments after content download to detect changes during proof.
    for (const role of roles.slice(0, 3)) {
      const d = (await get(`/workers/scripts/${encodeURIComponent(manifest.names[role])}/deployments?page=1&per_page=1`)).result?.deployments?.[0];
      if (d?.id !== inventory.active[role].deployment.id || !eq(d.versions, inventory.active[role].deployment.versions)) throw Error('Benchmark deployment changed during verification');
    }
    if (!hashPattern.test(approved.callerLocalSha256 ?? '') || await hashBenchmarkLocalArtifact(configs.caller.main) !== approved.callerLocalSha256) throw Error('Caller script differs from reviewed artifact');
    report = { ...report, stage: 'benchmark-after', configHashes: hashes, downloadedBytesMatched: true, moduleTypesAndEntrypointMatched: true, callerLocalSha256: approved.callerLocalSha256, contentVersionAssociation: 'beta-version-api-observation' };
  }
  await writeFile(resolve(directory, `benchmark-provenance-${stage}.json`), JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ stage: report.stage, checkedAt: report.checkedAt, downloadedBytesMatched: report.downloadedBytesMatched ?? false }));
}

export { readFreshInventory };
export const benchmarkSha256 = sha;
