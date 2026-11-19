// Local-only owner build with the test-only project token helper.
process.env.MAPI_MANAGEMENT_COMBINED = '1';
await import('./build-management-test.mjs');
