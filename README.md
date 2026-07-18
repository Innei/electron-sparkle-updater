# electron-sparkle-updater

**Status: work in progress.** Phase 1 (this repo) is scaffolding + native bridge + rebuild CLI + builder fragments; the appcast CLI and release GitHub Action land in a later phase.

Electron's update story on macOS is Squirrel.Mac (`electron-updater` / the built-in `autoUpdater`). Sparkle — the de-facto macOS update framework used by most native Mac apps — has no maintained Electron bridge on npm. This library provides one: an N-API bridge to Sparkle.framework plus the release toolchain (appcast generation, EdDSA signing, delta updates) needed to make Sparkle actually usable end to end, extracted from a production Electron app. It solves a macOS-specific pain (Squirrel.Mac requires a paid signing identity; Sparkle works with ad-hoc signing) — on Windows/Linux the ecosystem answer is already good (`electron-updater`, or store channels), so the recommended combination is this library on macOS, `electron-updater` elsewhere.

## Install

```
npm install electron-sparkle-updater
```

### Why `install` is a no-op

This package ships a `binding.gyp` for its native Sparkle bridge. npm auto-runs `node-gyp rebuild` for any package containing a `binding.gyp`, built against the host Node ABI — the wrong target, since this addon must run inside Electron's ABI instead. The `install` script is therefore a deliberate no-op (`node -e ""`); the real build is the explicit `electron-sparkle-updater rebuild` command, run against the Electron version you actually ship.
