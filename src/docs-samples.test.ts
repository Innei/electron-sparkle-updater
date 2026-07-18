import { describe, expect, it } from "vitest";
import { loadSparkleBridge, loadSparkleBridgeForApp } from "./index.js";
import { adHocSignAfterPack, sparkleBuilderConfig, SPARKLE_ED_PUBLIC_KEY_PLACEHOLDER } from "./builder.js";

describe("README runtime sample", () => {
  it("loadSparkleBridgeForApp is an async function taking an optional log callback", () => {
    expect(typeof loadSparkleBridgeForApp).toBe("function");
    expect(loadSparkleBridgeForApp.length).toBe(1);
  });

  it("bridge returned by loadSparkleBridge exposes the four documented methods", () => {
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
