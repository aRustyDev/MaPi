// Local-only event+OAuth fixture. Never run this builder in the implementation
// checkout or deploy its output: the event graph exceeds the Worker budget.
import { execFileSync } from 'node:child_process';
import { readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const cwd = await realpath('.');
if (!/^\/private\/tmp\/mapi-large-audit\.[A-Za-z0-9]+$/.test(cwd)) throw Error('Build only in a disposable /private/tmp/mapi-large-audit.* copy');
let source = await readFile('scripts/build-management-test.mjs', 'utf8');
const replaceOne = (before, after) => {
  if (source.split(before).length !== 2) throw Error('Build source anchor missing or ambiguous');
  source = source.replace(before, after);
};
replaceOne("...(phase1 ? ['mapi_oauth'] : [])", "...(phase1 || events ? ['mapi_oauth'] : [])");
replaceOne("const wasmName = phase1 ? 'phase1-owner.wasm' : graphDiagnostic ? `events-graph-${graphDiagnostic}-test.wasm` : events ? (combined ? (noinline ? `events-combined-${noinlineSuffix}-test.wasm` : 'events-combined-test.wasm') : (noinline ? `events-${noinlineSuffix}-test.wasm` : 'events-test.wasm')) : combined ? (production ? 'combined.wasm' : 'combined-test.wasm') : (production ? 'management.wasm' : 'management-test.wasm');", "const wasmName = 'events-audit-relocation-test.wasm';");
const appPathStart = source.indexOf('  const appPath = '), appPathEnd = source.indexOf('\n', appPathStart);
if (appPathStart < 0 || appPathEnd < 0 || source.indexOf('  const appPath = ', appPathEnd) !== -1) throw Error('Build app path anchor missing or ambiguous');
source = source.slice(0, appPathStart) + "  const appPath = 'worker/generated/events-audit-relocation-test-app.js';" + source.slice(appPathEnd);
const temporary = resolve('worker/generated/build-large-audit-relocation-private.mjs');
await writeFile(temporary, source, { flag: 'wx' });
try {
  execFileSync(process.execPath, [temporary], { stdio: 'inherit', env: { ...process.env, MAPI_MANAGEMENT_PRODUCTION: '0', MAPI_PHASE1_OWNER: '0', MAPI_MANAGEMENT_COMBINED: '1', MAPI_EVENTS_TEST: '1', MAPI_EVENTS_GRAPH_DIAGNOSTIC: '', MAPI_EVENTS_GRAPH_DUMP: '0', MAPI_WASM_NO_INLINE: '' } });
} finally {
  await rm(temporary, { force: true });
}
