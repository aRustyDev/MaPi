# Overload logging: local ingress proof

`logOverload` reports only the boolean platform overload classification and component. Previously a throwing log sink or an exception while reading the `overloaded` property escaped the handler's catch block. A synthetic test of the actual management ingress reproduced the escaped exception before the fix. The logger now treats classification and logging as best effort so the existing retryable response can be returned.

`node scripts/test-overload-logging-ingress.mjs` passes against the actual management ingress with a synthetic registry error: both a throwing log sink and a throwing classification getter return HTTP 503 with `Cache-Control: no-store`; the first response body is empty. `node scripts/test-runtime-diagnostics.mjs` also passes its existing assertions that only the boolean classification is logged and private error text is not included. These are Node tests, not Workerd, platform log-delivery, hosted limit-error or final-candidate evidence. No stopped or pending test, Woven deployment or AWS resource was touched.

The tested `worker/runtime-diagnostics.js` SHA-256 was `0f73d8894805efec5e595ce31a6fb5cae6fd529ffa27f1d2b4b09b2b7ba6b7d4`; the ingress regression test SHA-256 was `d2bb6461880cf18ab4f8732cae5fb6ff01c46fe3f5dd1c7f77fb6a179764558d`.

The existing `node scripts/test-flow-proxy.mjs`, `node scripts/test-oauth-ingress.mjs` and `node scripts/test-management-proxy.mjs` regressions also passed in Node. They do not establish platform logging availability or hosted behavior.
