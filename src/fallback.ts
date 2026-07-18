import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const DEFAULT_THROTTLE_MS = 60 * 60 * 1000;
const DEFAULT_FETCH_TIMEOUT_MS = 5_000;
const DEFAULT_USER_AGENT = "electron-sparkle-updater";
const DEFAULT_TAG_PREFIX = "v";

export interface ReleaseInfo {
  version: string;
  htmlUrl: string;
}

export type CheckForUpdateResult =
  | { kind: "throttled" }
  | { kind: "fetch-failed"; message: string }
  | { kind: "no-release" }
  | { kind: "up-to-date"; current: string; latest: string }
  | { kind: "available"; release: ReleaseInfo };

export interface UpdaterDeps {
  currentVersion: string;
  now: () => string;
  fetchJson: (url: string) => Promise<unknown>;
  readLastCheck: () => Promise<string | null>;
  writeLastCheck: (iso: string) => Promise<void>;
  notify: (release: ReleaseInfo) => void;
  releasesUrl: string;
  tagPrefix?: string;
  throttleMs?: number;
  log?: (message: string) => void;
  force?: boolean;
  silent?: boolean;
}

function normalizeVersion(raw: string, tagPrefix: string): number[] {
  const prefixPattern = new RegExp(`^${tagPrefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "i");
  const stripped = raw.replace(prefixPattern, "").replace(/^v/i, "");
  return stripped.split(".").map((part) => {
    const n = Number.parseInt(part, 10);
    return Number.isNaN(n) ? 0 : n;
  });
}

export function isNewerVersion(current: string, latest: string, options?: { tagPrefix?: string }): boolean {
  const tagPrefix = options?.tagPrefix ?? DEFAULT_TAG_PREFIX;
  const a = normalizeVersion(current, tagPrefix);
  const b = normalizeVersion(latest, tagPrefix);
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    if (bv > av) return true;
    if (bv < av) return false;
  }
  return false;
}

export function shouldCheck(lastCheckIso: string | null, nowIso: string, throttleMs: number): boolean {
  if (!lastCheckIso) return true;
  const last = Date.parse(lastCheckIso);
  if (Number.isNaN(last)) return true;
  return Date.parse(nowIso) - last >= throttleMs;
}

export function parseLatestRelease(json: unknown): ReleaseInfo | null {
  if (typeof json !== "object" || json === null) return null;
  const record = json as Record<string, unknown>;
  if (record.draft === true) return null;
  const { tag_name, html_url } = record;
  if (typeof tag_name !== "string" || typeof html_url !== "string") return null;
  return { version: tag_name, htmlUrl: html_url };
}

export function githubLatestReleaseUrl(ownerRepo: string): string {
  return `https://api.github.com/repos/${ownerRepo}/releases/latest`;
}

export async function checkForUpdate(deps: UpdaterDeps): Promise<CheckForUpdateResult> {
  const nowIso = deps.now();
  const throttleMs = deps.throttleMs ?? DEFAULT_THROTTLE_MS;
  if (!deps.force) {
    const lastCheck = await deps.readLastCheck();
    if (!shouldCheck(lastCheck, nowIso, throttleMs)) {
      deps.log?.("skipped: throttled");
      return { kind: "throttled" };
    }
  }

  let json: unknown;
  try {
    json = await deps.fetchJson(deps.releasesUrl);
  } catch (err) {
    const message = (err as Error).message;
    deps.log?.(`skipped: fetch failed (${message})`);
    return { kind: "fetch-failed", message };
  }

  await deps.writeLastCheck(nowIso);

  const release = parseLatestRelease(json);
  if (!release) {
    deps.log?.("no-op: no usable release found");
    return { kind: "no-release" };
  }
  if (!isNewerVersion(deps.currentVersion, release.version, { tagPrefix: deps.tagPrefix })) {
    deps.log?.(`no-op: up to date (current ${deps.currentVersion}, latest ${release.version})`);
    return { kind: "up-to-date", current: deps.currentVersion, latest: release.version };
  }
  if (!deps.silent) {
    deps.notify(release);
    deps.log?.(`notified: ${release.version} available`);
  } else {
    deps.log?.(`silent available: ${release.version}`);
  }
  return { kind: "available", release };
}

interface PersistedState {
  lastCheckIso?: string;
}

async function readLastCheckFile(filePath: string): Promise<string | null> {
  try {
    const raw = await readFile(filePath, "utf8");
    const state = JSON.parse(raw) as PersistedState;
    return typeof state.lastCheckIso === "string" ? state.lastCheckIso : null;
  } catch {
    return null;
  }
}

async function writeLastCheckFile(filePath: string, iso: string): Promise<void> {
  const state: PersistedState = { lastCheckIso: iso };
  await writeFile(filePath, JSON.stringify(state));
}

export async function fetchJsonWithTimeout(
  url: string,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
  userAgent: string = DEFAULT_USER_AGENT,
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        accept: "application/vnd.github+json",
        "user-agent": userAgent,
      },
    });
    if (!res.ok) return { message: `http ${res.status}` };
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

export interface CreateElectronFallbackDepsOptions {
  ownerRepo: string;
  tagPrefix?: string;
  notificationTitle: string;
  notificationBody?: (release: ReleaseInfo) => string;
  log?: (message: string) => void;
}

export async function createElectronFallbackDeps(
  options: CreateElectronFallbackDepsOptions,
): Promise<UpdaterDeps> {
  const { app, Notification, shell } = await import("electron");
  const stateFile = join(app.getPath("userData"), "updater.json");

  return {
    currentVersion: app.getVersion(),
    now: () => new Date().toISOString(),
    fetchJson: (url) => fetchJsonWithTimeout(url),
    readLastCheck: () => readLastCheckFile(stateFile),
    writeLastCheck: (iso) => writeLastCheckFile(stateFile, iso),
    notify: (release) => {
      const notification = new Notification({
        title: options.notificationTitle,
        body: options.notificationBody?.(release) ?? `${release.version} is ready — click to view the release`,
      });
      notification.on("click", () => {
        shell.openExternal(release.htmlUrl).catch((err) => {
          options.log?.(`skipped: openExternal failed (${(err as Error).message})`);
        });
      });
      notification.show();
    },
    releasesUrl: githubLatestReleaseUrl(options.ownerRepo),
    tagPrefix: options.tagPrefix,
    log: options.log,
  };
}
