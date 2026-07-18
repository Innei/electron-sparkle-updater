import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseCliArgs, resolveElectronVersion, runRebuild, SPARKLE_VERSION } from "./cli.js";
import type { RunRebuildDeps, SpawnFn, SpawnResult } from "./cli.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(here, "..", "test", "fixtures");

const ok: SpawnResult = { status: 0 };

function makeDeps(overrides: Partial<RunRebuildDeps> = {}): RunRebuildDeps {
  return {
    platform: "darwin",
    cwd: "/consumer",
    nativeDir: "/pkg/native",
    spawn: vi.fn<SpawnFn>().mockReturnValue(ok),
    resolveElectronVersion: vi.fn().mockReturnValue("43.1.0"),
    removeForceFetchStamp: vi.fn(),
    copyFile: vi.fn(),
    log: vi.fn(),
    errorLog: vi.fn(),
    ...overrides,
  };
}

describe("parseCliArgs", () => {
  it("defaults arch to process.arch and forceFetch to false", () => {
    const result = parseCliArgs(["rebuild"]);
    expect(result).toEqual({
      kind: "rebuild",
      options: { electronVersion: undefined, arch: process.arch, forceFetch: false },
    });
  });

  it("accepts explicit electron-version, arch and force-fetch", () => {
    const result = parseCliArgs([
      "rebuild",
      "--electron-version",
      "43.1.0",
      "--arch",
      "x64",
      "--force-fetch",
    ]);
    expect(result).toEqual({
      kind: "rebuild",
      options: { electronVersion: "43.1.0", arch: "x64", forceFetch: true },
    });
  });

  it("accepts universal as an arch value", () => {
    const result = parseCliArgs(["rebuild", "--arch", "universal"]);
    expect(result).toEqual({
      kind: "rebuild",
      options: { electronVersion: undefined, arch: "universal", forceFetch: false },
    });
  });

  it("rejects an unknown command with usage and exit code 1", () => {
    const result = parseCliArgs(["frobnicate"]);
    expect(result.kind).toBe("usage");
    expect(result).toMatchObject({ kind: "usage", exitCode: 1 });
  });

  it("rejects a missing command with usage and exit code 1", () => {
    const result = parseCliArgs([]);
    expect(result).toMatchObject({ kind: "usage", exitCode: 1 });
  });

  it("rejects an invalid --arch value", () => {
    const result = parseCliArgs(["rebuild", "--arch", "mips"]);
    expect(result.kind).toBe("usage");
    expect(result).toMatchObject({ kind: "usage", exitCode: 1 });
    if (result.kind === "usage") {
      expect(result.message).toMatch(/--arch/);
    }
  });

  it("rejects an unknown flag", () => {
    const result = parseCliArgs(["rebuild", "--bogus"]);
    expect(result).toMatchObject({ kind: "usage", exitCode: 1 });
  });
});

describe("resolveElectronVersion", () => {
  let tempCwd: string | undefined;

  afterEach(() => {
    if (tempCwd) {
      rmSync(tempCwd, { recursive: true, force: true });
      tempCwd = undefined;
    }
  });

  it("resolves the electron version from the consumer project", () => {
    const cwd = join(fixturesDir, "consumer-with-electron");
    expect(resolveElectronVersion(cwd)).toBe("43.1.0");
  });

  it("throws a clear error when electron is not resolvable", () => {
    tempCwd = mkdtempSync(join(tmpdir(), "electron-sparkle-updater-no-electron-"));
    writeFileSync(join(tempCwd, "package.json"), JSON.stringify({ name: "no-electron", version: "0.0.0" }));
    expect(() => resolveElectronVersion(tempCwd!)).toThrow(/electron/i);
  });
});

describe("runRebuild", () => {
  it("refuses to run on non-darwin platforms without spawning anything", () => {
    const deps = makeDeps({ platform: "win32" });
    const code = runRebuild({ arch: "arm64", forceFetch: false }, deps);
    expect(code).toBe(1);
    expect(deps.spawn).not.toHaveBeenCalled();
    expect(deps.errorLog).toHaveBeenCalledWith(expect.stringMatching(/macOS/));
  });

  it("reports a clear error when electron version resolution fails", () => {
    const resolveElectronVersion = vi.fn(() => {
      throw new Error("could not resolve electron version: electron is not installed");
    });
    const deps = makeDeps({ resolveElectronVersion });
    const code = runRebuild({ arch: "arm64", forceFetch: false }, deps);
    expect(code).toBe(1);
    expect(deps.spawn).not.toHaveBeenCalled();
    expect(deps.errorLog).toHaveBeenCalledWith(expect.stringMatching(/electron/i));
  });

  it("runs fetch-sparkle.sh then node-gyp rebuild for a single arch, never touching the stamp", () => {
    const deps = makeDeps();
    const code = runRebuild({ electronVersion: "43.1.0", arch: "arm64", forceFetch: false }, deps);

    expect(code).toBe(0);
    expect(deps.removeForceFetchStamp).not.toHaveBeenCalled();

    const spawn = deps.spawn as unknown as ReturnType<typeof vi.fn>;
    expect(spawn).toHaveBeenCalledTimes(2);

    const [fetchCall, gypCall] = spawn.mock.calls;
    expect(fetchCall[0]).toBe("bash");
    expect(fetchCall[1]).toEqual([join("/pkg/native", "scripts", "fetch-sparkle.sh")]);
    expect(fetchCall[2]).toMatchObject({ cwd: "/pkg/native", stdio: "inherit" });

    expect(gypCall[0]).toBe(process.execPath);
    expect(gypCall[1][0]).toMatch(/node-gyp[/\\]bin[/\\]node-gyp\.js$/);
    expect(gypCall[1].slice(1)).toEqual([
      "rebuild",
      "--target=43.1.0",
      "--arch=arm64",
      "--dist-url=https://electronjs.org/headers",
    ]);
    expect(gypCall[2]).toMatchObject({ cwd: "/pkg/native", stdio: "inherit" });
  });

  it("removes the stamp before fetching when --force-fetch is passed", () => {
    const deps = makeDeps();
    runRebuild({ electronVersion: "43.1.0", arch: "arm64", forceFetch: true }, deps);
    expect(deps.removeForceFetchStamp).toHaveBeenCalledWith("/pkg/native");

    const removeStampOrder = (deps.removeForceFetchStamp as unknown as ReturnType<typeof vi.fn>).mock
      .invocationCallOrder[0];
    const firstSpawnOrder = (deps.spawn as unknown as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
    expect(removeStampOrder).toBeLessThan(firstSpawnOrder);
  });

  it("stops and propagates the exit code when fetch-sparkle.sh fails", () => {
    const spawn = vi.fn<SpawnFn>().mockReturnValue({ status: 7 });
    const deps = makeDeps({ spawn });
    const code = runRebuild({ electronVersion: "43.1.0", arch: "arm64", forceFetch: false }, deps);
    expect(code).toBe(7);
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it("stops and propagates the exit code when node-gyp rebuild fails", () => {
    const spawn = vi
      .fn<SpawnFn>()
      .mockReturnValueOnce(ok)
      .mockReturnValueOnce({ status: 3 });
    const deps = makeDeps({ spawn });
    const code = runRebuild({ electronVersion: "43.1.0", arch: "arm64", forceFetch: false }, deps);
    expect(code).toBe(3);
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it("builds arm64 then x64 and lipo -creates them into the final addon for universal", () => {
    const deps = makeDeps();
    const code = runRebuild({ electronVersion: "43.1.0", arch: "universal", forceFetch: false }, deps);

    expect(code).toBe(0);
    const spawn = deps.spawn as unknown as ReturnType<typeof vi.fn>;
    expect(spawn).toHaveBeenCalledTimes(4);

    const [fetchCall, arm64Call, x64Call, lipoCall] = spawn.mock.calls;
    expect(fetchCall[0]).toBe("bash");
    expect(arm64Call[1]).toEqual(expect.arrayContaining(["--arch=arm64"]));
    expect(x64Call[1]).toEqual(expect.arrayContaining(["--arch=x64"]));
    expect(lipoCall[0]).toBe("lipo");

    expect(deps.copyFile).toHaveBeenCalledTimes(2);
  });

  it("propagates a non-zero lipo exit code for universal builds", () => {
    const spawn = vi
      .fn<SpawnFn>()
      .mockReturnValueOnce(ok)
      .mockReturnValueOnce(ok)
      .mockReturnValueOnce(ok)
      .mockReturnValueOnce({ status: 5 });
    const deps = makeDeps({ spawn });
    const code = runRebuild({ electronVersion: "43.1.0", arch: "universal", forceFetch: false }, deps);
    expect(code).toBe(5);
    expect(spawn).toHaveBeenCalledTimes(4);
  });
});

describe("SPARKLE_VERSION", () => {
  it("matches the pinned vendor version", () => {
    expect(SPARKLE_VERSION).toBe("2.9.4");
  });
});
