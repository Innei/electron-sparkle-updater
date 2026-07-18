import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";

export const SPARKLE_ED_PUBLIC_KEY_PLACEHOLDER = "SPARKLE_ED_PUBLIC_KEY_PLACEHOLDER";

export interface SparkleBuilderConfigOptions {
  feedUrl: string;
  publicEdKey?: string;
  scheduledCheckIntervalSeconds?: number;
}

export function sparkleBuilderConfig(options: SparkleBuilderConfigOptions) {
  return {
    extraFiles: [
      {
        from: "node_modules/electron-sparkle-updater/native/vendor/Sparkle.framework",
        to: "Frameworks/Sparkle.framework",
      },
    ],
    files: ["!**/node_modules/electron-sparkle-updater/native/vendor/**"],
    asarUnpack: ["**/node_modules/electron-sparkle-updater/native/build/Release/*.node"],
    dmg: { writeUpdateInfo: false },
    zip: { writeUpdateInfo: false },
    mac: {
      extendInfo: {
        SUFeedURL: options.feedUrl,
        SUPublicEDKey: options.publicEdKey ?? SPARKLE_ED_PUBLIC_KEY_PLACEHOLDER,
        SUEnableInstallerLauncherService: false,
        SUScheduledCheckInterval: options.scheduledCheckIntervalSeconds ?? 3600,
      },
    },
  };
}

export interface AfterPackContext {
  electronPlatformName: string;
  appOutDir: string;
}

export type ExecFileFn = (command: string, args: string[], options: { stdio: "inherit" }) => void;

export interface AdHocSignAfterPackDeps {
  exec?: ExecFileFn;
}

// electron-builder.yml sets identity: null (no paid Developer ID cert), so
// the only signature the packed app carries is Electron's own ad-hoc one on
// the main executable — and copying in extraResources/extraFiles/asarUnpack
// after that invalidates the bundle's CodeDirectory. This hook fires once,
// after all files are staged into appOutDir but before electron-builder
// packages the dmg and zip targets, so re-signing ad-hoc here (no cert
// needed) covers both artifacts from a single signed .app instead of each
// target needing its own post-hoc re-sign. Sparkle's generate_appcast
// refuses any archive whose .app doesn't pass `codesign --verify --deep
// --strict`, which is why this is load-bearing for the release pipeline.
export async function adHocSignAfterPack(
  context: AfterPackContext,
  deps: AdHocSignAfterPackDeps = {},
): Promise<void> {
  if (context.electronPlatformName !== "darwin") return;

  const exec = deps.exec ?? execFileSync;

  const appName = readdirSync(context.appOutDir).find((entry) => entry.endsWith(".app"));
  if (!appName) {
    throw new Error(`afterPack: no .app bundle found in ${context.appOutDir}`);
  }
  const appPath = join(context.appOutDir, appName);

  exec("codesign", ["--force", "--deep", "--sign", "-", appPath], { stdio: "inherit" });
  exec("codesign", ["--verify", "--deep", "--strict", appPath], { stdio: "inherit" });
}
