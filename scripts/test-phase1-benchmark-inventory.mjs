import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { benchmarkSha256, checkBenchmarkConfigs, checkBenchmarkInventory, checkDownloadedModules, checkLocalModules, collectBenchmarkInventory, downloadScriptHashes, hashBenchmarkLocalArtifact, parseBenchmarkJson, readBenchmarkConfigs, readBenchmarkJsonFile, readBenchmarkJsonResponse, requireBenchmarkProof, validOrigin } from './phase1-benchmark-inventory.mjs';

const now = Date.parse('2026-11-20T20:00:00Z'), account = 'a'.repeat(32), id = 'b'.repeat(32), names = Object.fromEntries(['owner','router','control','caller'].map(r => [r, `mapi-p1-rehearsal-${id}-${r}`]));
const manifest = { id, local: false, names, ownerOrigin: `https://${names.owner}.test.workers.dev`, routerOrigin: `https://${names.router}.test.workers.dev` };
const obs = { enabled: true, head_sampling_rate: 1, logs: { enabled: true, invocation_logs: true, head_sampling_rate: 1 } };
const base = role => ({ name: names[role], account_id: account, preview_urls: false, observability: obs });
const defs = { NEXTGEN_APPLICATION: 'NextgenApplication', PROJECT_REGISTRY: 'ProjectRegistry', RELOCATION_COORDINATOR: 'RelocationCoordinator' };
const localObjects = Object.entries(defs).map(([name, class_name]) => ({ name, class_name }));
const flags = { MAPI_APP_ORIGIN: manifest.ownerOrigin, MAPI_RELOCATION_ENABLED: '0', MAPI_FENCE_WRITERS_DRAINED: '0', MAPI_PHASE1_ALLOW_BOOTSTRAP: '1', MAPI_OFFICIAL_LOGIN: '1', MAPI_OIDC_EXPERIMENTAL: '1', MAPI_MANAGEMENT_ENABLED: '1' };
const configs = {
 owner: { ...base('owner'), workers_dev: true, no_bundle: true, main: '/tmp/owner.js', assets: { binding: 'ASSETS', run_worker_first: true }, vars: flags, durable_objects: { bindings: localObjects }, migrations: [{ tag: 'v1', new_sqlite_classes: Object.values(defs) }] },
 router: { ...base('router'), workers_dev: true, vars: { MAPI_ROUTER_ORIGIN: manifest.routerOrigin }, services: [{ binding: 'MAPI_OWNER', service: names.owner }] },
 control: { ...base('control'), workers_dev: false, durable_objects: { bindings: localObjects.slice(0,2).map(b => ({ ...b, script_name: names.owner })) } },
 caller: { ...base('caller'), workers_dev: false, main: '/tmp/caller.js', vars: { MAPI_PHASE1_LOCAL_CALLER: '1' }, services: [{ binding: 'PHASE1_CONTROL', service: names.control, remote: true }] },
};
const namespaces = Object.entries(defs).map(([name, klass], i) => ({ id: String(i+1).repeat(32), script: names.owner, class: klass, use_sqlite: true, name }));
const obj = (name, role) => ({ name, type: 'durable_object_namespace', class_name: defs[name], namespace_id: namespaces.find(n => n.class === defs[name]).id, ...(role === 'control' ? { script_name: names.owner } : {}) });
const plain = (name,text) => ({ name, type: 'plain_text', text });
const secret = name => ({ name, type: 'secret_text' });
const bindings = {
 owner: [...Object.keys(defs).map(n => obj(n,'owner')), ...Object.entries(flags).map(([n,v]) => plain(n,v)), ...['MAPI_MASTER_KEY','MAPI_OPERATOR_TOKEN','MAPI_PHASE1_CONTROL_TOKEN'].map(secret), { name: 'ASSETS', type:'assets' }],
 router: [plain('MAPI_ROUTER_ORIGIN',manifest.routerOrigin), { name:'MAPI_OWNER', type:'service', service:names.owner, environment:'production' }],
 control: [...Object.keys(defs).slice(0,2).map(n => obj(n,'control')), ...['MAPI_OPERATOR_TOKEN','MAPI_PHASE1_CONTROL_TOKEN'].map(secret)],
};
const approved = Object.fromEntries(['owner','router','control'].map((r,i) => [r, { versionId: `${i+1}`.repeat(8) + '-1111-1111-1111-' + '1'.repeat(12), etag: `${i+1}`.repeat(64) }]));
const active = Object.fromEntries(['owner','router','control'].map(r => [r,{ deployment: { id:r, versions:[{version_id:approved[r].versionId,percentage:100}] }, version: { id:approved[r].versionId, metadata: { created_on:new Date(now-500).toISOString() }, resources: { script:{etag:approved[r].etag}, bindings:bindings[r] } }, settings:{observability:obs} }]));
const inventory = { inventoryScope:'independently-verified-full-account', accountSubdomain:{subdomain:'test'}, ingressSubdomains:{owner:{enabled:true,previews_enabled:false},router:{enabled:true,previews_enabled:false}}, scripts:['owner','router','control'].map(r => ({id:r,script_name:names[r]})), namespaces, controlSubdomain:{enabled:false,previews_enabled:false}, controlPrivacy:{zoneScope:'independently-verified-full-account',zonesComplete:true,domainScope:'independently-verified-full-account',domainsComplete:true,routeMatches:0,domainMatches:0}, active };
const before = { inventoryScope:'independently-verified-full-account', accountId:account, names, checkedAt:new Date(now-1000).toISOString(), namespaceIds:['f'.repeat(32)] };
const report = checkBenchmarkInventory(manifest, configs, account, before, inventory, approved, now);
assert.equal(report.namespaceIds.ProjectRegistry, '2'.repeat(32));
for (const mutate of [
 x => x.inventoryScope = 'unknown',
 x => x.controlSubdomain.enabled = true,
 x => x.accountSubdomain.subdomain = 'other',
 x => x.ingressSubdomains.owner.enabled = false,
 x => x.controlPrivacy.routeMatches = 1,
 x => x.controlPrivacy.domainsComplete = false,
 x => x.controlPrivacy.zoneScope = 'unknown',
 x => x.controlPrivacy.domainScope = 'unknown',
 x => x.namespaces[0].id = before.namespaceIds[0],
 x => x.namespaces[0].script = 'foreign',
 x => x.active.control.version.resources.bindings[0].namespace_id = 'f'.repeat(32),
 x => delete x.active.control.version.resources.bindings[0].namespace_id,
 x => x.active.router.version.resources.bindings.find(b=>b.type==='service').service = 'foreign',
 x => x.active.owner.version.resources.bindings.push(plain('MAPI_LOCAL_TEST','1')),
 x => x.active.owner.deployment.versions[0].percentage = 50,
 x => x.active.control.version.resources.script.etag = 'f'.repeat(64),
 x => x.active.control.version.metadata.created_on = new Date(now-2000).toISOString(),
 x => x.scripts.push({id:'caller',script_name:names.caller}),
 x => x.scripts.push({id:'alias',script_name:'foreign',service_name:names.owner}),
 x => x.scripts[0].environment_name = 'staging',
 x => x.scripts[0].service_name = 'foreign',
]) { const bad = structuredClone(inventory); mutate(bad); assert.throws(() => checkBenchmarkInventory(manifest, configs, account, before, bad, approved, now)); }
const badConfig = structuredClone(configs); badConfig.control.durable_objects.bindings[0].script_name = 'foreign'; assert.throws(() => checkBenchmarkConfigs(manifest,badConfig,account));
assert.throws(() => checkBenchmarkInventory(manifest,configs,account,{...before,inventoryScope:'unknown'},inventory,approved,now),/preflight/);
const old = { ...before, namespaceIds:['1'.repeat(32)] }; assert.throws(() => checkBenchmarkInventory(manifest,configs,account,old,inventory,approved,now));
const casing = structuredClone(inventory); casing.namespaces[0].id='F'.repeat(32); assert.throws(() => checkBenchmarkInventory(manifest,configs,account,before,casing,approved,now));
const dirs = await mkdtemp(resolve(tmpdir(),'mapi-bench-prov-'));
try {
 for (const [key,value] of Object.entries({manifest,'owner-frozen':configs.owner,router:configs.router,control:configs.control,caller:configs.caller})) await writeFile(resolve(dirs,`${key}.json`),JSON.stringify(value));
 for (const r of ['owner','router','control']) { await writeFile(resolve(dirs,`${r}.js`),`${r} module`); approved[r].moduleDirectory = dirs; approved[r].modules = { [`${r}.js`]: benchmarkSha256(`${r} module`) }; }
 await writeFile(resolve(dirs,'owner.wasm'),'owner wasm'); approved.owner.modules['owner.wasm'] = benchmarkSha256('owner wasm');
 await checkLocalModules(approved);
 const body = role => { const f = new FormData(); f.append(`${role}.js`,new Blob([`${role} module`]), `${role}.js`); if (role === 'owner') f.append('owner.wasm',new Blob(['owner wasm']),'owner.wasm'); return new Response(f); };
 const received = await downloadScriptHashes(account,'secret',names, async input => body(['owner','router','control'].find(r => new URL(input).pathname.endsWith(names[r]))));
 checkDownloadedModules(approved,received);
 const altered = structuredClone(received); altered.owner['owner.js'] = 'f'.repeat(64); assert.throws(() => checkDownloadedModules(approved,altered));
 await writeFile(resolve(dirs,'owner.js'),'changed'); await assert.rejects(checkLocalModules(approved));
 const secret = 'sensitive-example';
 await writeFile(resolve(dirs,'bad.json'),`{"private":"${secret}`);
 await assert.rejects(readBenchmarkJsonFile(resolve(dirs,'bad.json'),'config'), error => !error.message.includes(secret));
 await writeFile(resolve(dirs,'huge.json'),'x'.repeat(17));
 await assert.rejects(readBenchmarkJsonFile(resolve(dirs,'huge.json'),'config',16),/Invalid or unreadable/);
 const privatePath = resolve(dirs, 'private-local-path-7a9-does-not-exist');
 const noPrivateText = error => !JSON.stringify(Object.getOwnPropertyDescriptors(error)).includes('private-local-path-7a9') && !String(error.stack).includes('private-local-path-7a9');
 await assert.rejects(hashBenchmarkLocalArtifact(privatePath),noPrivateText);
 const badModules = structuredClone(approved); badModules.owner.moduleDirectory = privatePath;
 await assert.rejects(checkLocalModules(badModules),noPrivateText);
 const bigPrivatePath = resolve(dirs, 'private-local-path-7a9-large');
 await writeFile(bigPrivatePath,'x'.repeat(17));
 await assert.rejects(hashBenchmarkLocalArtifact(bigPrivatePath,16),noPrivateText);
 assert.equal(await hashBenchmarkLocalArtifact(bigPrivatePath,17),benchmarkSha256('x'.repeat(17)));
 const sparsePrivatePath = resolve(dirs, 'private-local-path-7a9-sparse');
 const sparseFile = await open(sparsePrivatePath,'w');
 try { await sparseFile.truncate(60 * 1024 * 1024 + 1); } finally { await sparseFile.close(); }
 await assert.rejects(hashBenchmarkLocalArtifact(sparsePrivatePath),noPrivateText);
 const cliScript = "import { hashBenchmarkLocalArtifact } from './scripts/phase1-benchmark-inventory.mjs'; await hashBenchmarkLocalArtifact(process.env.MAPI_TEST_ARTIFACT);";
 const cli = spawnSync(process.execPath,['--input-type=module','-e',cliScript],{encoding:'utf8',env:{...process.env,MAPI_TEST_ARTIFACT:privatePath}});
 assert.notEqual(cli.status,0); assert.match(cli.stderr,/Local benchmark artifact unavailable/); assert.ok(!cli.stderr.includes('private-local-path-7a9'));
 await assert.rejects(readBenchmarkJsonResponse(new Response(`{"private":"${secret}`)),error => !error.message.includes(secret));
 await assert.rejects(readBenchmarkJsonResponse(new Response('x'.repeat(17)),16),/oversized/);
 assert.throws(() => parseBenchmarkJson(new TextEncoder().encode(`{"${secret}`),'config'),error => !error.message.includes(secret));
 const {hashes} = await readBenchmarkConfigs(dirs);
 await writeFile(resolve(dirs,'benchmark-provenance-after.json'),JSON.stringify({ ...report, stage:'benchmark-after', configHashes:hashes, downloadedBytesMatched:true }));
 const benchmark = {projects:[{origin:manifest.ownerOrigin,projectId:'1'},{origin:manifest.routerOrigin,projectId:'2'}]};
 await assert.rejects(requireBenchmarkProof(dirs,benchmark,now+1),/remain unverified/);
 await assert.rejects(requireBenchmarkProof(dirs,benchmark,now+300001),/stale/);
 await assert.rejects(requireBenchmarkProof(dirs,{projects:[{origin:'https://other.example',projectId:'1'},benchmark.projects[1]]},now+1),/target/);
} finally { await rm(dirs,{recursive:true,force:true}); }
const page = (items, info) => Response.json({ success: true, result: items, result_info: info });
let requests = [];
const fetcher = async (input, options) => {
  assert.equal(options.headers.authorization,'Bearer read-only');
  const url = new URL(input); requests.push(url.pathname + url.search);
  const current = Number(url.searchParams.get('page') || 1);
  const paginate = (all, size) => { const items = all.slice((current-1)*size,current*size); return page(items, {page:current,per_page:size,count:items.length,total_count:all.length,total_pages:Math.max(1,Math.ceil(all.length/size))}); };
  if (url.pathname.endsWith('/workers/subdomain')) return Response.json({success:true,result:inventory.accountSubdomain});
  if (url.pathname.endsWith('/workers/scripts-search')) return paginate(inventory.scripts,2);
  if (url.pathname.endsWith('/workers/durable_objects/namespaces')) return paginate(namespaces,2);
  if (url.pathname === '/client/v4/zones') return paginate([{id:'zone1',account:{id:account}}],1);
  if (url.pathname.endsWith('/workers/routes')) return Response.json({success:true,result:[]});
  if (url.pathname.endsWith('/workers/domains')) return paginate([],1);
  const role = ['owner','router','control'].find(r => url.pathname.includes(`/scripts/${names[r]}/`));
  if (!role) throw Error('Unexpected mocked path');
  if (url.pathname.endsWith('/subdomain')) return Response.json({success:true,result:role === 'control' ? inventory.controlSubdomain : inventory.ingressSubdomains[role]});
  if (url.pathname.endsWith('/deployments')) return Response.json({success:true,result:{deployments:[active[role].deployment]}});
  if (url.pathname.endsWith('/settings')) return Response.json({success:true,result:active[role].settings});
  if (url.pathname.includes('/versions/')) return Response.json({success:true,result:active[role].version});
  throw Error('Unexpected mocked endpoint');
};
const badJsonFetcher = async () => new Response('{"private-token');
await assert.rejects(collectBenchmarkInventory(account,'read-only',manifest,badJsonFetcher),error => !error.message.includes('private-token'));
const failingFetcher = async () => { throw Error('private-token'); };
await assert.rejects(collectBenchmarkInventory(account,'read-only',manifest,failingFetcher),error => !error.message.includes('private-token'));
await assert.rejects(downloadScriptHashes(account,'read-only',names,failingFetcher),error => !error.message.includes('private-token'));
const collected = await collectBenchmarkInventory(account,'read-only',manifest,fetcher);
assert.equal(collected.inventoryScope,'unknown');
assert.equal(collected.controlPrivacy.zoneScope,'unknown');
assert.equal(collected.controlPrivacy.zonesComplete,false);
assert.equal(collected.controlPrivacy.domainScope,'unknown');
assert.equal(collected.controlPrivacy.domainsComplete,false);
assert.throws(() => checkBenchmarkInventory(manifest,configs,account,before,collected,approved,now),/account inventory scope is unverified/);
assert.ok(requests.some(path => path.includes('scripts-search?page=2')));
assert.ok(requests.some(path => path.includes('namespaces?page=2')));
const incomplete = async (input, options) => new URL(input).pathname.endsWith('/workers/routes') ? Response.json({success:true,result:[],result_info:{page:1,total_count:2}}) : fetcher(input,options);
await assert.rejects(collectBenchmarkInventory(account,'read-only',manifest,incomplete),/Incomplete zone route/);
const publicRoute = async (input, options) => new URL(input).pathname.endsWith('/workers/routes') ? Response.json({success:true,result:[{id:'route-1',pattern:'example.test/*',script:names.control}]}) : fetcher(input,options);
const publiclyRouted = await collectBenchmarkInventory(account,'read-only',manifest,publicRoute);
assert.equal(publiclyRouted.controlPrivacy.routeMatches,1);
assert.throws(() => checkBenchmarkInventory(manifest,configs,account,before,{...publiclyRouted,inventoryScope:'independently-verified-full-account'},approved,now),/not private/);
const secretURL = 'badurl-secret-73a';
let originError;
try { validOrigin(`https://[${secretURL}`, 'expected'); } catch (error) { originError = error; }
assert.ok(originError);
assert.equal(originError.message, 'Synthetic origin mismatch');
assert.ok(!Object.hasOwn(originError, 'input'));
assert.ok(!Object.hasOwn(originError, 'cause'));
assert.ok(!JSON.stringify(Object.getOwnPropertyDescriptors(originError)).includes(secretURL));
assert.ok(!String(originError.stack).includes(secretURL));
const script = "import { validOrigin } from './scripts/phase1-benchmark-inventory.mjs'; validOrigin(process.env.MAPI_TEST_INVALID_ORIGIN, 'expected');";
const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding:'utf8', env:{ ...process.env, MAPI_TEST_INVALID_ORIGIN:`https://[${secretURL}` } });
assert.notEqual(child.status, 0);
assert.match(child.stderr, /Synthetic origin mismatch/);
assert.ok(!child.stderr.includes(secretURL));
console.log('Mock benchmark inventory checks passed; hosted authorization remains unavailable.');
