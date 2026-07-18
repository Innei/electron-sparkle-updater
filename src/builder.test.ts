import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  adHocSignAfterPack,
  sparkleBuilderConfig,
  SPARKLE_ED_PUBLIC_KEY_PLACEHOLDER,
} from "./builder.js";
import type { ExecFileFn } from "./builder.js";

describe("sparkleBuilderConfig", () => {
  it("applies defaults when publicEdKey and scheduledCheckIntervalSeconds are omitted", () => {
    const config = sparkleBuilderConfig({ feedUrl: "https://example.com/appcast.xml" });
    expect(config).toEqual({
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
          SUFeedURL: "https://example.com/appcast.xml",
          SUPublicEDKey: SPARKLE_ED_PUBLIC_KEY_PLACEHOLDER,
          SUEnableInstallerLauncherService: false,
          SUScheduledCheckInterval: 3600,
        },
      },
    });
  });

  it("uses explicit publicEdKey and scheduledCheckIntervalSeconds when provided", () => {
    const config = sparkleBuilderConfig({
      feedUrl: "https://example.com/appcast.xml",
      publicEdKey: "abc123",
      scheduledCheckIntervalSeconds: 1800,
    });
    expect(config.mac.extendInfo.SUPublicEDKey).toBe("abc123");
    expect(config.mac.extendInfo.SUScheduledCheckInterval).toBe(1800);
  });

  it("excludes native/vendor from the consumer's asar (no second Sparkle.framework copy)", () => {
    const config = sparkleBuilderConfig({ feedUrl: "https://example.com/appcast.xml" });
    expect(config.files).toContain("!**/node_modules/electron-sparkle-updater/native/vendor/**");
  });

  it("narrows asarUnpack to exactly the .node file the packaged loader expects", () => {
    const config = sparkleBuilderConfig({ feedUrl: "https://example.com/appcast.xml" });
    const addonDir = "node_modules/electron-sparkle-updater/native/build/Release";

    const unpackGlobs = config.asarUnpack as string[];
    expect(unpackGlobs).toEqual([`**/${addonDir}/*.node`]);

    const [glob] = unpackGlobs;
    const prefix = glob.slice(0, glob.indexOf("*"));
    const addonPath = `${addonDir}/sparkle_bridge.node`;
    expect(`**/${addonPath}`.startsWith(prefix)).toBe(true);
    expect(addonPath.endsWith(".node")).toBe(true);

    expect(glob).not.toContain("build/**");
    expect(glob).not.toContain("Makefile");
  });
});

describe("adHocSignAfterPack", () => {
  let tempDir: string | undefined;

  afterEach(() => {
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  it("is a no-op on non-darwin platforms", async () => {
    const exec = vi.fn<ExecFileFn>();
    await adHocSignAfterPack({ electronPlatformName: "win32", appOutDir: "/does/not/matter" }, { exec });
    expect(exec).not.toHaveBeenCalled();
  });

  it("throws when no .app bundle is found in appOutDir", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "electron-sparkle-updater-afterpack-"));
    const exec = vi.fn<ExecFileFn>();
    await expect(
      adHocSignAfterPack({ electronPlatformName: "darwin", appOutDir: tempDir }, { exec }),
    ).rejects.toThrow(/no \.app bundle found/);
    expect(exec).not.toHaveBeenCalled();
  });

  it("signs then verifies the .app bundle in order", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "electron-sparkle-updater-afterpack-"));
    mkdirSync(join(tempDir, "MyApp.app"));
    const exec = vi.fn<ExecFileFn>();

    await adHocSignAfterPack({ electronPlatformName: "darwin", appOutDir: tempDir }, { exec });

    const appPath = join(tempDir, "MyApp.app");
    expect(exec).toHaveBeenNthCalledWith(1, "codesign", ["--force", "--deep", "--sign", "-", appPath], {
      stdio: "inherit",
    });
    expect(exec).toHaveBeenNthCalledWith(2, "codesign", ["--verify", "--deep", "--strict", appPath], {
      stdio: "inherit",
    });
  });
});
