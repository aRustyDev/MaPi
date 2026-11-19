// Diagnostic only: measure a flow + management + events owner graph.
process.env.MAPI_EVENTS_TEST = '1';
process.env.MAPI_MANAGEMENT_COMBINED = '1';
await import('./build-management-test.mjs');
