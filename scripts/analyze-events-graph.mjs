import { readFile } from 'node:fs/promises';

const [baselinePath, eventPath] = process.argv.slice(2);
if (!baselinePath || !eventPath) throw Error('Usage: node scripts/analyze-events-graph.mjs BASELINE_GRAPH EVENT_GRAPH');
async function symbols(path) {
 const lines = (await readFile(path, 'utf8')).split('\n');
 return new Set(lines.flatMap(line => { const pos = line.indexOf(' -> '); return pos < 0 ? [] : [line.slice(pos + 4).trim()]; }));
}
const baseline = await symbols(baselinePath), event = await symbols(eventPath);
const added = [...event].filter(symbol => !baseline.has(symbol));
const generated = added.filter(symbol => symbol.startsWith('github.com/zitadel/nextgen/internal/api/generated.'));
console.log(JSON.stringify({ addedSymbols: added.length, generatedSymbols: generated.length, generatedContainingEvent: generated.filter(symbol => symbol.includes('Event')).length, typeSymbols: added.filter(symbol => symbol.startsWith('type:')).length, stringSymbols: added.filter(symbol => symbol.startsWith('go:string.')).length }, null, 2));
