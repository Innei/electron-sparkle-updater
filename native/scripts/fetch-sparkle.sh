#!/usr/bin/env bash
set -euo pipefail

# npm releases carry this prebuilt universal framework. Only a source checkout
# or an explicit --force-fetch needs Xcode; application release CI reuses it.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NATIVE_DIR="$(dirname "$SCRIPT_DIR")"
VENDOR_DIR="${SPARKLE_VENDOR_DIR:-$NATIVE_DIR/vendor}"
PATCH_FILE="$NATIVE_DIR/patches/delta-chain.patch"
PATCH_SHA="$(shasum -a 256 "$PATCH_FILE" | awk '{print $1}')"
STAMP="$VENDOR_DIR/.sparkle-chain"
if [[ -f "$STAMP" && "$(cat "$STAMP")" == "$PATCH_SHA" && -d "$VENDOR_DIR/Sparkle.framework" ]]; then
  echo "[fetch-sparkle] bundled delta-chain framework is ready"
  exit 0
fi
if [[ -e "$VENDOR_DIR" ]]; then
  echo "[fetch-sparkle] vendor does not match this patch; use rebuild --force-fetch to regenerate it" >&2
  exit 1
fi
# Keep framework symlinks inside a tarball: npm does not preserve package symlinks.
ARCHIVE="$NATIVE_DIR/sparkle-chain.tar.xz"
if [[ -f "$ARCHIVE" && "$(tar -xOf "$ARCHIVE" ./.sparkle-chain)" == "$PATCH_SHA" ]]; then
  STAGING="$(mktemp -d "${TMPDIR:-/tmp}/sparkle-chain-unpack.XXXXXX")"
  tar -xf "$ARCHIVE" -C "$STAGING"
  mv "$STAGING" "$VENDOR_DIR"
  echo "[fetch-sparkle] extracted bundled universal framework"
  exit 0
fi
[[ "$(uname -s)" == Darwin ]] || { echo "Building Sparkle requires macOS and Xcode" >&2; exit 1; }

SOURCE_REV=b6496a74a087257ef5e6da1c5b29a447a60f5bd7
SOURCE_SHA=5c9992d04c90a11e538c95a6b059267e04ba87feb84e6e64982156899ae23a3a
TOOLS_SHA=ce89daf967db1e1893ed3ebd67575ed82d3902563e3191ca92aaec9164fbdef9
WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/sparkle-chain.XXXXXX")"
echo "[fetch-sparkle] building patched Sparkle 2.9.4; log: $WORK_DIR/build.log"
curl -fLsS --retry 3 "https://codeload.github.com/sparkle-project/Sparkle/tar.gz/$SOURCE_REV" -o "$WORK_DIR/source.tar.gz"
printf '%s  %s\n' "$SOURCE_SHA" "$WORK_DIR/source.tar.gz" | shasum -a 256 -c -
tar -xf "$WORK_DIR/source.tar.gz" -C "$WORK_DIR"
SOURCE_DIR="$WORK_DIR/Sparkle-$SOURCE_REV"
git -C "$SOURCE_DIR" apply --check "$PATCH_FILE"
git -C "$SOURCE_DIR" apply "$PATCH_FILE"
xcodebuild -project "$SOURCE_DIR/Sparkle.xcodeproj" -scheme Sparkle -configuration Release \
  -derivedDataPath "$WORK_DIR/build" CODE_SIGNING_ALLOWED=NO ARCHS="arm64 x86_64" ONLY_ACTIVE_ARCH=NO \
  build > "$WORK_DIR/build.log" 2>&1 || { tail -60 "$WORK_DIR/build.log" >&2; exit 1; }
mkdir "$WORK_DIR/vendor"
ditto "$WORK_DIR/build/Build/Products/Release/Sparkle.framework" "$WORK_DIR/vendor/Sparkle.framework"
# Consumers sign the embedded framework and helpers with their own identity.
codesign --force --deep --sign - "$WORK_DIR/vendor/Sparkle.framework"
lipo "$WORK_DIR/vendor/Sparkle.framework/Sparkle" -verify_arch arm64 x86_64
curl -fLsS --retry 3 "https://github.com/sparkle-project/Sparkle/releases/download/2.9.4/Sparkle-2.9.4.tar.xz" -o "$WORK_DIR/tools.tar.xz"
printf '%s  %s\n' "$TOOLS_SHA" "$WORK_DIR/tools.tar.xz" | shasum -a 256 -c -
tar -xf "$WORK_DIR/tools.tar.xz" -C "$WORK_DIR/vendor" bin/generate_keys bin/sign_update bin/generate_appcast bin/BinaryDelta
printf '%s\n' "$PATCH_SHA" > "$WORK_DIR/vendor/.sparkle-chain"
mv "$WORK_DIR/vendor" "$VENDOR_DIR"
echo "[fetch-sparkle] universal framework and tools ready at $VENDOR_DIR"
