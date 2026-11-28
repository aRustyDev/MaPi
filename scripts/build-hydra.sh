#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ $# -ne 1 ]]; then
  echo "usage: scripts/build-hydra.sh <pinned Hydra source checkout>" >&2
  exit 2
fi
build_dir=$(mktemp -d "${TMPDIR:-/tmp}/mapi-hydra-build.XXXXXX")
trap 'rm -rf -- "$build_dir"' EXIT
experiments/hydra-phase0/build.sh "$1" "$build_dir"
mkdir -p worker/generated
cp "$build_dir/hydra-phase0.wasm" worker/generated/hydra.wasm
cp "$build_dir/wasm_exec.js" worker/generated/hydra-wasm-exec.js
