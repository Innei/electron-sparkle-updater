# Sparkle delta-chain patch

Base: Sparkle 2.9.4, commit `b6496a74a087257ef5e6da1c5b29a447a60f5bd7`. `fetch-sparkle.sh` pins and verifies both the source archive and upstream generation tools. `delta-chain.patch` is the maintained fork; no private Sparkle API is called from Electron.

The patch adds a bounded forward path planner to appcast selection, sequential downloads with aggregate progress (each patch's EdDSA signature is checked as soon as its download finishes, so a bad hop falls back to the full archive without fetching the rest), a securely coded prefix of download descriptors, and authenticated staging inside the existing installer process. It reuses Sparkle's installation, authorization, relaunch and full-archive fallback. Both ends of each edge must be in the selected window and stream. Every patch and output is validated against the original host's trust. The same staging function is exercised by the native tests.

`package-sparkle.sh` produces the prebuilt universal `native/sparkle-chain.tar.xz` during npm packing. Keeping the framework inside an archive preserves its symlinks. Consumers only extract this archive and build their Electron addon. To build in a source checkout without touching an existing vendor directory:

```sh
SPARKLE_VENDOR_DIR="$(mktemp -d)/vendor" bash native/scripts/fetch-sparkle.sh
```

## Verification

The release metadata checks require only Python's standard library:

```sh
pnpm test
pnpm test:history
```

Run the real download → installer → installation tests against a built framework:

```sh
python3 native/tests/integration.py \
  --framework native/vendor/Sparkle.framework \
  --tools native/vendor/bin
```

This creates isolated ad-hoc-signed fixture apps with a random bundle identifier and an ephemeral EdDSA key (no Keychain access). It checks a three-hop chain, corrupt and missing patches falling back once, a source outside the window, and cancellation during the second download. It preserves fixture logs under the printed temporary path and removes the test signing key.

Time chains against the full archive on the current machine (results and analysis in `docs/benchmarks/`):

```sh
python3 native/tests/benchmark.py \
  --framework native/vendor/Sparkle.framework \
  --tools native/vendor/bin --output results.jsonl
```

To run the planner and authenticated staging tests, apply the patch to a fresh checkout of the base commit, then:

```sh
xcodebuild -project /path/to/Sparkle/Sparkle.xcodeproj -scheme Sparkle \
  -configuration Debug -derivedDataPath /tmp/sparkle-chain-tests \
  CODE_SIGNING_ALLOWED=NO ARCHS=arm64 ONLY_ACTIVE_ARCH=YES \
  -only-testing:'Sparkle Unit Tests/SUDeltaChainTest' test
```

The optional real-bundle test reads `TEST_RUNNER_SPARKLE_CHAIN_FIXTURES=/path/to/manifest.json`. Its manifest contains `host` (the untouched extracted 0.39.4 `Kansoku.app`) and `steps`, each with `version`, `archive`, `size` and `signature` copied from the release's appcast. Use `0.39.4 → 0.41.0 → 0.42.0`. It authenticates and applies the real patches, then rejects a modified second patch. `result-path.txt` beside the manifest identifies the successful staging directory, which can be compared to the extracted 0.42.0 full ZIP (file bytes, modes, symlinks and code signature).

When updating the patch, rebuild the universal archive and repeat these checks. Never update the marker to claim an older framework contains a newer patch.
