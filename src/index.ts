import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface SparkleInitOptions {
  appcastUrl: string;
  publicEdKey?: string;
  /** Applied to both the appcast and update-enclosure fetch (SPUUpdater.httpHeaders). */
  httpHeaders?: Record<string, string>;
}

export type SparkleBridgeEventType =
  | "checking"
  | "update-available"
  | "download-progress"
  | "update-downloaded"
  | "update-not-available"
  | "error";

export interface SparkleBridgeEvent {
  type: SparkleBridgeEventType | string;
  version?: string;
  releaseName?: string;
  releaseDate?: string;
  releaseNotes?: string;
  phase?: "download" | "apply";
  percent?: number;
  transferred?: number;
  total?: number;
  fallback?: boolean;
  message?: string;
}

export interface SparkleBridge {
  init(options: SparkleInitOptions): boolean;
  checkForUpdates(): void;
  installUpdateNow(): void;
  installUpdateOnQuit(): void;
  setAutomaticChecks(enabled: boolean): void;
  setEventHandler(handler: (event: SparkleBridgeEvent) => void): void;
}

interface ResolveSparkleAddonPathDeps {
  isPackaged: boolean;
  resourcesPath: string;
  packageRoot: string;
}

interface LoadSparkleBridgeDeps {
  isPackaged: boolean;
  resourcesPath: string;
  log?: (message: string) => void;
  addonPath?: string;
}

interface ElectronModule {
  app: {
    isPackaged: boolean;
  };
}

const PACKAGE_NAME = "electron-sparkle-updater";
const ADDON_RELATIVE_PATH = join("native", "build", "Release", "sparkle_bridge.node");

export function resolveSparkleAddonPath(deps: ResolveSparkleAddonPathDeps): string {
  if (deps.isPackaged) {
    return join(deps.resourcesPath, "app.asar.unpacked", "node_modules", PACKAGE_NAME, ADDON_RELATIVE_PATH);
  }
  return join(deps.packageRoot, ADDON_RELATIVE_PATH);
}

function defaultPackageRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..");
}

export function loadSparkleBridge(deps: LoadSparkleBridgeDeps): SparkleBridge | null {
  if (process.platform !== "darwin") {
    return null;
  }

  const addonPath =
    deps.addonPath ??
    resolveSparkleAddonPath({
      isPackaged: deps.isPackaged,
      resourcesPath: deps.resourcesPath,
      packageRoot: defaultPackageRoot(),
    });

  try {
    const require = createRequire(import.meta.url);
    const addon = require(addonPath) as SparkleBridge;
    if (
      typeof addon.init !== "function" ||
      typeof addon.checkForUpdates !== "function" ||
      typeof addon.installUpdateNow !== "function" ||
      typeof addon.installUpdateOnQuit !== "function" ||
      typeof addon.setAutomaticChecks !== "function" ||
      typeof addon.setEventHandler !== "function"
    ) {
      deps.log?.("addon loaded but missing expected exports, treating as unavailable");
      return null;
    }
    return addon;
  } catch (err) {
    deps.log?.(`addon load failed: ${(err as Error).message}`);
    return null;
  }
}

export async function loadSparkleBridgeForApp(log?: (message: string) => void): Promise<SparkleBridge | null> {
  if (process.platform !== "darwin") {
    return null;
  }

  let electronModule: ElectronModule;
  try {
    electronModule = (await import("electron")) as unknown as ElectronModule;
  } catch (err) {
    log?.(`electron import failed: ${(err as Error).message}`);
    return null;
  }

  return loadSparkleBridge({
    isPackaged: electronModule.app.isPackaged,
    resourcesPath: process.resourcesPath,
    log,
  });
}
