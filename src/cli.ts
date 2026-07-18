import { copyFileSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { fixAppcastEnclosureUrls, injectPublicKey } from "./appcast.js";
import { SPARKLE_ED_PUBLIC_KEY_PLACEHOLDER } from "./builder.js";

const USAGE = `Usage:
  electron-sparkle-updater rebuild [--electron-version <v>] [--arch arm64|x64|universal] [--force-fetch]
  electron-sparkle-updater inject-public-key --file <path> --key <value> [--placeholder <string>]
  electron-sparkle-updater fix-appcast <appcast.xml> --repo <owner/repo> [--tag-prefix <string>]`;

type Arch = "arm64" | "x64" | "universal";

export interface RebuildOptions {
  electronVersion?: string;
  arch: Arch;
  forceFetch: boolean;
}

export interface InjectPublicKeyOptions {
  file: string;
  key?: string;
  placeholder: string;
}

export interface FixAppcastOptions {
  appcastPath: string;
  repo: string;
  tagPrefix: string;
}

export type ParsedCommand =
  | { kind: "rebuild"; options: RebuildOptions }
  | { kind: "inject-public-key"; options: InjectPublicKeyOptions }
  | { kind: "fix-appcast"; options: FixAppcastOptions }
  | { kind: "usage"; exitCode: number; message?: string };

function isArch(value: string): value is Arch {
  return value === "arm64" || value === "x64" || value === "universal";
}

function parseRebuildArgs(rest: string[]): ParsedCommand {
  let values: { [key: string]: string | boolean | undefined };
  try {
    ({ values } = parseArgs({
      args: rest,
      options: {
        "electron-version": { type: "string" },
        arch: { type: "string" },
        "force-fetch": { type: "boolean", default: false },
      },
      strict: true,
    }));
  } catch (err) {
    return { kind: "usage", exitCode: 1, message: (err as Error).message };
  }

  const archValue = (values.arch as string | undefined) ?? process.arch;
  if (!isArch(archValue)) {
    return { kind: "usage", exitCode: 1, message: `invalid --arch: ${archValue}` };
  }

  return {
    kind: "rebuild",
    options: {
      electronVersion: values["electron-version"] as string | undefined,
      arch: archValue,
      forceFetch: Boolean(values["force-fetch"]),
    },
  };
}

function parseInjectPublicKeyArgs(rest: string[]): ParsedCommand {
  let values: { [key: string]: string | boolean | undefined };
  try {
    ({ values } = parseArgs({
      args: rest,
      options: {
        file: { type: "string" },
        key: { type: "string" },
        placeholder: { type: "string" },
      },
      strict: true,
    }));
  } catch (err) {
    return { kind: "usage", exitCode: 1, message: (err as Error).message };
  }

  const file = values.file as string | undefined;
  if (!file) {
    return { kind: "usage", exitCode: 1, message: "--file is required" };
  }

  return {
    kind: "inject-public-key",
    options: {
      file,
      key: values.key as string | undefined,
      placeholder: (values.placeholder as string | undefined) ?? SPARKLE_ED_PUBLIC_KEY_PLACEHOLDER,
    },
  };
}

function parseFixAppcastArgs(rest: string[]): ParsedCommand {
  let values: { [key: string]: string | boolean | undefined };
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({
      args: rest,
      options: {
        repo: { type: "string" },
        "tag-prefix": { type: "string" },
      },
      allowPositionals: true,
      strict: true,
    }));
  } catch (err) {
    return { kind: "usage", exitCode: 1, message: (err as Error).message };
  }

  const appcastPath = positionals[0];
  if (!appcastPath) {
    return { kind: "usage", exitCode: 1, message: "appcast.xml path is required" };
  }

  const repo = values.repo as string | undefined;
  if (!repo) {
    return { kind: "usage", exitCode: 1, message: "--repo is required" };
  }

  return {
    kind: "fix-appcast",
    options: {
      appcastPath,
      repo,
      tagPrefix: (values["tag-prefix"] as string | undefined) ?? "v",
    },
  };
}

export function parseCliArgs(argv: string[]): ParsedCommand {
  const [command, ...rest] = argv;
  switch (command) {
    case "rebuild":
      return parseRebuildArgs(rest);
    case "inject-public-key":
      return parseInjectPublicKeyArgs(rest);
    case "fix-appcast":
      return parseFixAppcastArgs(rest);
    default:
      return {
        kind: "usage",
        exitCode: 1,
        message: command ? `unknown command: ${command}` : undefined,
      };
  }
}

export function resolveElectronVersion(cwd: string): string {
  try {
    const require = createRequire(join(cwd, "package.json"));
    const electronPackage = require("electron/package.json") as { version: string };
    return electronPackage.version;
  } catch {
    throw new Error(
      "could not resolve electron version: electron is not installed in this project; pass --electron-version explicitly",
    );
  }
}

export interface SpawnResult {
  status: number | null;
}

export type SpawnFn = (
  command: string,
  args: string[],
  options: { cwd: string; stdio: "inherit" },
) => SpawnResult;

export interface RunRebuildDeps {
  platform: NodeJS.Platform;
  cwd: string;
  nativeDir: string;
  spawn: SpawnFn;
  resolveElectronVersion: (cwd: string) => string;
  removeVendorDir: (nativeDir: string) => void;
  copyFile: (src: string, dest: string) => void;
  removeIntermediate: (path: string) => void;
  log?: (message: string) => void;
  errorLog?: (message: string) => void;
}

function resolveNodeGypBin(): string {
  const require = createRequire(import.meta.url);
  const nodeGypPackage = require("node-gyp/package.json") as { bin: string | Record<string, string> };
  const binPath = typeof nodeGypPackage.bin === "string" ? nodeGypPackage.bin : nodeGypPackage.bin["node-gyp"];
  return require.resolve(join("node-gyp", binPath));
}

function runNodeGypRebuild(electronVersion: string, arch: "arm64" | "x64", deps: RunRebuildDeps): SpawnResult {
  return deps.spawn(
    process.execPath,
    [
      resolveNodeGypBin(),
      "rebuild",
      `--target=${electronVersion}`,
      `--arch=${arch}`,
      "--dist-url=https://electronjs.org/headers",
    ],
    { cwd: deps.nativeDir, stdio: "inherit" },
  );
}

function runUniversalRebuild(electronVersion: string, deps: RunRebuildDeps): number {
  const releaseDir = join(deps.nativeDir, "build", "Release");
  const finalPath = join(releaseDir, "sparkle_bridge.node");
  const universalPath = join(releaseDir, "sparkle_bridge.universal.node");
  const arm64IntermediatePath = join(deps.nativeDir, "sparkle_bridge.arm64.node");

  const arm64Result = runNodeGypRebuild(electronVersion, "arm64", deps);
  if (arm64Result.status !== 0) {
    return arm64Result.status ?? 1;
  }
  deps.copyFile(finalPath, arm64IntermediatePath);

  const x64Result = runNodeGypRebuild(electronVersion, "x64", deps);
  if (x64Result.status !== 0) {
    deps.removeIntermediate(arm64IntermediatePath);
    return x64Result.status ?? 1;
  }

  const lipoResult = deps.spawn(
    "lipo",
    ["-create", arm64IntermediatePath, finalPath, "-output", universalPath],
    { cwd: deps.nativeDir, stdio: "inherit" },
  );
  deps.removeIntermediate(arm64IntermediatePath);
  if (lipoResult.status !== 0) {
    return lipoResult.status ?? 1;
  }

  deps.copyFile(universalPath, finalPath);
  return 0;
}

export function runRebuild(options: RebuildOptions, deps: RunRebuildDeps): number {
  if (deps.platform !== "darwin") {
    deps.errorLog?.("electron-sparkle-updater rebuild only supports macOS");
    return 1;
  }

  let electronVersion: string;
  try {
    electronVersion = options.electronVersion ?? deps.resolveElectronVersion(deps.cwd);
  } catch (err) {
    deps.errorLog?.((err as Error).message);
    return 1;
  }

  if (options.forceFetch) {
    deps.removeVendorDir(deps.nativeDir);
  }

  const fetchResult = deps.spawn("bash", [join(deps.nativeDir, "scripts", "fetch-sparkle.sh")], {
    cwd: deps.nativeDir,
    stdio: "inherit",
  });
  if (fetchResult.status !== 0) {
    return fetchResult.status ?? 1;
  }

  if (options.arch === "universal") {
    return runUniversalRebuild(electronVersion, deps);
  }

  const rebuildResult = runNodeGypRebuild(electronVersion, options.arch, deps);
  return rebuildResult.status ?? 1;
}

function removeVendorDir(nativeDir: string): void {
  rmSync(join(nativeDir, "vendor"), { recursive: true, force: true });
}

export interface FileSystemDeps {
  readFile: (path: string) => string;
  writeFile: (path: string, content: string) => void;
  log?: (message: string) => void;
  errorLog?: (message: string) => void;
}

export interface RunInjectPublicKeyDeps extends FileSystemDeps {
  env: NodeJS.ProcessEnv;
}

export function runInjectPublicKey(options: InjectPublicKeyOptions, deps: RunInjectPublicKeyDeps): number {
  const key = options.key ?? deps.env.SPARKLE_ED_PUBLIC_KEY;
  if (!key) {
    deps.errorLog?.("no key provided: pass --key or set the SPARKLE_ED_PUBLIC_KEY environment variable");
    return 1;
  }

  const content = deps.readFile(options.file);
  let result: ReturnType<typeof injectPublicKey>;
  try {
    result = injectPublicKey(content, key, options.placeholder);
  } catch (err) {
    deps.errorLog?.(`${options.file}: ${(err as Error).message}`);
    return 1;
  }

  deps.writeFile(options.file, result.content);
  deps.log?.(`${result.replacements} occurrence(s) of ${options.placeholder} replaced in ${options.file}`);
  return 0;
}

export function runFixAppcast(options: FixAppcastOptions, deps: FileSystemDeps): number {
  const xml = deps.readFile(options.appcastPath);
  const result = fixAppcastEnclosureUrls(xml, options.repo, options.tagPrefix);
  deps.writeFile(options.appcastPath, result.xml);
  deps.log?.(`${result.rewrites} enclosure URL(s) rewritten in ${options.appcastPath}`);
  return 0;
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const parsed = parseCliArgs(argv);
  if (parsed.kind === "usage") {
    if (parsed.message) {
      console.error(parsed.message);
    }
    console.error(USAGE);
    return parsed.exitCode;
  }

  const fileSystemDeps: FileSystemDeps = {
    readFile: (path) => readFileSync(path, "utf8"),
    writeFile: (path, content) => writeFileSync(path, content),
    log: (message) => console.log(message),
    errorLog: (message) => console.error(message),
  };

  if (parsed.kind === "inject-public-key") {
    return runInjectPublicKey(parsed.options, { ...fileSystemDeps, env: process.env });
  }

  if (parsed.kind === "fix-appcast") {
    return runFixAppcast(parsed.options, fileSystemDeps);
  }

  const nativeDir = join(dirname(fileURLToPath(import.meta.url)), "..", "native");

  return runRebuild(parsed.options, {
    platform: process.platform,
    cwd: process.cwd(),
    nativeDir,
    spawn: (command, args, spawnOptions) => spawnSync(command, args, spawnOptions),
    resolveElectronVersion,
    removeVendorDir,
    copyFile: (src, dest) => copyFileSync(src, dest),
    removeIntermediate: (path) => rmSync(path, { force: true }),
    log: (message) => console.log(message),
    errorLog: (message) => console.error(message),
  });
}
