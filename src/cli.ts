import { copyFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  electron-sparkle-updater fix-appcast <appcast.xml> --repo <owner/repo> [--tag-prefix <string>]
  electron-sparkle-updater generate-appcast <archive-dir> --ed-key-file <path> --download-url-prefix <url> [--embed-release-notes] [--full-release-notes-url <url>] [--repo <owner/repo>] [--tag-prefix <string>] [--sparkle-bin <dir>]`;

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

export interface GenerateAppcastOptions {
  archiveDir: string;
  edKeyFile: string;
  downloadUrlPrefix: string;
  embedReleaseNotes: boolean;
  fullReleaseNotesUrl?: string;
  repo?: string;
  tagPrefix: string;
  sparkleBin?: string;
}

export type ParsedCommand =
  | { kind: "rebuild"; options: RebuildOptions }
  | { kind: "inject-public-key"; options: InjectPublicKeyOptions }
  | { kind: "fix-appcast"; options: FixAppcastOptions }
  | { kind: "generate-appcast"; options: GenerateAppcastOptions }
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

function parseGenerateAppcastArgs(rest: string[]): ParsedCommand {
  let values: { [key: string]: string | boolean | undefined };
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({
      args: rest,
      options: {
        "ed-key-file": { type: "string" },
        "download-url-prefix": { type: "string" },
        "embed-release-notes": { type: "boolean", default: false },
        "full-release-notes-url": { type: "string" },
        repo: { type: "string" },
        "tag-prefix": { type: "string" },
        "sparkle-bin": { type: "string" },
      },
      allowPositionals: true,
      strict: true,
    }));
  } catch (err) {
    return { kind: "usage", exitCode: 1, message: (err as Error).message };
  }

  const archiveDir = positionals[0];
  if (!archiveDir) {
    return { kind: "usage", exitCode: 1, message: "archive-dir is required" };
  }

  const edKeyFile = values["ed-key-file"] as string | undefined;
  if (!edKeyFile) {
    return { kind: "usage", exitCode: 1, message: "--ed-key-file is required" };
  }

  const downloadUrlPrefix = values["download-url-prefix"] as string | undefined;
  if (!downloadUrlPrefix) {
    return { kind: "usage", exitCode: 1, message: "--download-url-prefix is required" };
  }

  return {
    kind: "generate-appcast",
    options: {
      archiveDir,
      edKeyFile,
      downloadUrlPrefix,
      embedReleaseNotes: Boolean(values["embed-release-notes"]),
      fullReleaseNotesUrl: values["full-release-notes-url"] as string | undefined,
      repo: values.repo as string | undefined,
      tagPrefix: (values["tag-prefix"] as string | undefined) ?? "v",
      sparkleBin: values["sparkle-bin"] as string | undefined,
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
    case "generate-appcast":
      return parseGenerateAppcastArgs(rest);
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

export interface RunGenerateAppcastDeps extends FileSystemDeps {
  cwd: string;
  spawn: SpawnFn;
  defaultSparkleBin: string;
  fileExists: (path: string) => boolean;
}

export function runGenerateAppcast(options: GenerateAppcastOptions, deps: RunGenerateAppcastDeps): number {
  const sparkleBinDir = options.sparkleBin ?? deps.defaultSparkleBin;
  const generateAppcastBin = join(sparkleBinDir, "generate_appcast");

  if (!deps.fileExists(generateAppcastBin)) {
    deps.errorLog?.(
      `generate_appcast not found at ${generateAppcastBin}; run \`electron-sparkle-updater rebuild\` or \`native/scripts/fetch-sparkle.sh\` to fetch Sparkle's tools`,
    );
    return 1;
  }

  const args = ["--ed-key-file", options.edKeyFile, "--download-url-prefix", options.downloadUrlPrefix];
  if (options.embedReleaseNotes) {
    args.push("--embed-release-notes");
  }
  if (options.fullReleaseNotesUrl) {
    args.push("--full-release-notes-url", options.fullReleaseNotesUrl);
  }
  args.push(options.archiveDir);

  const result = deps.spawn(generateAppcastBin, args, { cwd: deps.cwd, stdio: "inherit" });
  if (result.status !== 0) {
    return result.status ?? 1;
  }

  if (options.repo) {
    const appcastPath = join(options.archiveDir, "appcast.xml");
    const xml = deps.readFile(appcastPath);
    const fixed = fixAppcastEnclosureUrls(xml, options.repo, options.tagPrefix);
    deps.writeFile(appcastPath, fixed.xml);
    deps.log?.(`${fixed.rewrites} enclosure URL(s) rewritten in ${appcastPath}`);
  }

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

  if (parsed.kind === "generate-appcast") {
    return runGenerateAppcast(parsed.options, {
      ...fileSystemDeps,
      cwd: process.cwd(),
      spawn: (command, args, spawnOptions) => spawnSync(command, args, spawnOptions),
      defaultSparkleBin: join(nativeDir, "vendor", "bin"),
      fileExists: (path) => existsSync(path),
    });
  }

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
