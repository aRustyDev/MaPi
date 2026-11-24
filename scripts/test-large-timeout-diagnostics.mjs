import assert from 'node:assert/strict';
import { inspectLocalMoveAfterTimeout } from './large-timeout-diagnostics.mjs';

const called = [];
const result = await inspectLocalMoveAfterTimeout(async action => {
  called.push(action);
  if (action === 'moveStatus') return { storedRouteState: 'active', phase: 'moving', finalized: false, secret: 'do-not-report' };
  if (action === 'exportStatus') return { next_chunk: 12, done: 0, cookie: 'do-not-report' };
  throw Error('private failure detail');
});
assert.deepEqual(called.sort(), ['exportStatus', 'importStatus', 'moveStatus']);
assert.deepEqual(result.observations, [
  { action: 'moveStatus', outcome: 'read', storedRouteState: 'active', phase: 'moving', finalized: false },
  { action: 'exportStatus', outcome: 'read', nextChunk: 12, done: false },
  { action: 'importStatus', outcome: 'unavailable' },
]);
assert.ok(!JSON.stringify(result).includes('do-not-report'));
assert.ok(!JSON.stringify(result).includes('private failure detail'));
const absent = await inspectLocalMoveAfterTimeout(async action => action === 'moveStatus' ? {} : action === 'exportStatus' ? null : { next_chunk: 4, done: 'no' });
assert.equal(absent.observations[1].outcome, 'missing');
assert.equal(absent.observations[2].outcome, 'invalid');
console.log('Local timeout diagnostics report only sanitized independent checkpoint observations.');
