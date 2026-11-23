// Summarize a private wrangler tail --format=json capture without copying
// request URLs, headers, credentials, exception messages, or response bodies.
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

const path = process.argv[2];
if (!path) throw new Error('Usage: node scripts/summarize-phase1-tail.mjs PRIVATE_JSONL_FILE');
const stats = { records: 0, malformed: 0, invalidFields: 0, byOutcome: {}, invocations: [], markers: [], overloads: 0, completeness: 'unverified' };
const allowedEvents = new Set(['mapi.worker.boot', 'mapi.owner.boot', 'mapi.reactor.ready', 'mapi.wasm.highwater', 'mapi.overload', 'mapi.flow.submit']);
const outcomes = new Set(['ok', 'unknown', 'exception', 'exceededCpu', 'exceededMemory', 'scriptNotFound', 'canceled', 'responseStreamDisconnected', 'killSwitch', 'daemonDown', 'loadShed']);
const executionModels = new Set(['stateless', 'durableObject']);
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const objectId = value => typeof value === 'string' && /^[0-9a-f]{64}$/i.test(value);
const nonnegative = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const integer = value => Number.isSafeInteger(value) && value >= 0;
function field(value, predicate, required = false) {
  if (value === undefined || value === null) {
    if (required) stats.invalidFields++;
    return null;
  }
  if (predicate(value)) return value;
  stats.invalidFields++;
  return null;
}
let buffer = '', depth = 0, inString = false, escaped = false;
for await (const line of createInterface({ input: createReadStream(path), crlfDelay: Infinity })) {
  if (!buffer && !line.trim()) continue;
  buffer += line + '\n';
  for (const character of line) {
    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
    } else if (character === '"') inString = true;
    else if (character === '{' || character === '[') depth++;
    else if (character === '}' || character === ']') depth--;
  }
  if (depth > 0) continue;
  let entry;
  try { entry = JSON.parse(buffer); } catch { stats.malformed++; buffer = ''; depth = 0; inString = false; escaped = false; continue; }
  buffer = '';
  if (!entry || typeof entry !== 'object' || Array.isArray(entry) || (entry.logs !== undefined && !Array.isArray(entry.logs))) { stats.malformed++; continue; }
  stats.records++;
  const outcome = outcomes.has(entry.outcome) ? entry.outcome : 'unknown';
  if (entry.outcome !== undefined && !outcomes.has(entry.outcome)) stats.invalidFields++;
  stats.byOutcome[outcome] = (stats.byOutcome[outcome] ?? 0) + 1;
  const invocationIndex = stats.invocations.length;
  const timestamp = field(entry.eventTimestamp, integer);
  stats.invocations.push({
    timestamp,
    executionModel: field(entry.executionModel, value => executionModels.has(value)),
    durableObjectId: field(entry.durableObjectId, objectId),
    scriptVersion: field(entry.scriptVersion?.id, uuid),
    outcome,
    cpuTimeMs: field(entry.cpuTime, nonnegative),
    wallTimeMs: field(entry.wallTime, nonnegative),
  });
  for (const record of entry.logs ?? []) {
    if (!record || typeof record !== 'object' || Array.isArray(record)) { stats.malformed++; continue; }
    const message = Array.isArray(record.message) ? record.message[0] : record.message;
    let marker;
    try { marker = typeof message === 'string' ? JSON.parse(message) : message; } catch { continue; }
    if (!marker || typeof marker !== 'object' || Array.isArray(marker) || !allowedEvents.has(marker.event)) continue;
    if (marker.event === 'mapi.overload') stats.overloads++;
    const requires = {
      'mapi.worker.boot': ['bootId'],
      'mapi.owner.boot': ['bootId', 'objectId'],
      'mapi.reactor.ready': ['bootId', 'objectId', 'initialization', 'wasmHighWaterBytes'],
      'mapi.wasm.highwater': ['bootId', 'objectId', 'wasmHighWaterBytes'],
      'mapi.overload': ['component'],
      'mapi.flow.submit': ['bootId', 'kind'],
    }[marker.event];
    const required = name => requires.includes(name);
    const markerObjectId = field(marker.objectId, objectId, required('objectId'));
    const ownerSpecific = ['mapi.owner.boot', 'mapi.reactor.ready', 'mapi.wasm.highwater', 'mapi.flow.submit'].includes(marker.event);
    const invocationObjectId = stats.invocations[invocationIndex].durableObjectId;
    const model = stats.invocations[invocationIndex].executionModel;
    const attributionValid = ownerSpecific ? invocationObjectId !== null && (model === null || model === 'durableObject') &&
      (markerObjectId !== null ? markerObjectId.toLowerCase() === invocationObjectId.toLowerCase() : !required('objectId')) :
      marker.event === 'mapi.worker.boot' && model !== null ? model === 'stateless' : null;
    if (attributionValid === false) stats.invalidFields++;
    stats.markers.push({
      invocationIndex,
      timestamp,
      logTimestamp: field(record.timestamp, integer),
      event: marker.event,
      kind: marker.event === 'mapi.flow.submit' ? field(marker.kind, value => ['password', 'identifier', 'other'].includes(value), required('kind')) : null,
      bootId: field(marker.bootId, uuid, required('bootId')),
      objectId: markerObjectId,
      attributionValid,
      component: field(marker.component, value => ['application', 'management'].includes(value), required('component')),
      initialization: field(marker.initialization, value => integer(value) && value > 0, required('initialization')),
      wasmHighWaterBytes: field(marker.wasmHighWaterBytes, value => integer(value) && value > 0 && value % 65536 === 0, required('wasmHighWaterBytes')),
    });
  }
}
if (buffer.trim()) stats.malformed++;
console.log(JSON.stringify(stats, null, 2));
if (stats.malformed || stats.invalidFields) process.exitCode = 1;
