# Private FAPI browser build size

On November 19, 2026, a Wrangler dry run for the local-only FAPI browser test Worker reported **54,992.82 KiB** total uncompressed upload and **11,093.56 KiB** gzip. The roadmap's initial uncompressed budget is 55 MiB (56,320 KiB), leaving approximately 1,327 KiB in this diagnostic bundle. This is a build measurement, not a deployment or a measurement of startup, CPU, memory, latency or concurrency. The test Worker, test-only routes and fixture are not production ingress; a real release bundle may differ.

After building the local browser artifact and login assets used by `node scripts/test-fapi-browser.mjs`, reproduce with:

```sh
npx wrangler deploy --config scripts/fapi-browser-test.wrangler.jsonc --dry-run --outdir /tmp/mapi-fapi-dry-run
```

The generated Wasm and assets are ignored build products. Repeat the measurement against the exact committed release artifact and obtain hosted isolate memory, startup and load metrics before enabling an issuer. Passing the upload budget does not show that the 128 MB memory and other runtime limits will be met.
