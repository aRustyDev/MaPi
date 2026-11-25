// Focused private-chunk parser checks. No Workerd, real owner, registry,
// history integration, relocation fixture, or external service is involved.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { exportChunk, importChunk } from '../worker/relocation-chunks.js';

const marker = 'synthetic-private-marker';
const bad = `${marker}"`;
const digest = value => createHash('sha256').update(value).digest('hex');
const safeError = expected => error => {
  assert.equal(error.message, expected);
  assert.equal(String(error.stack).includes(marker), false);
  assert.equal(error.cause, undefined);
  return true;
};

let transactions = 0;
const untouched = { transactionSync() { transactions++; throw Error('unexpected transaction'); } };
await assert.rejects(() => importChunk(untouched, 'p', { content:bad, digest:digest(bad) }), safeError('Invalid relocation chunk'));
assert.equal(transactions, 0);
await assert.rejects(() => importChunk(untouched, 'p', { content:bad, digest:'0'.repeat(64) }), safeError('Invalid chunk digest or size'));
assert.equal(transactions, 0);

// Supply only the read-only control rows needed to reach each parser. Any
// attempted write fails the test. The fake is not migration or fence evidence.
function exportStorage({ tables = '["users"]', cursor = null, content = null } = {}) {
  let writes = 0;
  const checkpoint = { text_guard: 1, project_id:'p', generation:1, move_id:'m', next_chunk:0, done:0,
    tables, table_index:0, row_offset:0, cursor, chain:'', fragment_offset:0 };
  const state = { project_id:'p', generation:1, move_id:'m', state:'frozen', digest:null, object_name:'source' };
  return { get writes() { return writes; }, transactionSync(fn) { return fn(); }, sql:{ exec(statement) {
    if (/^\s*(?:INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER)\b/i.test(statement)) { writes++; throw Error('unexpected write'); }
    let result;
    if (statement.includes("name = 'mapi_owner_fence'")) result=[];
    else if (statement.includes('FROM mapi_relocation_project WHERE project_id')) result=[state];
    else if (statement.includes('FROM mapi_chunk_export WHERE project_id')) result=[checkpoint];
    else if (statement.includes('FROM mapi_chunk_export_data WHERE project_id')) result=content === null ? [] : [{content,digest:null}];
    else if (statement.startsWith('PRAGMA table_xinfo')) result=[{name:'id',hidden:0,pk:1}];
    else if (statement.includes('SELECT sql FROM sqlite_schema')) result=[{sql:'CREATE TABLE users (id TEXT PRIMARY KEY)'}];
    else throw Error('unexpected query');
    return { toArray:() => result };
  }} };
}
for (const [scenario, expected] of [
  [{tables:bad}, 'Invalid export table checkpoint'],
  [{cursor:bad}, 'Invalid export cursor checkpoint'],
  [{content:bad}, 'Invalid relocation chunk'],
]) {
  const storage=exportStorage(scenario);
  await assert.rejects(() => exportChunk(storage, 'p', 1, 'm', 0), safeError(expected));
  assert.equal(storage.writes, 0);
}
console.log('Private relocation parse errors are redacted');
