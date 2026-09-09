#!/usr/bin/env bash
set -euo pipefail
NATIVE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ARCHIVE="$NATIVE_DIR/sparkle-chain.tar.xz"
PATCH_SHA="$(shasum -a 256 "$NATIVE_DIR/patches/delta-chain.patch" | awk '{print $1}')"
if [[ -f "$ARCHIVE" && "$(tar -xOf "$ARCHIVE" ./.sparkle-chain)" == "$PATCH_SHA" ]]; then
  echo "[package-sparkle] prebuilt framework matches the source patch"
  exit 0
fi
WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/sparkle-package.XXXXXX")"
SPARKLE_VENDOR_DIR="$WORK_DIR/vendor" bash "$NATIVE_DIR/scripts/fetch-sparkle.sh"
tar -cJf "$WORK_DIR/sparkle-chain.tar.xz" -C "$WORK_DIR/vendor" .
mv "$WORK_DIR/sparkle-chain.tar.xz" "$ARCHIVE"
echo "[package-sparkle] ready: $ARCHIVE"
