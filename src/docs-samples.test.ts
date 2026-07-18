import { describe, expect, it } from "vitest";
import { loadSparkleBridge, loadSparkleBridgeForApp } from "./index.js";
import { adHocSignAfterPack, sparkleBuilderConfig, SPARKLE_ED_PUBLIC_KEY_PLACEHOLDER } from "./builder.js";
import {
  checkForUpdate,
  createElectronFallbackDeps,
  githubLatestReleaseUrl,
  DEFAULT_THROTTLE_MS,
} from "./fallback.js";
import { fixAppcastEnclosureUrls, injectPublicKey } from "./appcast.js";

describe("README runtime sample", () => {
  it("loadSparkleBridgeForApp is an async function taking an optional log callback", () => {
    expect(typeof loadSparkleBridgeForApp).toBe("function");
    expect(loadSparkleBridgeForApp.length).toBe(1);
  });

  it("loadSparkleBridge returns null when the addon cannot be loaded", () => {
    const bridge = loadSparkleBridge({
      isPackaged: false,
      resourcesPath: "/nonexistent",
      addonPath: "/nonexistent/sparkle_bridge.node",
    });
    expect(bridge).toBeNull();
    expect(typeof loadSparkleBridge).toBe("function");
  });
});

describe("README packaging sample", () => {
  it("sparkleBuilderConfig accepts feedUrl + publicEdKey and returns the documented keys", () => {
    const config = sparkleBuilderConfig({
      feedUrl: "https://example.com/appcast.xml",
      publicEdKey: "real-key",
    });

    expect(Array.isArray(config.extraFiles)).toBe(true);
    expect(Array.isArray(config.asarUnpack)).toBe(true);
    expect(config.dmg).toEqual({ writeUpdateInfo: false });
    expect(config.zip).toEqual({ writeUpdateInfo: false });
    expect(config.mac.extendInfo.SUFeedURL).toBe("https://example.com/appcast.xml");
    expect(config.mac.extendInfo.SUPublicEDKey).toBe("real-key");
  });

  it("omitting publicEdKey falls back to the greppable placeholder constant", () => {
    const config = sparkleBuilderConfig({ feedUrl: "https://example.com/appcast.xml" });
    expect(config.mac.extendInfo.SUPublicEDKey).toBe(SPARKLE_ED_PUBLIC_KEY_PLACEHOLDER);
  });

  it("adHocSignAfterPack is an async function consumers wrap in their own afterPack file", () => {
    expect(typeof adHocSignAfterPack).toBe("function");
    expect(adHocSignAfterPack.constructor.name).toBe("AsyncFunction");
  });
});

describe("README fallback updater sample", () => {
  it("checkForUpdate takes an injected-deps object and githubLatestReleaseUrl builds the releases/latest URL", () => {
    expect(typeof checkForUpdate).toBe("function");
    expect(checkForUpdate.length).toBe(1);
    expect(githubLatestReleaseUrl("my-org/my-app")).toBe("https://api.github.com/repos/my-org/my-app/releases/latest");
    expect(typeof DEFAULT_THROTTLE_MS).toBe("number");
  });

  it("createElectronFallbackDeps is an async function accepting ownerRepo + notificationTitle", async () => {
    expect(typeof createElectronFallbackDeps).toBe("function");
    expect(createElectronFallbackDeps.length).toBe(1);
    await expect(
      createElectronFallbackDeps({ ownerRepo: "my-org/my-app", notificationTitle: "Update available" }),
    ).rejects.toThrow();
  });
});

describe("README releasing samples", () => {
  it("injectPublicKey replaces a placeholder and reports the replacement count", () => {
    const result = injectPublicKey("key=PLACEHOLDER", "real-key", "PLACEHOLDER");
    expect(result).toEqual({ content: "key=real-key", replacements: 1 });
  });

  it("injectPublicKey throws when the placeholder is absent", () => {
    expect(() => injectPublicKey("key=already-real", "real-key", "PLACEHOLDER")).toThrow();
  });

  it("fixAppcastEnclosureUrls repoints enclosure URLs at each asset's own release tag", () => {
    const xml =
      '<enclosure url="https://github.com/my-org/my-app/releases/download/vlatest/my-app-1.2.3.zip"/>';
    const result = fixAppcastEnclosureUrls(xml, "my-org/my-app", "v");
    expect(result.rewrites).toBe(1);
    expect(result.xml).toContain(
      'url="https://github.com/my-org/my-app/releases/download/v1.2.3/my-app-1.2.3.zip"',
    );
  });
});
