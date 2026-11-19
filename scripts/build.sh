#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
commit=b0b74cd4a198428ea9b82910c217259ffc62b65c
source_dir="$PWD/.mapi/nextgen"
if [[ ! -e "$source_dir/.git" ]]; then
  mkdir -p "$source_dir"
  git -C "$source_dir" init -q
fi
if ! git -C "$source_dir" cat-file -e "$commit^{commit}" 2>/dev/null; then
  git -C "$source_dir" fetch --depth 1 --no-tags https://github.com/zitadel/nextgen.git "$commit"
fi
git -C "$source_dir" checkout --detach "$commit" --quiet
cp -R upstream/overlay/. "$source_dir/"
patch="$PWD/upstream/audit-tracing.patch"
if ! git -C "$source_dir" apply --reverse --unidiff-zero --check "$patch" 2>/dev/null; then
  git -C "$source_dir" apply --unidiff-zero "$patch"
fi
for file in dialect error pool with_transaction; do
  path="apps/api/internal/storage/dialect/sqlite/$file.go"
  {
    printf '//go:build !wasip1\n\n'
    git -C "$source_dir" show "$commit:$path"
  } > "$source_dir/$path"
done
mkdir -p worker/generated
wasm="$PWD/worker/generated/nextgen.wasm"
cd "$source_dir/apps/api"
GOWORK=off GOOS=wasip1 GOARCH=wasm CGO_ENABLED=0 GOTOOLCHAIN=go1.26.9 \
  go build -trimpath -ldflags='-s -w' -buildmode=c-shared -o "$wasm" ./cmd/mapi-wasm
