# Delta chain benchmark (2026-09-11)

Real updater, real patched framework, localhost HTTP. Machine: Apple M4 Max, 128 GB, APFS on internal NVMe, macOS 26. Run with:

```sh
python3 native/tests/benchmark.py --framework native/vendor/Sparkle.framework --tools native/vendor/bin \
  --bundle-mb 250 100 --delta-mb 1 5 20 --hops 1 5 10 20 --output results.jsonl
```

Fixture: an ad-hoc-signed app with one 230 MB "framework" blob, a 20 MB "asar" blob, 60 small locale files, and one `patch.bin` of 1 / 5 / 20 MB replaced with fresh random bytes per version (so each delta is exactly that size and incompressible). 21 versions per configuration, consecutive deltas only, `SUDeltaChainHistory = 32`. Every run installed version 20 and exited 0.

`apply` is the time from Sparkle's `extracting` event to `installing`, i.e. patch application + validation of every hop + installer stages 1–2. Download time over localhost is negligible and reported separately.

## Results (250 MB bundle)

| Configuration | Downloaded | apply (s) | total (s) |
|---|---|---|---|
| full archive | 257–276 MB | 3.0–3.1 | 3.1–3.3 |
| 1 hop × 1 MB | 1 MB | 3.2 | 3.2 |
| 5 hops × 1 MB | 5 MB | 4.3 | 4.3 |
| 10 hops × 1 MB | 10 MB | 3.7 | 3.8 |
| 20 hops × 1 MB | 20 MB | 6.1 | 6.2 |
| 1 hop × 5 MB | 5 MB | 2.7 | 2.7 |
| 5 hops × 5 MB | 25 MB | 2.8 | 2.8 |
| 10 hops × 5 MB | 50 MB | 3.8 | 3.8 |
| 20 hops × 5 MB | 100 MB | 6.1 | 6.2 |
| 1 hop × 20 MB | 20 MB | 2.5 | 2.6 |
| 5 hops × 20 MB | 100 MB | 2.8 | 2.9 |
| 10 hops × 20 MB | 200 MB | 4.2 | 4.3 |
| 20 hops × 20 MB | planner chose full (400 MB > 276 MB) | 2.6 | 2.7 |
| corrupt last hop of 10 (×1/5/20 MB) | chain + full = 267 / 311 / 476 MB | 2.1–2.2 after fallback | 4.4–4.9 |

100 MB bundle: full 2.1–2.6 s; 20 hops × 1 MB 3.8 s; 20 hops × 5 MB 3.1 s; 20 × 20 MB and 10 × 20 MB fell back to full by the byte rule.

Per-hop cost from the progress events inside the chain (steady state, first hop is ~0.1 s slower):

| Bundle | Per hop | 20 hops | Post-chain validation + install stages | Full-archive extract + validate |
|---|---|---|---|---|
| 250 MB | 0.23 s (0.27 s with 20 MB deltas) | 4.5 s | 1.5 s | 2.8 s |
| 100 MB | 0.12 s | 2.4 s | 0.6 s | 1.9 s |

Standalone CLI for one 250 MB hop: `BinaryDelta apply` 0.13 s, `codesign --verify` 0.10 s, `ditto -x -k` of the full zip 0.11–0.51 s.

## What a hop costs and why

Each hop (`SUApplyDeltaChain` → `applyBinaryDelta` → validator) reads the whole bundle about three times: SHA-1 of every file in the source tree (before-hash check), APFS clone of the tree plus the patch, SHA-1 of every file in the result (after-hash check), then `SecStaticCodeCheckValidity` over the staged bundle. Cost is linear in bundle size and nearly independent of delta size; on this machine it works out to about 1 ms per MB of bundle per hop. Delta bytes only matter for download.

The fixed ~1.5–3 s on every path is Autoupdate launch, XPC, and installer stages, and is the same for chains and full archives. The full archive's own extract + validate (2.8 s at 250 MB) costs about as much as 12 hops.

## When to take the full archive

Time model per update, with `N` hops of `D` MB, full zip `Z` MB, bandwidth `bw`, measured hop cost `h`:

```
T_chain = N·D / bw + N·h + 1.5 s
T_full  = Z / bw + 2.8 s
```

Using the measured 250 MB constants (h = 0.23 s):

| Bandwidth | Full 261 MB | 5×5 MB | 10×5 MB | 20×5 MB | 20×1 MB | 10×20 MB |
|---|---|---|---|---|---|---|
| 5 Mbps | 420 s | 43 s ✓ | 84 s ✓ | 166 s ✓ | 38 s ✓ | 324 s ✓ |
| 20 Mbps | 107 s | 13 s ✓ | 24 s ✓ | 46 s ✓ | 14 s ✓ | 84 s ✓ |
| 100 Mbps | 24 s | 5 s ✓ | 8 s ✓ | 14 s ✓ | 8 s ✓ | 20 s ✓ |
| 500 Mbps | 7 s | 3 s ✓ | 5 s ✓ | 8 s | 6 s ✓ | 7 s |

Same table for a pessimistic old Intel machine on a slow SSD (h = 1.8 s, tails 6 s / 12 s, ~8× slower):

| Bandwidth | Full 261 MB | 5×5 MB | 10×5 MB | 20×5 MB | 20×1 MB | 10×20 MB |
|---|---|---|---|---|---|---|
| 5 Mbps | 430 s | 55 s ✓ | 104 s ✓ | 202 s ✓ | 74 s ✓ | 344 s ✓ |
| 20 Mbps | 116 s | 25 s ✓ | 44 s ✓ | 82 s ✓ | 50 s ✓ | 104 s ✓ |
| 100 Mbps | 33 s | 17 s ✓ | 28 s ✓ | 50 s | 44 s | 40 s |
| 500 Mbps | 16 s | 15 s ✓ | 25 s | 44 s | 42 s | 27 s |

Conclusions:

- The existing byte rule ("chain only if Σ deltas < full zip") is the right primary rule. Below ~100 Mbps, bytes dominate so completely that a 20-hop chain still beats the full archive on the fast machine, and 10 hops still beat it on the slow one.
- Hop count only starts to matter on fast networks with slow disks. Expressed in download-equivalent bytes, one 250 MB hop costs ~3 MB at 100 Mbps on this machine, ~20 MB on the pessimistic machine. The current default window of 6 (`SUDeltaChainHistory`) keeps that under 20–120 MB, well inside the byte rule's margin for a 260 MB app.
- Going above ~10 hops buys little: a 10-hop delta chain already covers a release cadence of months, and beyond that the failure blast radius (below) grows faster than the byte savings. Recommendation: keep 6 as the default and treat 10 as the ceiling; do not raise toward 32 without also adding a per-hop byte penalty to the planner (`cost = Σ bytes + N × ~4 MB`), which is a one-line change in `SUDeltaChain`.
- Full archive is also the right answer when the release replaces most of the bundle (Electron upgrade): with `D` close to `Z` the byte rule already rejects the chain after one hop.

## Why one bad patch cannot break the installed app

From the patch (`SUDeltaChainApply.h`, `SPUCoreBasedUpdateDriver.m`), verified by the `corrupt-last-hop` rows and the integration test:

1. The installed bundle is never an input to writes. Every hop writes to a fresh `0700` directory inside Sparkle's private cache; the source of hop 1 is the host, the source of hop k is hop k−1's output.
2. Every patch is authenticated with EdDSA against the *installed* app's `SUPublicEDKey` and its expected length, twice: in the app process as soon as its download finishes (a mismatch stops the chain there and falls back without fetching the remaining patches), and again in the installer before applying. A key rotation, a tampered patch, or a truncated download fails here.
3. `applyBinaryDelta` checks the before-hash of the source tree and the after-hash of the result. A patch that does not match its base (user modified the app, wrong version) fails here.
4. The staged bundle must pass code-signature validation, carry the host's bundle identifier and the same `SUPublicEDKey`, and its version must be strictly newer than the previous hop.
5. Any failure aborts the whole chain (`complete == NO`), the cache directory is removed, and the core driver falls back once to the final full archive, which then goes through the ordinary Sparkle path. In the benchmark this cost 2.1 s of wasted apply plus the full download; the host stayed at its version until the full archive installed.
6. Cancellation, process death, or app quit during the chain installs nothing; the next check starts from scratch (partial chains are not resumed).

Costs of a failure, which is the real argument against long chains:

- Wasted download: the bytes up to and including the bad hop, then the full zip on top. A patch with a bad signature is rejected as soon as it finishes downloading; the `corrupt last hop of 10` rows above (chain + full, 476 MB in the 10 × 20 MB case) were measured before that check existed and are now the worst case, reached only when the last hop is the bad one. A patch that verifies but fails to apply (wrong base, tampered app) is still only discovered in the installer, after all `N` downloads.
- Disk peak during the chain: Σ deltas + 2 bundles (current and previous staging directories), plus the full zip if fallback triggers.

## Caveats

- The fixture has flat resources. Real Electron bundles nest `Electron Framework.framework` and helper apps, so per-hop code-sign validation is somewhat more expensive than measured here; expect the linear model to hold with a larger constant.
- HFS-compressed bundles (`ditto --hfsCompression` at packaging time) add one extra full copy per hop inside `applyBinaryDelta`.
- Single run per cell; run-to-run noise on the fixed overhead is about ±0.5 s.
