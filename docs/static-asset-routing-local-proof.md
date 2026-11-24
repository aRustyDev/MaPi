# Login asset routing: local proof

`node scripts/test-static-asset-routing.mjs` runs the actual `worker/app.js` entry in disposable local workerd, with the real local Workers Static Assets binding and registry and owner bindings that record and reject access. For a GET of `/zitadel-login.mjs` with a query string, it verifies HTTP 200, JavaScript content type, the SHA-256 of the returned bytes against the local asset, one asset-binding call, and zero registry and project-object calls. Negative controls verify that a POST, a disabled official-login setting, and a different path do not take this bypass.

This uses the existing locally generated asset and Wasm, installed dependencies, and a temporary Wrangler configuration and storage directory. It does not establish hosted behavior, a clean build, asset integrity against upstream, or runtime latency. The sandbox required loopback permission for local workerd; the run did not contact or change a Woven deployment.
