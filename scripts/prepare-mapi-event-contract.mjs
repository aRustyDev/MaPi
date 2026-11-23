// Augment the upstream source generator in a disposable pinned archive. The
// MaPi-only types extend audit reads, not the upstream webhook delivery set.
import { readFile, realpath, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve, sep } from 'node:path';
import { mapiEvents, mapiPayloads } from './mapi-event-contract.mjs';

export async function prepareMaPiEventContract(archive, nonce) {
const root = await realpath(archive);
if (root !== resolve(archive) || basename(root) !== 'nextgen' || !/^mapi-management-build-[A-Za-z0-9]+$/.test(basename(dirname(root))) || !['/private/tmp/', '/private/var/folders/', '/var/folders/'].some(prefix => root.startsWith(prefix))) throw Error('Expected a fresh builder-owned upstream archive');
if (typeof nonce !== 'string' || nonce.length < 32 || await readFile(resolve(root, '.mapi-event-build-marker'), 'utf8') !== nonce) throw Error('Invalid disposable archive marker');
const api = resolve(root, 'apps/api/api');
if (!api.startsWith(root + sep) || await realpath(api) !== api) throw Error('Invalid archive path');
const generator = resolve(api, 'cmd/gen_event_schemas/main.go');
const testPath = resolve(api, 'cmd/gen_event_schemas/main_test.go');
const payloadDir = resolve(api, 'openapi/endpoints/events/payloads');
const eventHandler = resolve(root, 'apps/api/internal/api/event.go');
for (const path of [generator, testPath, payloadDir, eventHandler]) if (await realpath(path) !== path) throw Error('Symlink in archive contract path');
let text = await readFile(generator, 'utf8');
const replaceOne = (before, after) => {
  if (text.split(before).length !== 2) throw Error('Pinned event generator anchor missing or ambiguous');
  text = text.replace(before, after);
};
const entries = mapiEvents.map(([type, payload]) => `\t${JSON.stringify(type)}: ${JSON.stringify(payload)},`).join('\n');
replaceOne('var payloadByEventType = map[string]string{', `var payloadByEventType = map[string]string{\n${entries}`);
const types = mapiEvents.map(([type]) => `\t${JSON.stringify(type)},`).join('\n');
replaceOne('// webhookTag groups the webhooks;', `// MaPi events are read-only contract variants. They are not webhook declarations.\nvar mapiReadEventTypes = []string{\n${types}\n}\n\n// webhookTag groups the webhooks;`);
replaceOne('\tif err := validateMappings(eventTypes, payloadsDir); err != nil {', '\treadEventTypes := append(append([]string(nil), eventTypes...), mapiReadEventTypes...)\n\tif err := validateMappings(readEventTypes, payloadsDir); err != nil {');
replaceOne('\tsort.Strings(eventTypes)\n\tfor _, et := range eventTypes {', '\tsort.Strings(readEventTypes)\n\tfor _, et := range readEventTypes {');
replaceOne('if err := writeEventUnion(outDir, eventTypes);', 'if err := writeEventUnion(outDir, readEventTypes);');
await writeFile(generator, text);
let test = await readFile(testPath, 'utf8');
const before = '\trequire.NoError(t, validateMappings(eventTypes, payloadsDir))';
if (test.split(before).length !== 2) throw Error('Pinned event generator test anchor missing or ambiguous');
test = test.replace(before, '\trequire.NoError(t, validateMappings(append(eventTypes, mapiReadEventTypes...), payloadsDir))');
await writeFile(testPath, test);
let handler = await readFile(eventHandler, 'utf8');
const importAnchor = '"github.com/zitadel/nextgen/internal/domain"';
const resultAnchor = '\treturn &out, nil\n}';
if (handler.split(importAnchor).length !== 2 || handler.split(resultAnchor).length !== 2) throw Error('Pinned event handler anchor missing or ambiguous');
handler = handler.replace(importAnchor, importAnchor + '\n\t"github.com/zitadel/nextgen/internal/mapieventcontract"');
handler = handler.replace(resultAnchor, `\tif len(e.EventType) >= 5 && string(e.EventType[:5]) == "mapi." {
\t\tencoded, err := out.MarshalJSON()
\t\tif err != nil { return nil, domain.ErrInternal(err).WithMessage("failed to encode MaPi audit event") }
\t\tif err := mapieventcontract.ValidatePayload(events.NormalizeJSON(e.Payload), encoded); err != nil {
\t\t\treturn nil, domain.ErrInternal(err).WithMessage("MaPi audit payload cannot be represented without loss")
\t\t}
\t}
${resultAnchor}`);
await writeFile(eventHandler, handler);
for (const [name, schema] of Object.entries(mapiPayloads)) {
  await writeFile(resolve(payloadDir, name), JSON.stringify(schema, null, 2) + '\n', { flag: 'wx' });
}
}
