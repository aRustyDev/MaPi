// Build a management-enabled artifact without test-only credential exports.
process.env.MAPI_MANAGEMENT_PRODUCTION = '1';
await import('./build-management-test.mjs');
