# electron-sparkle-updater — design

Date: 2026-07-18
Status: approved (brainstormed in the kansoku session that extracted this library)

## Why

Electron's update story on macOS is Squirrel.Mac (`electron-updater` / built-in `autoUpdater`). Sparkle — the de-facto macOS update framework used by most native Mac apps — has no maintained Electron bridge on npm. Other ecosystems have one (Tauri: `tauri-plugin-sparkle-updater`; Rust: `sparkle-updater`; Flet: `sparkle_auto_updater`); Electron does not (see electron/electron#29057).

This library extracts a working production integration from the Kansoku desktop app (`Innei/kansoku`): an N-API bridge to Sparkle.framework plus the release toolchain (appcast generation, EdDSA signing, delta updates) that makes Sparkle actually usable end to end.

## Scope

In:

- Runtime bridge: N-API native module calling Sparkle.framework, with a TypeScript loader that resolves the addon path in dev and packaged (`app.asar.unpacked`) layouts and degrades to `null` on failure.
- Cross-platform fallback updater (`./fallback`): platform-independent "weak" checker — GitHub releases polling, version comparison, throttling, result state — with app-injected callbacks for notification and opening URLs. Serves Windows/Linux (no Sparkle) and macOS when the bridge fails to load.
- Consumer build tooling: a `rebuild` command that fetches a pinned, checksum-verified Sparkle.framework and runs `node-gyp rebuild` against the Electron ABI.
- electron-builder integration (`./builder`): config fragments (Frameworks extraFiles, asarUnpack, `SUFeedURL`/`SUPublicEDKey` extendInfo placeholder convention, blockmap opt-out) and an afterPack ad-hoc signing hook.
- Release toolchain: CLI wrapping Sparkle's `generate_appcast` (delta-base fetching, embedded release notes, enclosure URL re-pointing to per-tag release assets) and a reusable composite GitHub Action (fetch Sparkle tools, RAM-disk private-key signing, publish).

Platform positioning: this library solves a macOS-specific pain (Squirrel.Mac requires a paid signing identity; Sparkle works with ad-hoc signing). On Windows/Linux the ecosystem answer is already good — `electron-updater` (NSIS with differential updates; AppImage) or store channels (MSIX/winget, Snap/Flatpak) — so the recommended combination is "this library on macOS, electron-updater elsewhere". `./fallback` is the minimal notify-only option for apps that don't want electron-updater or ship formats without in-app update (bare zip, deb). This goes in the README.

Out:

- A native Windows bridge (WinSparkle) — future direction, documented in the README, not built now.
- Update UI — Sparkle ships its own standard UI; the fallback exposes state, the app renders it.
- Prebuilt binaries — source distribution only; consumers compile at build time (requires Xcode CLT).

## Package shape

Single npm package `electron-sparkle-updater`, this repo, source-distributed:

```
electron-sparkle-updater/
├── src/index.ts            # main entry: loadSparkleBridge + SparkleBridge types
├── src/fallback.ts         # ./fallback: cross-platform weak updater
├── src/builder.ts          # ./builder: electron-builder config fragments + afterPack hook
├── native/
│   ├── src/sparkle_bridge.mm
│   ├── binding.gyp
│   └── scripts/fetch-sparkle.sh
├── cli/                    # bin: rebuild, generate-appcast wrapper, fix-enclosure-urls, inject-public-key
├── action/                 # composite GitHub Action for release CI
└── docs/                   # integration guide
```

## Runtime API (main entry)

Generalization of the extracted `sparkle.ts`:

- `loadSparkleBridge({ isPackaged, resourcesPath, moduleUrl, log? }): SparkleBridge | null`
  - Non-darwin platforms return `null` immediately without touching the native module.
  - Dev resolves the addon inside the package build dir; packaged resolves under `app.asar.unpacked`.
  - Any load/shape failure returns `null` (never throws) so the app can fall back.
- `SparkleBridge`: `init({ appcastUrl, publicEdKey }): boolean`, `checkForUpdates()`, `installUpdateNow()`, `setAutomaticChecks(enabled)`.
- Everything currently hardcoded in Kansoku (repo slug, appcast URL) is a parameter.

## Fallback API (`./fallback`)

Extraction of Kansoku's `updater.ts` pure logic, parameterized:

- `checkForUpdate(deps)` with injected `fetchJson` / `readLastCheck` / `writeLastCheck` / `notify` / clock; result union: `throttled | fetch-failed | no-release | up-to-date | available`.
- Version comparison tolerant of `v` / custom tag prefixes (prefix configurable).
- Release source: GitHub releases `latest` endpoint, owner/repo as parameters. Other sources can come later behind the same `fetchJson` seam.
- No Electron imports in the core — the Electron-flavored convenience wiring (userData state file, Notification, shell.openExternal) ships as a separate helper so the core stays testable in plain Node.

## Consumer build flow

- `install` script stays a deliberate no-op: npm auto-runs `node-gyp rebuild` for any package with a `binding.gyp`, using the host Node ABI — wrong target, wasted build. Documented prominently.
- `electron-sparkle-updater rebuild --electron-version X --arch arm64|x64|universal` does the real work: `fetch-sparkle.sh` (pinned version + sha256) then `node-gyp rebuild` with `--dist-url=https://electronjs.org/headers`.
- `binding.gyp` no longer hardcodes `ARCHS: arm64`; arch follows the flag. rpath convention unchanged: `vendor/` for dev, `@loader_path/../../../../../../Frameworks` for the packaged app.

## Release toolchain

- `./builder` exports fragments the app merges into its own electron-builder config, plus the afterPack ad-hoc signing hook (sign once before dmg/zip are packaged so both embed a valid CodeDirectory).
- The `SUPublicEDKey` placeholder convention (greppable string swapped by CI) is provided by the lib: `inject-public-key` CLI command.
- `generate-appcast` CLI: wraps Sparkle's `generate_appcast` with delta-base download (previous N release zips filtered by tag prefix), `--embed-release-notes` from a sidecar `.md`, and enclosure URL re-pointing so old items reference their own release tags.
- Composite GitHub Action: fetch pinned Sparkle tools with checksum, write the EdDSA private key to a RAM disk only, sign + generate appcast, scrub the key, publish assets.

## Migration (dogfooding)

After phase 1 ships, `Innei/kansoku` `apps/desktop` drops its local `native/sparkle-bridge/` and duplicated scripts, depends on this package, moves its weak-checker core onto `./fallback`, and swaps the Sparkle sections of `desktop-release.yml` for the Action. App-specific UI glue (status store wiring to the titlebar badge, dialogs, notifications) stays in the app.

## Phases

1. Repo scaffolding + runtime bridge + `rebuild` command + `./builder` fragments — usable by hand-rolled CI.
2. Release toolchain: CLI + composite Action + `./fallback`.
3. Kansoku migration (separate repo, separate PRs).

Each phase is independently shippable.
