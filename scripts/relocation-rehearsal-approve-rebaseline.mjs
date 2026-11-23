import { createHash } from 'node:crypto';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const directory = process.argv[2];
const ownerVersion = process.env.MAPI_REBASELINE_OWNER_VERSION, controlVersion = process.env.MAPI_REBASELINE_CONTROL_VERSION;
const ownerEtag = process.env.MAPI_REBASELINE_OWNER_ETAG, controlEtag = process.env.MAPI_REBASELINE_CONTROL_ETAG;
if (!directory || ![ownerVersion, controlVersion].every(value => /^[0-9a-f-]{36}$/i.test(value ?? '')) || ![ownerEtag, controlEtag].every(value => /^[0-9a-f]{64}$/i.test(value ?? ''))) throw Error('Supply the rehearsal directory and reviewed disabled owner/control version IDs and script hashes');
const read = async name => JSON.parse(await readFile(resolve(directory, name), 'utf8'));
const manifest = await read('manifest.json'), previous = await read('provenance-after-codehash.json');
if (previous.stage !== 'after' || previous.disabledFlagsVerified !== true || JSON.stringify(previous.names) !== JSON.stringify(manifest.names) || !Array.isArray(previous.namespaces) || previous.namespaces.length !== 3) throw Error('Verified previous disabled deployment required');
if (ownerVersion === previous.versions?.owner?.versionId || controlVersion === previous.versions?.control?.versionId) throw Error('Rebaseline must use new owner and control versions');
const build = JSON.parse(await readFile(resolve('worker/generated/phase1-owner-manifest.json'), 'utf8'));
const wasmSha256 = createHash('sha256').update(await readFile(resolve('worker/generated/phase1-owner.wasm'))).digest('hex');
if (build.wasmSha256 !== wasmSha256) throw Error('Owner Wasm differs from the recorded build');
const approved = { owner: ownerVersion, router: previous.versions.router.versionId, control: controlVersion };
const code = { owner: ownerEtag, router: previous.versions.router.etag, control: controlEtag, wasmSha256 };
const approvalPath = resolve(directory, 'approved-versions-rebaseline.json');
await writeFile(approvalPath, JSON.stringify(approved, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
try { await writeFile(resolve(directory, 'reviewed-rebaseline-code.json'), JSON.stringify(code, null, 2) + '\n', { mode: 0o600, flag: 'wx' }); }
catch (error) { await rm(approvalPath, { force: true }); throw error; }
console.log('Recorded reviewed disabled owner/control version IDs and code hashes; no Worker was changed.');
