// Events remain in an isolated local-only build, not the management owner.
process.env.MAPI_EVENTS_TEST = '1';
await import('./build-management-test.mjs');
