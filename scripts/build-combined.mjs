// Owner build: both upstream flow and management dependencies, no test helper.
process.env.MAPI_MANAGEMENT_COMBINED = '1';
process.env.MAPI_MANAGEMENT_PRODUCTION = '1';
await import('./build-management-test.mjs');
