import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  parseCliArgs,
  resolveElectronVersion,
  runFixAppcast,
  runGenerateAppcast,
  runInjectPublicKey,
  runRebuild,
} from "./cli.js";
import type {
  FileSystemDeps,
  RunGenerateAppcastDeps,
  RunInjectPublicKeyDeps,
  RunRebuildDeps,
  SpawnFn,
  SpawnResult,
} from "./cli.js";
import { SPARKLE_ED_PUBLIC_KEY_PLACEHOLDER } from "./builder.js";

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
    removeVendorDir: vi.fn(),
    copyFile: vi.fn(),
    removeIntermediate: vi.fn(),
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

describe("parseCliArgs inject-public-key", () => {
  it("parses --file, --key and defaults --placeholder to the builder constant", () => {
    const result = parseCliArgs(["inject-public-key", "--file", "Info.plist", "--key", "real-key"]);
    expect(result).toEqual({
      kind: "inject-public-key",
      options: { file: "Info.plist", key: "real-key", placeholder: SPARKLE_ED_PUBLIC_KEY_PLACEHOLDER },
    });
  });

  it("accepts a custom --placeholder", () => {
    const result = parseCliArgs([
      "inject-public-key",
      "--file",
      "Info.plist",
      "--key",
      "real-key",
      "--placeholder",
      "<<KEY>>",
    ]);
    expect(result).toMatchObject({ options: { placeholder: "<<KEY>>" } });
  });

  it("leaves key undefined when --key is omitted (env fallback handled at run time)", () => {
    const result = parseCliArgs(["inject-public-key", "--file", "Info.plist"]);
    expect(result).toEqual({
      kind: "inject-public-key",
      options: { file: "Info.plist", key: undefined, placeholder: SPARKLE_ED_PUBLIC_KEY_PLACEHOLDER },
    });
  });

  it("rejects a missing --file", () => {
    const result = parseCliArgs(["inject-public-key", "--key", "real-key"]);
    expect(result).toMatchObject({ kind: "usage", exitCode: 1 });
  });
});

describe("parseCliArgs fix-appcast", () => {
  it("parses the positional appcast path and --repo, defaulting --tag-prefix to v", () => {
    const result = parseCliArgs(["fix-appcast", "appcast.xml", "--repo", "owner/repo"]);
    expect(result).toEqual({
      kind: "fix-appcast",
      options: { appcastPath: "appcast.xml", repo: "owner/repo", tagPrefix: "v" },
    });
  });

  it("accepts a custom --tag-prefix", () => {
    const result = parseCliArgs(["fix-appcast", "appcast.xml", "--repo", "owner/repo", "--tag-prefix", "desktop-v"]);
    expect(result).toMatchObject({ options: { tagPrefix: "desktop-v" } });
  });

  it("rejects a missing appcast path", () => {
    const result = parseCliArgs(["fix-appcast", "--repo", "owner/repo"]);
    expect(result).toMatchObject({ kind: "usage", exitCode: 1 });
  });

  it("rejects a missing --repo", () => {
    const result = parseCliArgs(["fix-appcast", "appcast.xml"]);
    expect(result).toMatchObject({ kind: "usage", exitCode: 1 });
  });
});

describe("parseCliArgs generate-appcast", () => {
  it("parses required flags and defaults tag-prefix, embed-release-notes and sparkle-bin", () => {
    const result = parseCliArgs([
      "generate-appcast",
      "archives",
      "--ed-key-file",
      "key.pem",
      "--download-url-prefix",
      "https://example.com/dl/",
    ]);
    expect(result).toEqual({
      kind: "generate-appcast",
      options: {
        archiveDir: "archives",
        edKeyFile: "key.pem",
        downloadUrlPrefix: "https://example.com/dl/",
        embedReleaseNotes: false,
        fullReleaseNotesUrl: undefined,
        repo: undefined,
        tagPrefix: "v",
        sparkleBin: undefined,
      },
    });
  });

  it("parses every optional flag", () => {
    const result = parseCliArgs([
      "generate-appcast",
      "archives",
      "--ed-key-file",
      "key.pem",
      "--download-url-prefix",
      "https://example.com/dl/",
      "--embed-release-notes",
      "--full-release-notes-url",
      "https://example.com/notes",
      "--repo",
      "owner/repo",
      "--tag-prefix",
      "desktop-v",
      "--sparkle-bin",
      "/custom/bin",
    ]);
    expect(result).toEqual({
      kind: "generate-appcast",
      options: {
        archiveDir: "archives",
        edKeyFile: "key.pem",
        downloadUrlPrefix: "https://example.com/dl/",
        embedReleaseNotes: true,
        fullReleaseNotesUrl: "https://example.com/notes",
        repo: "owner/repo",
        tagPrefix: "desktop-v",
        sparkleBin: "/custom/bin",
      },
    });
  });

  it("rejects a missing archive-dir positional", () => {
    const result = parseCliArgs([
      "generate-appcast",
      "--ed-key-file",
      "key.pem",
      "--download-url-prefix",
      "https://example.com/dl/",
    ]);
    expect(result).toMatchObject({ kind: "usage", exitCode: 1 });
  });

  it("rejects a missing --ed-key-file", () => {
    const result = parseCliArgs([
      "generate-appcast",
      "archives",
      "--download-url-prefix",
      "https://example.com/dl/",
    ]);
    expect(result).toMatchObject({ kind: "usage", exitCode: 1 });
  });

  it("rejects a missing --download-url-prefix", () => {
    const result = parseCliArgs(["generate-appcast", "archives", "--ed-key-file", "key.pem"]);
    expect(result).toMatchObject({ kind: "usage", exitCode: 1 });
  });
});

describe("runGenerateAppcast", () => {
  const ok: SpawnResult = { status: 0 };

  function makeDeps(overrides: Partial<RunGenerateAppcastDeps> = {}): RunGenerateAppcastDeps {
    return {
      cwd: "/consumer",
      defaultSparkleBin: "/pkg/native/vendor/bin",
      spawn: vi.fn<SpawnFn>().mockReturnValue(ok),
      fileExists: vi.fn().mockReturnValue(true),
      readFile: vi.fn().mockReturnValue('<enclosure url="x" />'),
      writeFile: vi.fn(),
      log: vi.fn(),
      errorLog: vi.fn(),
      ...overrides,
    };
  }

  it("spawns generate_appcast from the default sparkle-bin dir with the required flags", () => {
    const deps = makeDeps();
    const code = runGenerateAppcast(
      {
        archiveDir: "archives",
        edKeyFile: "key.pem",
        downloadUrlPrefix: "https://example.com/dl/",
        embedReleaseNotes: false,
        tagPrefix: "v",
      },
      deps,
    );
    expect(code).toBe(0);
    expect(deps.fileExists).toHaveBeenCalledWith(join("/pkg/native/vendor/bin", "generate_appcast"));

    const spawn = deps.spawn as unknown as ReturnType<typeof vi.fn>;
    expect(spawn).toHaveBeenCalledTimes(1);
    const [command, args, options] = spawn.mock.calls[0];
    expect(command).toBe(join("/pkg/native/vendor/bin", "generate_appcast"));
    expect(args).toEqual([
      "--ed-key-file",
      "key.pem",
      "--download-url-prefix",
      "https://example.com/dl/",
      "archives",
    ]);
    expect(options).toMatchObject({ stdio: "inherit" });
  });

  it("includes --embed-release-notes and --full-release-notes-url when given", () => {
    const deps = makeDeps();
    runGenerateAppcast(
      {
        archiveDir: "archives",
        edKeyFile: "key.pem",
        downloadUrlPrefix: "https://example.com/dl/",
        embedReleaseNotes: true,
        fullReleaseNotesUrl: "https://example.com/notes",
        tagPrefix: "v",
      },
      deps,
    );
    const spawn = deps.spawn as unknown as ReturnType<typeof vi.fn>;
    expect(spawn.mock.calls[0][1]).toEqual([
      "--ed-key-file",
      "key.pem",
      "--download-url-prefix",
      "https://example.com/dl/",
      "--embed-release-notes",
      "--full-release-notes-url",
      "https://example.com/notes",
      "archives",
    ]);
  });

  it("uses --sparkle-bin override instead of the default", () => {
    const deps = makeDeps();
    runGenerateAppcast(
      {
        archiveDir: "archives",
        edKeyFile: "key.pem",
        downloadUrlPrefix: "https://example.com/dl/",
        embedReleaseNotes: false,
        tagPrefix: "v",
        sparkleBin: "/custom/bin",
      },
      deps,
    );
    expect(deps.fileExists).toHaveBeenCalledWith(join("/custom/bin", "generate_appcast"));
    const spawn = deps.spawn as unknown as ReturnType<typeof vi.fn>;
    expect(spawn.mock.calls[0][0]).toBe(join("/custom/bin", "generate_appcast"));
  });

  it("errors with a hint to rebuild or fetch-sparkle.sh when generate_appcast is missing, without spawning", () => {
    const deps = makeDeps({ fileExists: vi.fn().mockReturnValue(false) });
    const code = runGenerateAppcast(
      {
        archiveDir: "archives",
        edKeyFile: "key.pem",
        downloadUrlPrefix: "https://example.com/dl/",
        embedReleaseNotes: false,
        tagPrefix: "v",
      },
      deps,
    );
    expect(code).toBe(1);
    expect(deps.spawn).not.toHaveBeenCalled();
    expect(deps.errorLog).toHaveBeenCalledWith(expect.stringMatching(/rebuild/));
    expect(deps.errorLog).toHaveBeenCalledWith(expect.stringMatching(/fetch-sparkle\.sh/));
  });

  it("propagates a non-zero exit code from generate_appcast without touching the appcast", () => {
    const spawn = vi.fn<SpawnFn>().mockReturnValue({ status: 4 });
    const deps = makeDeps({ spawn });
    const code = runGenerateAppcast(
      {
        archiveDir: "archives",
        edKeyFile: "key.pem",
        downloadUrlPrefix: "https://example.com/dl/",
        embedReleaseNotes: false,
        repo: "owner/repo",
        tagPrefix: "v",
      },
      deps,
    );
    expect(code).toBe(4);
    expect(deps.readFile).not.toHaveBeenCalled();
    expect(deps.writeFile).not.toHaveBeenCalled();
  });

  it("does not run fix-appcast when --repo is omitted", () => {
    const deps = makeDeps();
    const code = runGenerateAppcast(
      {
        archiveDir: "archives",
        edKeyFile: "key.pem",
        downloadUrlPrefix: "https://example.com/dl/",
        embedReleaseNotes: false,
        tagPrefix: "v",
      },
      deps,
    );
    expect(code).toBe(0);
    expect(deps.readFile).not.toHaveBeenCalled();
    expect(deps.writeFile).not.toHaveBeenCalled();
  });

  it("runs fix-appcast on <archive-dir>/appcast.xml when --repo is given and the spawn succeeds", () => {
    const deps = makeDeps({
      readFile: vi
        .fn()
        .mockReturnValue('<enclosure url="https://github.com/owner/repo/releases/download/vOLD/App-1.2.3.zip" />'),
    });
    const code = runGenerateAppcast(
      {
        archiveDir: "archives",
        edKeyFile: "key.pem",
        downloadUrlPrefix: "https://example.com/dl/",
        embedReleaseNotes: false,
        repo: "owner/repo",
        tagPrefix: "v",
      },
      deps,
    );
    expect(code).toBe(0);
    expect(deps.readFile).toHaveBeenCalledWith(join("archives", "appcast.xml"));
    expect(deps.writeFile).toHaveBeenCalledWith(
      join("archives", "appcast.xml"),
      expect.stringContaining("v1.2.3/App-1.2.3.zip"),
    );
    expect(deps.log).toHaveBeenCalledWith(expect.stringMatching(/1 enclosure URL/));
  });
});

describe("runInjectPublicKey", () => {
  function makeFsDeps(overrides: Partial<RunInjectPublicKeyDeps> = {}): RunInjectPublicKeyDeps {
    return {
      readFile: vi.fn().mockReturnValue(`a ${SPARKLE_ED_PUBLIC_KEY_PLACEHOLDER} b`),
      writeFile: vi.fn(),
      log: vi.fn(),
      errorLog: vi.fn(),
      env: {},
      ...overrides,
    };
  }

  it("reads the file, replaces the placeholder and writes it back", () => {
    const deps = makeFsDeps();
    const code = runInjectPublicKey(
      { file: "Info.plist", key: "real-key", placeholder: SPARKLE_ED_PUBLIC_KEY_PLACEHOLDER },
      deps,
    );
    expect(code).toBe(0);
    expect(deps.readFile).toHaveBeenCalledWith("Info.plist");
    expect(deps.writeFile).toHaveBeenCalledWith("Info.plist", "a real-key b");
    expect(deps.log).toHaveBeenCalledWith(expect.stringMatching(/1 occurrence/));
  });

  it("falls back to the SPARKLE_ED_PUBLIC_KEY env var when --key is omitted", () => {
    const deps = makeFsDeps({ env: { SPARKLE_ED_PUBLIC_KEY: "env-key" } });
    const code = runInjectPublicKey(
      { file: "Info.plist", placeholder: SPARKLE_ED_PUBLIC_KEY_PLACEHOLDER },
      deps,
    );
    expect(code).toBe(0);
    expect(deps.writeFile).toHaveBeenCalledWith("Info.plist", "a env-key b");
  });

  it("errors when neither --key nor the env var is provided, without touching the file", () => {
    const deps = makeFsDeps();
    const code = runInjectPublicKey({ file: "Info.plist", placeholder: SPARKLE_ED_PUBLIC_KEY_PLACEHOLDER }, deps);
    expect(code).toBe(1);
    expect(deps.readFile).not.toHaveBeenCalled();
    expect(deps.writeFile).not.toHaveBeenCalled();
    expect(deps.errorLog).toHaveBeenCalledWith(expect.stringMatching(/SPARKLE_ED_PUBLIC_KEY/));
  });

  it("errors naming the file and placeholder when the placeholder is absent", () => {
    const deps = makeFsDeps({ readFile: vi.fn().mockReturnValue("no placeholder here") });
    const code = runInjectPublicKey(
      { file: "Info.plist", key: "real-key", placeholder: SPARKLE_ED_PUBLIC_KEY_PLACEHOLDER },
      deps,
    );
    expect(code).toBe(1);
    expect(deps.writeFile).not.toHaveBeenCalled();
    expect(deps.errorLog).toHaveBeenCalledWith(expect.stringContaining("Info.plist"));
    expect(deps.errorLog).toHaveBeenCalledWith(expect.stringContaining(SPARKLE_ED_PUBLIC_KEY_PLACEHOLDER));
  });
});

describe("runFixAppcast", () => {
  function makeFsDeps(overrides: Partial<FileSystemDeps> = {}): FileSystemDeps {
    return {
      readFile: vi
        .fn()
        .mockReturnValue('<enclosure url="https://github.com/owner/repo/releases/download/vOLD/App-1.2.3.zip" />'),
      writeFile: vi.fn(),
      log: vi.fn(),
      errorLog: vi.fn(),
      ...overrides,
    };
  }

  it("reads, rewrites and writes back the appcast, logging the rewrite count", () => {
    const deps = makeFsDeps();
    const code = runFixAppcast({ appcastPath: "appcast.xml", repo: "owner/repo", tagPrefix: "v" }, deps);
    expect(code).toBe(0);
    expect(deps.readFile).toHaveBeenCalledWith("appcast.xml");
    expect(deps.writeFile).toHaveBeenCalledWith(
      "appcast.xml",
      expect.stringContaining("v1.2.3/App-1.2.3.zip"),
    );
    expect(deps.log).toHaveBeenCalledWith(expect.stringMatching(/1 enclosure URL/));
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
    expect(deps.removeVendorDir).not.toHaveBeenCalled();

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

  it("removes the vendor dir before fetching when --force-fetch is passed", () => {
    const deps = makeDeps();
    runRebuild({ electronVersion: "43.1.0", arch: "arm64", forceFetch: true }, deps);
    expect(deps.removeVendorDir).toHaveBeenCalledWith("/pkg/native");

    const removeVendorOrder = (deps.removeVendorDir as unknown as ReturnType<typeof vi.fn>).mock
      .invocationCallOrder[0];
    const firstSpawnOrder = (deps.spawn as unknown as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
    expect(removeVendorOrder).toBeLessThan(firstSpawnOrder);
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

    const stashArgs = (deps.copyFile as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    const arm64IntermediatePath = stashArgs[1] as string;
    expect(arm64IntermediatePath).not.toMatch(/[/\\]build[/\\]/);
    expect(arm64IntermediatePath.startsWith("/pkg/native")).toBe(true);

    const lipoArgs = lipoCall[1] as string[];
    expect(lipoArgs).toContain(arm64IntermediatePath);
    expect(lipoArgs[0]).toBe("-create");

    // the x64 rebuild runs `rm -rf build/` before recompiling — the arm64
    // intermediate must live outside native/build/ or node-gyp destroys it
    expect(x64Call[1]).not.toEqual(expect.arrayContaining([arm64IntermediatePath]));
  });

  it("cleans up the arm64 intermediate after a successful universal build", () => {
    const deps = makeDeps();
    runRebuild({ electronVersion: "43.1.0", arch: "universal", forceFetch: false }, deps);

    const removeIntermediate = deps.removeIntermediate as unknown as ReturnType<typeof vi.fn>;
    expect(removeIntermediate).toHaveBeenCalledTimes(1);
    const cleanedPath = removeIntermediate.mock.calls[0][0] as string;
    expect(cleanedPath).not.toMatch(/[/\\]build[/\\]/);
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
