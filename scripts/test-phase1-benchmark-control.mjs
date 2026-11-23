import assert from 'node:assert/strict';
import { verifyUserAudit } from './phase1-benchmark-control.mjs';
const project = { origin: 'https://example.test' };
await verifyUserAudit(async () => 1, project, 'user_1');
await assert.rejects(() => verifyUserAudit(async () => 0, project, 'user_1'), /missing or duplicated/);
await assert.rejects(() => verifyUserAudit(async () => 2, project, 'user_1'), /missing or duplicated/);
await assert.rejects(() => verifyUserAudit(async () => { throw Error('unavailable'); }, project, 'user_1'), /unavailable/);
console.log('Phase 1 benchmark rejects missing, duplicate, and unavailable audit evidence.');
