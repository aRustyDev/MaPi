import assert from 'node:assert/strict';
import { classifyFlowSubmission } from '../worker/flow-diagnostics.js';
const route = '/__nextgen/api/v1/flows/flow_test123/submit';
assert.equal(classifyFlowSubmission(route, JSON.stringify({ fields: { '/private/email': 'private@example.test' } })), 'identifier');
assert.equal(classifyFlowSubmission(route, JSON.stringify({ fields: { '/private/password': 'secret-value' } })), 'password');
assert.equal(classifyFlowSubmission(route, JSON.stringify({ fields: { '/private/mystery': 'secret-value' } })), 'other');
assert.equal(classifyFlowSubmission(route, '{'), 'other');
assert.equal(classifyFlowSubmission('/__nextgen/api/v1/sessions/exchange', '{}'), null);
console.log('Flow diagnostics classify only the submission type.');
