// Create a disposable source snapshot for isolated near-limit qualification.
// The main build retains its reviewed default cap.
import { cp, mkdir, readFile, realpath, symlink, writeFile } from 'node:fs/promises';
import { isAbsolute, resolve, sep } from 'node:path';

const destination = process.argv[2];
if (!destination || !isAbsolute(destination)) throw Error('Supply a new absolute snapshot directory');
const root = process.cwd();
const target = resolve(destination);
if (target === root || target.startsWith(root + sep)) throw Error('Snapshot must be outside the source worktree');
await mkdir(target, { mode: 0o700 });
for (const name of ['worker', 'scripts']) {
  await cp(resolve(root, name), resolve(target, name), {
    recursive: true,
    filter: path => !path.split(sep).includes('.wrangler'),
  });
}
for (const name of ['package.json', 'package-lock.json']) await cp(resolve(root, name), resolve(target, name));
await symlink(await realpath(resolve(root, 'node_modules')), resolve(target, 'node_modules'));

async function replace(path, before, after) {
  const file = resolve(target, path);
  const source = await readFile(file, 'utf8');
  if (source.split(before).length !== 2) throw Error(`Candidate source differs in ${path}`);
  await writeFile(file, source.replace(before, after));
}
await replace('worker/relocation-chunks.js',
  'export const MAX_ROW_VALUE_BYTES = 8_388_608 - 4096;',
  'export const MAX_ROW_VALUE_BYTES = 8_388_608 + 800;');
for (const path of ['scripts/relocation-bounded-capacity-worker.mjs', 'scripts/test-relocation-bounded-capacity.mjs']) {
  const file = resolve(target, path);
  let source = await readFile(file, 'utf8');
  if (!source.includes('8_380_000') || !source.includes('2094998')) throw Error(`Candidate fixture differs in ${path}`);
  source = source.replaceAll('8_380_000', '8_388_000').replaceAll('2094998', '2096998');
  await writeFile(file, source);
}
console.log(`Candidate snapshot prepared at ${target}`);
