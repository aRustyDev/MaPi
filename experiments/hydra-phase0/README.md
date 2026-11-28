# Hydra Phase 0 local reproducer

These files reproduce the pinned experimental handler and local fence checks described in [the evidence report](../../docs/hydra-phase-0-evidence.md). They include test-only control paths and are intended for disposable local data. Hosted transaction, browser, and fault-injection evidence requires a separate hosted staging setup.

Requirements are Git, Go 1.26.9, Node.js 24 or later, Binaryen 133, Docker, PostgreSQL 17, and the repository's installed Node dependencies. The build script checks the upstream commit before copying its tree. `go` may download the pinned toolchain and modules.

```sh
git clone --branch v26.2.0 https://github.com/ory/hydra.git /tmp/mapi-hydra-source
MAPI_HYDRA_WASM_OPT="$(command -v wasm-opt)" \
  experiments/hydra-phase0/build.sh /tmp/mapi-hydra-source /tmp/mapi-hydra-build
node experiments/hydra-phase0/probe-fence.mjs
```

The fence probe uses local workerd and a temporary SQLite persistence directory. It covers release-first and late-commit ordering, restart, scoped retry, and duplicate acknowledgments.

For the Postgres probe, build the native Hydra binary from the same clean pin and run the fixture script. The script starts a disposable `postgres:17-alpine` container bound to loopback, applies migrations, creates a confidential client, runs the workerd probe, and removes its container and temporary credentials on exit. It uses loopback ports 46344 and 46345 for the Hydra service. The client and system secrets are generated for the run.

```sh
GOTOOLCHAIN=go1.26.9 go -C /tmp/mapi-hydra-source build -o /tmp/mapi-hydra-native .
experiments/hydra-phase0/probe-local-postgres.sh /tmp/mapi-hydra-native /tmp/mapi-hydra-build
```

The probe asserts discovery and synthetic client-credentials issuance over the local Hyperdrive connection. The fence and workerd probes use Miniflare 5.20261118.0-beta. Install the repository dependencies before running them.
