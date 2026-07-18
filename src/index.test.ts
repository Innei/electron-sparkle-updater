import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadSparkleBridge, loadSparkleBridgeForApp, resolveSparkleAddonPath } from "./index.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(here, "..", "test", "fixtures");
const validAddonPath = join(fixturesDir, "valid-addon.cjs");
const incompleteAddonPath = join(fixturesDir, "incomplete-addon.cjs");
const missingAddonPath = join(fixturesDir, "does-not-exist.cjs");

let originalPlatform: NodeJS.Platform;

beforeEach(() => {
  originalPlatform = process.platform;
});

afterEach(() => {
  Object.defineProperty(process, "platform", { value: originalPlatform });
  vi.restoreAllMocks();
  vi.resetModules();
});

function stubPlatform(platform: NodeJS.Platform) {
  Object.defineProperty(process, "platform", { value: platform });
}

describe("resolveSparkleAddonPath", () => {
  it("resolves the dev path under packageRoot", () => {
    const result = resolveSparkleAddonPath({
      isPackaged: false,
      resourcesPath: "/unused",
      packageRoot: "/some/root",
    });
    expect(result).toBe(join("/some/root", "native", "build", "Release", "sparkle_bridge.node"));
  });

  it("resolves the packaged path under resourcesPath", () => {
    const result = resolveSparkleAddonPath({
      isPackaged: true,
      resourcesPath: "/res",
      packageRoot: "/unused",
    });
    expect(result).toBe(
      join(
        "/res",
        "app.asar.unpacked",
        "node_modules",
        "electron-sparkle-updater",
        "native",
        "build",
        "Release",
        "sparkle_bridge.node",
      ),
    );
  });
});

describe("loadSparkleBridge", () => {
  it("returns null immediately on non-darwin platforms", () => {
    stubPlatform("win32");
    const log = vi.fn();
    const result = loadSparkleBridge({
      isPackaged: false,
      resourcesPath: "/unused",
      addonPath: validAddonPath,
      log,
    });
    expect(result).toBeNull();
    expect(log).not.toHaveBeenCalled();
  });

  it("loads a valid addon via the addonPath override", () => {
    stubPlatform("darwin");
    const result = loadSparkleBridge({
      isPackaged: false,
      resourcesPath: "/unused",
      addonPath: validAddonPath,
    });
    expect(result).not.toBeNull();
    expect(typeof result?.init).toBe("function");
    expect(result?.init({ appcastUrl: "https://example.com/appcast.xml", publicEdKey: "key" })).toBe(true);
  });

  it("returns null and logs when the addon file is missing", () => {
    stubPlatform("darwin");
    const log = vi.fn();
    const result = loadSparkleBridge({
      isPackaged: false,
      resourcesPath: "/unused",
      addonPath: missingAddonPath,
      log,
    });
    expect(result).toBeNull();
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toMatch(/addon load failed/);
  });

  it("returns null and logs when the addon is missing expected methods", () => {
    stubPlatform("darwin");
    const log = vi.fn();
    const result = loadSparkleBridge({
      isPackaged: false,
      resourcesPath: "/unused",
      addonPath: incompleteAddonPath,
      log,
    });
    expect(result).toBeNull();
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toMatch(/missing expected exports/);
  });
});

describe("loadSparkleBridgeForApp", () => {
  it("returns null immediately on non-darwin platforms without importing electron", async () => {
    stubPlatform("win32");
    const result = await loadSparkleBridgeForApp();
    expect(result).toBeNull();
  });

  it("fills isPackaged and resourcesPath from the electron module", async () => {
    stubPlatform("darwin");
    vi.doMock("electron", () => ({ app: { isPackaged: true } }));
    Object.defineProperty(process, "resourcesPath", { value: "/res", configurable: true });

    const { loadSparkleBridgeForApp: freshLoadSparkleBridgeForApp } = await import("./index.js");
    const result = await freshLoadSparkleBridgeForApp();

    expect(result).toBeNull();
  });
});
