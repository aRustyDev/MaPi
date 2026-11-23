import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { lstat, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const directory = process.argv[2];
if (!directory) throw Error('Supply a verified synthetic rehearsal directory');
const read = name => readFile(resolve(directory, name));
const [manifestBytes, ownerConfigBytes, controlConfigBytes, reportBytes] = await Promise.all(['manifest.json', 'owner.json', 'control.json', 'provenance-after-codehash.json'].map(read));
const manifest = JSON.parse(manifestBytes), ownerConfig = JSON.parse(ownerConfigBytes), controlConfig = JSON.parse(controlConfigBytes), report = JSON.parse(reportBytes);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
if (manifest.local || !/^[0-9a-f]{32}$/.test(manifest.id ?? '') || ownerConfig.name !== `mapi-p1-rehearsal-${manifest.id}-owner` || controlConfig.name !== `mapi-p1-rehearsal-${manifest.id}-control` || report.stage !== 'after' || report.disabledFlagsVerified !== true || JSON.stringify(report.names) !== JSON.stringify(manifest.names) || report.hashes?.manifest !== sha(manifestBytes) || report.hashes?.owner !== sha(ownerConfigBytes) || report.hashes?.control !== sha(controlConfigBytes)) throw Error('Verified synthetic disabled configuration required');
const secretDir = resolve(directory, 'secrets'), ownerPath = resolve(secretDir, 'owner.json'), controlPath = resolve(secretDir, 'control.json');
const stats = await Promise.all([secretDir, ownerPath, controlPath].map(path => lstat(path)));
if (!stats[0].isDirectory() || (stats[0].mode & 0o077) || stats.slice(1).some(info => !info.isFile() || (info.mode & 0o077))) throw Error('Secret paths must be private regular files in a private directory');
const [owner, control] = await Promise.all([ownerPath, controlPath].map(async path => JSON.parse(await readFile(path, 'utf8'))));
if (!owner.MAPI_MASTER_KEY || !owner.MAPI_OPERATOR_TOKEN || !owner.MAPI_RELOCATION_CONTROL_TOKEN || !control.MAPI_REHEARSAL_OPERATOR_TOKEN || owner.MAPI_RELOCATION_CONTROL_TOKEN !== control.MAPI_RELOCATION_CONTROL_TOKEN) throw Error('Existing synthetic secrets differ');
const left = owner.MAPI_PHASE1_CONTROL_TOKEN, right = control.MAPI_PHASE1_CONTROL_TOKEN;
if ((left && !/^[A-Za-z0-9_-]{43}$/.test(left)) || (right && !/^[A-Za-z0-9_-]{43}$/.test(right)) || (left && right && left !== right)) throw Error('Existing Phase 1 tokens conflict');
const phase = left || right || randomBytes(32).toString('base64url');
async function update(path, value) {
  const temporary = resolve(secretDir, `.phase-token-${randomUUID()}.tmp`);
  try { await writeFile(temporary, JSON.stringify({ ...value, MAPI_PHASE1_CONTROL_TOKEN: phase }), { mode: 0o600, flag: 'wx' }); await rename(temporary, path); }
  finally { await rm(temporary, { force: true }); }
}
if (!left) await update(ownerPath, owner);
if (!right) await update(controlPath, control);
console.log('Updated local synthetic secret files; no Worker or account was changed.');
