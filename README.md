# electron-sparkle-updater

An Electron bridge and release toolchain for Sparkle, including bounded multi-hop delta updates. Kansoku consumes the bridge and release Action.

Electron's update story on macOS is Squirrel.Mac (`electron-updater` / the built-in `autoUpdater`). Sparkle — the de-facto macOS update framework used by most native Mac apps — has no maintained Electron bridge on npm. This library provides one: an N-API bridge to Sparkle.framework plus the release toolchain (appcast generation, EdDSA signing, delta updates) needed to make Sparkle actually usable end to end, extracted from a production Electron app.

**Platform positioning.** This solves a macOS-specific pain: Squirrel.Mac requires a paid Developer ID signing identity, while Sparkle works fine with ad-hoc signing. On Windows/Linux the ecosystem answer is already good — `electron-updater` (NSIS with differential updates, AppImage) or store channels (MSIX/winget, Snap/Flatpak) — so the recommended combination is **this library on macOS, `electron-updater` elsewhere**.

## Requirements

- macOS 12+ (matches Sparkle's `MACOSX_DEPLOYMENT_TARGET`)
- Node >= 20.19 (the afterPack wrapper relies on require() of ES modules)
- Electron >= 28
- Xcode Command Line Tools (`xcode-select --install`) — needed to compile the native addon
- Either ad-hoc signing or a Developer ID certificate; both work with Sparkle

## Install

```
npm install electron-sparkle-updater
```

### Why `install` is a no-op

This package ships a `binding.gyp` for its native Sparkle bridge. npm auto-runs `node-gyp rebuild` for any package containing a `binding.gyp`, built against the host Node ABI — the wrong target, since this addon must run inside Electron's ABI instead. The `install` script is therefore a deliberate no-op (`node -e ""`); the real build is the explicit `electron-sparkle-updater rebuild` command, run against the Electron version you actually ship.

## Build

```
electron-sparkle-updater rebuild [--electron-version <v>] [--arch arm64|x64|universal] [--force-fetch]
```

- `--electron-version` defaults to the version resolved from your project's own `electron` dependency (`require("electron/package.json").version`); pass it explicitly if `electron` isn't installed yet at the time you run this.
- `--arch` defaults to `process.arch`. `--arch universal` builds arm64 and x64 separately, then `lipo`-combines them into one binary.
- `--force-fetch` regenerates `native/vendor` from the bundled framework archive. In a source checkout without that archive, it builds the pinned Sparkle patch with Xcode.

Run it wherever your build pipeline needs a fresh native addon for the target Electron ABI — typically one of:

- `postinstall` of your app (rebuilds every time `electron`'s version changes)
- a `predev` script (so local development always has a matching addon)
- a `prepackage` step right before `electron-builder` runs

## Runtime

```ts
import { loadSparkleBridgeForApp } from "electron-sparkle-updater";

const bridge = await loadSparkleBridgeForApp((message) => console.log("[sparkle]", message));

if (bridge) {
  bridge.init({
    appcastUrl: "https://example.com/appcast.xml",
    publicEdKey: "<your Sparkle EdDSA public key>",
  });
  bridge.setEventHandler((event) => {
    // checking | update-available | download-progress | update-downloaded | update-not-available | error
    console.log("[sparkle]", event.type, event);
  });
  bridge.setAutomaticChecks(true);
} else {
  // non-darwin, or the native addon isn't available — fall back to
  // electron-updater or another update path
}
```

`loadSparkleBridgeForApp` lazily imports `electron`, reads `app.isPackaged` and `process.resourcesPath`, and resolves the native addon accordingly. It never throws: any failure (wrong platform, missing addon, addon missing an expected export) logs through the optional callback and returns `null`, leaving the fallback decision to your app.

**Degradation contract:**

- On any non-darwin platform, both `loadSparkleBridge` and `loadSparkleBridgeForApp` return `null` immediately, before touching the filesystem.
- On darwin, `null` still means "no bridge available" (addon missing, failed to load, or missing one of the required methods) — your app is expected to have a fallback path (e.g. `electron-updater`, or a manual "download the new version" link).

The native user driver is silent: Sparkle never presents its permission, found-update, progress, or install dialogs. Download progress and ready-to-install land on `setEventHandler`; `installUpdateNow()` is what relaunches, and `installUpdateOnQuit()` defers the install to the app's own termination.

`SparkleBridge` exposes:

| Method | Purpose |
| --- | --- |
| `init({ appcastUrl, publicEdKey, httpHeaders })` | wires the feed URL and EdDSA public key, returns whether Sparkle initialized |
| `setEventHandler(fn)` | receives update lifecycle events for in-app UI (`checking`, `update-available`, `download-progress`, `update-downloaded`, `update-not-available`, `error`) |
| `checkForUpdates()` | starts a silent update check (no native Sparkle windows) |
| `installUpdateNow()` | installs an already-downloaded update immediately, or checks and installs if one is ready |
| `installUpdateOnQuit()` | leaves a downloaded update staged so Sparkle installs it when the app next quits on its own; if nothing is staged yet, the next `update-downloaded` is staged the same way |
| `setAutomaticChecks(enabled)` | toggles Sparkle's periodic background check |

The `appcastUrl` points at the XML feed generated by Sparkle's `generate_appcast` (see Releasing below); the `publicEdKey` is the EdDSA public key half of the keypair used to sign each release — see Packaging for how it gets into the built app. `httpHeaders` is passed straight through to Sparkle's own `SPUUpdater.httpHeaders`, applied to both the appcast and enclosure fetch — useful when the feed is hosted somewhere that needs auth (e.g. a private release host).

For advanced layouts, `loadSparkleBridge(deps)` (the lower-level function `loadSparkleBridgeForApp` calls) accepts an `addonPath` override and explicit `isPackaged`/`resourcesPath` values instead of importing `electron` itself.

## Packaging

Run `rebuild` before packaging. It extracts the prebuilt universal framework from the npm package into `native/vendor/Sparkle.framework` and compiles the N-API addon for your Electron version. Framework symlinks are preserved inside `native/sparkle-chain.tar.xz`; the builder excludes that archive from the application. App release CI does not compile Sparkle. Publishing this library runs `prepack`, which builds the framework from pinned source and the checked-in patch when needed (full Xcode required).

`sparkleBuilderConfig` returns the electron-builder config fragment this library needs — extend, don't replace, your existing config:

```ts
// electron-builder.config.ts (or .js)
import { sparkleBuilderConfig } from "electron-sparkle-updater/builder";

export default {
  // ...your existing config...
  ...sparkleBuilderConfig({
    feedUrl: "https://example.com/appcast.xml",
    publicEdKey: "<real key, or omit to leave the placeholder for CI to inject>",
  }),
};
```

If you configure electron-builder with YAML instead, copy the individual keys `sparkleBuilderConfig` returns (`extraFiles`, `asarUnpack`, `dmg.writeUpdateInfo`, `zip.writeUpdateInfo`, `mac.extendInfo`, `files`) into your `electron-builder.yml` by hand — YAML can't `...spread` a JS object. If your electron-builder config already defines a `files` array, concatenate the fragment's `files` entries into it rather than letting a spread overwrite them.

When `publicEdKey` is omitted, the config carries the exported constant `SPARKLE_ED_PUBLIC_KEY_PLACEHOLDER` (`"SPARKLE_ED_PUBLIC_KEY_PLACEHOLDER"`) in `mac.extendInfo.SUPublicEDKey` — a greppable anchor your release pipeline can search-and-replace with the real key at build time, instead of committing the key to source.

**Localization (`CFBundleLocalizations`):** Sparkle's dialogs ship with 36 translations, but macOS restricts an embedded framework to the languages the *host app* declares — an Electron app that declares none gets English-only Sparkle UI regardless of the system language. `sparkleBuilderConfig` therefore enumerates the vendored `Sparkle.framework`'s `.lproj` folders and injects them as `mac.extendInfo.CFBundleLocalizations`, so Sparkle's UI follows the user's system language with no further setup. Pass `localizations: ["en", "zh_CN", ...]` to narrow the list (entries must match Sparkle's `.lproj` names), and note macOS only re-evaluates the language on app relaunch. Because the list is read from `native/vendor`, this is another reason config evaluation requires `rebuild` to have run first.

**Blockmaps are disabled** (`dmg.writeUpdateInfo: false`, `zip.writeUpdateInfo: false`): those are Squirrel/`electron-updater` differential-update metadata. Since updates ship through Sparkle's own appcast + delta mechanism instead, generating blockmaps would just be wasted build time.

**`asarUnpack` / `files` / `Frameworks` layout:** the native addon (`native/build/Release/*.node` — narrowed to just the compiled binary, not the surrounding object files and Makefiles from the build tree) is unpacked from the asar archive because Node can't `dlopen` a `.node` file from inside an asar; `files` excludes `native/vendor/**` from the asar entirely, since `Sparkle.framework` is placed into the app bundle by `extraFiles` instead (packing it into the asar too would just be a second, symlink-heavy copy nothing reads). `extraFiles` copies `Sparkle.framework` into the app bundle's `Frameworks/` directory, where Sparkle itself expects to find it at runtime (and where the native addon's rpath — see below — looks for it).

**The rpath contract:** the native addon is built with three rpath entries baked in — `@loader_path/../../vendor` (used during local development, before packaging), plus two packaged-app entries at different `@loader_path` depths, because how many directories up `Contents/` sits from the unpacked addon depends on where in `node_modules` a consumer's packaging places it. From `app.asar.unpacked/node_modules/electron-sparkle-updater/native/build/Release/`, 8 `..` segments (`@loader_path/../../../../../../../../Frameworks`) land in `Contents/Frameworks/`; the older 6-up entry (`@loader_path/../../../../../../Frameworks`) is kept for layouts that nest the addon two levels shallower (e.g. `native/sparkle-bridge/build/Release/`) and is otherwise harmless if it doesn't resolve. In practice this addon currently loads Sparkle via **Electron's own `@executable_path/../Frameworks` LC_RPATH** on the main executable, not either of the addon's own entries — both are a defensive fallback for future loading paths, not the active mechanism today. Whichever entry ends up resolving, the target must be a real `Sparkle.framework`, which is why the `extraFiles` entry above has to land at exactly `Frameworks/Sparkle.framework` in the packaged app.

electron-builder's `afterPack` option takes a **file path**, not an importable function, so it can't point directly at `adHocSignAfterPack`. Create a small wrapper file in your own project and point `afterPack:` at it:

```js
// scripts/afterPack.cjs
const { adHocSignAfterPack } = require("electron-sparkle-updater/builder");
module.exports = adHocSignAfterPack;
```

```yaml
# electron-builder.yml
afterPack: scripts/afterPack.cjs
```

`adHocSignAfterPack` re-signs the packaged `.app` ad-hoc (`codesign --force --deep --sign -`) after electron-builder stages `extraFiles`/`extraResources`/`asarUnpack` into it — those staging steps invalidate the bundle's original CodeDirectory, and Sparkle's `generate_appcast` refuses to process any archive whose `.app` doesn't pass `codesign --verify --deep --strict`. It no-ops on non-darwin platforms.

## Releasing

Publishing a Sparkle release means: generating an appcast XML feed (`generate_appcast`, Sparkle's own tool) that lists each release's download URL, version, and EdDSA signature, keeping the EdDSA private key available to sign new releases without ever committing it, and optionally producing delta updates so returning users download a small binary diff instead of the full app.

### Injecting the public key at build time

If you left `publicEdKey` out of `sparkleBuilderConfig` (see Packaging above), your packaged app still carries the placeholder `SPARKLE_ED_PUBLIC_KEY_PLACEHOLDER`. Replace it with the real key as a build step, before signing/packaging:

```
electron-sparkle-updater inject-public-key --file path/to/Info.plist --key "$SPARKLE_ED_PUBLIC_KEY"
```

`--key` can also come from the `SPARKLE_ED_PUBLIC_KEY` environment variable when the flag is omitted. The command fails (non-zero exit) if the placeholder isn't found in the file — a fail-fast guard against silently shipping a build with no key at all. `--placeholder` overrides the default string if you changed it.

### Archive directory layout

`generate-appcast` and the composite Action both operate on a single **archive directory** per release:

- your release's own `.zip` archive(s) (electron-builder output)
- an optional sidecar `.md` file with the same basename as a zip — `generate_appcast --embed-release-notes` picks it up and embeds it as that item's release notes
- populated by the tooling itself: previous releases' `appcast.xml` and their `.zip` archives (fetched in as delta bases), the newly generated/merged `appcast.xml`, and any `*.delta` binary diffs `generate_appcast` produces between the archives it finds

### `generate-appcast` CLI

```
electron-sparkle-updater generate-appcast <archive-dir> \
  --ed-key-file <path> \
  --download-url-prefix <url> \
  [--embed-release-notes] \
  [--full-release-notes-url <url>] \
  [--repo <owner/repo>] \
  [--tag-prefix <string>] \
  [--sparkle-bin <dir>]
```

Spawns Sparkle's own `generate_appcast` binary against `<archive-dir>` with the given flags. `--sparkle-bin` defaults to this package's vendored `native/vendor/bin` — run `electron-sparkle-updater rebuild` (or `native/scripts/fetch-sparkle.sh`) first if `generate_appcast` isn't there yet. When `--repo` is given, a successful run is followed by an in-process enclosure URL fix-up (see below) using `--tag-prefix`.

### Enclosure URL re-pointing

`generate_appcast` stamps every archive it processes — including old zips fetched in only as delta bases — with the current run's `--download-url-prefix`. That leaves older appcast items pointing at the new release tag, where those older assets were never uploaded (404). Enclosure URLs aren't covered by the EdDSA signatures (those sign file contents, not URLs), so rewriting each one back to the tag its own version was actually published under is safe. This runs automatically inside `generate-appcast --repo`, or standalone:

This re-pointing assumes stable `x.y.z` release tags — prerelease suffixes (`-beta.1` and similar) and archive filenames whose first numeric triplet isn't the actual version will get matched to the wrong tag and repoint incorrectly.

```
electron-sparkle-updater fix-appcast <appcast-dir>/appcast.xml --repo <owner/repo> [--tag-prefix <string>]
```

### Composite GitHub Action

`action/action.yml` fetches pinned upstream generation tools, downloads up to `delta-bases` historical ZIPs, generates deltas only to the current build, and merges bounded historical appcast metadata. Historical delta URLs and signatures remain unchanged; their files are neither downloaded nor re-uploaded. The final merged feed is signed while the EdDSA key is still on the RAM disk. It requires macOS and `github-token` access to the release repository. Use one archive directory/feed per architecture; the Action selects published, non-prerelease tags matching `tag-prefix`.

Generate-only, let the caller publish (`publish` defaults to `false`):

```yaml
jobs:
  release:
    runs-on: macos-14
    steps:
      - uses: actions/checkout@v4
      - run: pnpm install
      - run: pnpm --filter my-app build && pnpm --filter my-app package
      - uses: Innei/electron-sparkle-updater/action@v1
        with:
          tag: ${{ github.ref_name }}
          archive-dir: dist/release
          ed-private-key: ${{ secrets.SPARKLE_ED_PRIVATE_KEY }}
          fetch-delta-bases: "false"
      - run: gh release create "${{ github.ref_name }}" --draft dist/release/*
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

`fetch-delta-bases` is set to `"false"` here because the default (`"true"`) has the Action download previous releases' zips into `archive-dir` as delta bases — with that default, a plain `dist/release/*` glob on the publish step would re-upload those stale prior-release zips alongside the new build. If you need delta updates in a generate-only flow, leave `fetch-delta-bases` at its default and enumerate this release's own assets explicitly instead of globbing the archive directory (e.g. list the known output filenames, or filter by the current tag).

Generate and publish in one step (`publish: true`):

```yaml
jobs:
  release:
    runs-on: macos-14
    steps:
      - uses: actions/checkout@v4
      - run: pnpm install
      - run: pnpm --filter my-app build && pnpm --filter my-app package
      - uses: Innei/electron-sparkle-updater/action@v1
        with:
          tag: ${{ github.ref_name }}
          archive-dir: dist/release
          ed-private-key: ${{ secrets.SPARKLE_ED_PRIVATE_KEY }}
          delta-bases: "2"
          delta-history: "6"
          publish: "true"
          dmg-path: dist/release/MyApp.dmg
          notes-file: dist/release-notes.md
```

## Bounded delta chains

The bundled framework is Sparkle 2.9.4 plus [a pinned source patch](native/patches/README.md). Stock Sparkle clients still read the same appcast and use direct deltas or full archives.

- `delta-bases` (Action, default 2) bounds full-archive downloads and new delta generation per release.
- `delta-history` (Action, default 6) keeps the current build plus up to six prior release versions. The first run can backfill small historical appcasts; subsequent releases inherit the previous snapshot.
- `deltaHistory` (`sparkleBuilderConfig`, default 6), or `SUDeltaChainHistory` in the app's Info.plist, bounds the client's search. Values are integers from 0 to 32; client value 0 restores stock single-hop selection.

The updater picks the smallest total download within that window, breaking ties in favor of fewer patches. No compatible path, a source outside the window, or a chain as large as the full ZIP selects the full archive. A failed download, a patch whose signature does not verify once downloaded, or a patch that fails to apply falls back to the final full archive once; a bad signature stops the chain before later patches are fetched. Cancellation stops the update without initiating a fallback.

Each patch is authenticated using the installed application's signing key before it is applied. Each staged bundle is validated, including its expected build version and signing identity. Intermediate apps are never launched or installed. A key rotation or unsupported patch format rejects the chain and uses the normal full-update path. Partial chains are not resumed after process exit.

`setEventHandler` reports only the final target, cumulative download progress, and final readiness. `download-progress` carries `phase`: `download` counts bytes across the whole chain (`transferred` / `total` / `percent`), then `apply` reports `percent` while patches are applied and validated (or the full archive is extracted). A fallback to the full archive emits one `download` event with `percent: 0` and `fallback: true`, then a new progress range. Keep “download complete” separate from `update-downloaded`: patches must finish applying and validating before installation is ready.

New clients must first receive the patched framework through a normal update before they can execute chains. See [native verification](native/patches/README.md) for the planner, signed-app integration and real Kansoku checks.

## Fallback updater (`./fallback`)

For Windows/Linux (no Sparkle), or as a macOS fallback when `loadSparkleBridgeForApp` returns `null`, `./fallback` is a minimal notify-only updater: it polls a GitHub repo's `releases/latest`, compares versions, throttles repeat checks, and hands the result back to your app to render. It imports nothing from `electron` in its core, so it's directly unit-testable in plain Node; an Electron-flavored convenience wrapper sits on top.

```ts
import { checkForUpdate, githubLatestReleaseUrl } from "electron-sparkle-updater/fallback";

const result = await checkForUpdate({
  currentVersion: "1.2.3",
  now: () => new Date().toISOString(),
  fetchJson: (url) => fetch(url).then((r) => r.json()),
  readLastCheck: async () => lastCheckIso,
  writeLastCheck: async (iso) => {
    lastCheckIso = iso;
  },
  notify: (release) => console.log(`update available: ${release.version}`),
  releasesUrl: githubLatestReleaseUrl("my-org/my-app"),
  tagPrefix: "v",
});

switch (result.kind) {
  case "available":
    // result.release: { version, htmlUrl }
    break;
  case "up-to-date":
  case "throttled":
  case "no-release":
  case "fetch-failed":
    break;
}
```

Most Electron apps don't need to wire `checkForUpdate`'s deps by hand — `createElectronFallbackDeps` fills them in with `app.getVersion()`, a `updater.json` state file under `app.getPath("userData")`, and a native `Notification` that opens the release page on click:

```ts
import { checkForUpdate, createElectronFallbackDeps } from "electron-sparkle-updater/fallback";

const deps = await createElectronFallbackDeps({
  ownerRepo: "my-org/my-app",
  tagPrefix: "v",
  notificationTitle: "Update available",
});

const result = await checkForUpdate(deps);
```

## Prior art / credits

Built on [Sparkle](https://sparkle-project.org/), the macOS update framework. Extracted from [Kansoku](https://github.com/Innei/kansoku)'s production Electron app, generalized into a standalone package.
