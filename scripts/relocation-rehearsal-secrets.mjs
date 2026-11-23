import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const directory = process.argv[2];
if (!directory) throw Error('Supply a fresh generated rehearsal directory');
const manifest = JSON.parse(await readFile(resolve(directory, 'manifest.json'), 'utf8'));
if (manifest.local || !/^[0-9a-f]{32}$/.test(manifest.id ?? '') || manifest.names?.owner !== `mapi-p1-rehearsal-${manifest.id}-owner`) throw Error('Not a generated hosted rehearsal');
const dir = resolve(directory, 'secrets');
await mkdir(dir, { mode: 0o700 });
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 4096, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
const appOperator = randomBytes(32).toString('base64url'), controlOperator = randomBytes(32).toString('base64url'), relocation = randomBytes(32).toString('base64url'), phaseControl = randomBytes(32).toString('base64url');
const master = Buffer.from(JSON.stringify({ id: 'synthetic-master-key.pem', pem: privateKey })).toString('base64');
const write = (name, value) => writeFile(resolve(dir, name), value, { mode: 0o600, flag: 'wx' });
await write('owner.json', JSON.stringify({ MAPI_MASTER_KEY: master, MAPI_OPERATOR_TOKEN: appOperator, MAPI_RELOCATION_CONTROL_TOKEN: relocation, MAPI_PHASE1_CONTROL_TOKEN: phaseControl }));
await write('control.json', JSON.stringify({ MAPI_REHEARSAL_OPERATOR_TOKEN: controlOperator, MAPI_RELOCATION_CONTROL_TOKEN: relocation, MAPI_PHASE1_CONTROL_TOKEN: phaseControl }));
await write('operator.env', `MAPI_REHEARSAL_APP_OPERATOR_TOKEN=${appOperator}\nMAPI_REHEARSAL_OPERATOR_TOKEN=${controlOperator}\n`);
console.log('Created private synthetic rehearsal secrets. Preserve them securely for this rehearsal.');
