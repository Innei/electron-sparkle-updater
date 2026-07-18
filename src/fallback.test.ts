import { describe, expect, it, vi } from "vitest";
import {
  checkForUpdate,
  DEFAULT_THROTTLE_MS,
  githubLatestReleaseUrl,
  isNewerVersion,
  parseLatestRelease,
  shouldCheck,
  type UpdaterDeps,
} from "./fallback.js";

describe("isNewerVersion", () => {
  it.each([
    ["1.0.0", "1.0.1", true],
    ["1.0.0", "1.0.0", false],
    ["1.2.0", "1.1.9", false],
    ["v1.0.0", "1.0.1", true],
    ["1.0.0", "v1.0.1", true],
    ["1.0.0", "not-a-version", false],
    ["garbage", "1.0.0", true],
    ["1.0", "1.0.1", true],
    ["1.0.0", "1.0.0.1", true],
  ])("isNewerVersion(%s, %s) -> %s", (current, latest, expected) => {
    expect(isNewerVersion(current, latest)).toBe(expected);
  });

  it("strips a configurable tag prefix", () => {
    expect(isNewerVersion("desktop-v1.0.0", "desktop-v1.0.1", { tagPrefix: "desktop-v" })).toBe(true);
    expect(isNewerVersion("desktop-v1.0.1", "1.0.0", { tagPrefix: "desktop-v" })).toBe(false);
  });

  it("defaults the tag prefix to v", () => {
    expect(isNewerVersion("v1.0.0", "v1.0.1")).toBe(true);
  });
});

describe("shouldCheck", () => {
  const now = "2026-07-11T12:00:00.000Z";

  it("checks when there is no prior record", () => {
    expect(shouldCheck(null, now, DEFAULT_THROTTLE_MS)).toBe(true);
  });

  it("checks when the record is malformed", () => {
    expect(shouldCheck("not-a-date", now, DEFAULT_THROTTLE_MS)).toBe(true);
  });

  it("does not check inside the throttle window", () => {
    const last = "2026-07-11T11:00:01.000Z";
    expect(shouldCheck(last, now, DEFAULT_THROTTLE_MS)).toBe(false);
  });

  it("checks once past the throttle window", () => {
    const last = "2026-07-11T10:58:59.000Z";
    expect(shouldCheck(last, now, DEFAULT_THROTTLE_MS)).toBe(true);
  });

  it("honors a custom throttle interval", () => {
    const last = "2026-07-11T11:59:00.000Z";
    expect(shouldCheck(last, now, 30_000)).toBe(true);
    expect(shouldCheck(last, now, 120_000)).toBe(false);
  });

  it("DEFAULT_THROTTLE_MS is one hour", () => {
    expect(DEFAULT_THROTTLE_MS).toBe(60 * 60 * 1000);
  });
});

describe("parseLatestRelease", () => {
  it("parses a normal release payload", () => {
    expect(
      parseLatestRelease({
        tag_name: "v1.2.3",
        html_url: "https://github.com/owner/repo/releases/tag/v1.2.3",
        draft: false,
      }),
    ).toEqual({
      version: "v1.2.3",
      htmlUrl: "https://github.com/owner/repo/releases/tag/v1.2.3",
    });
  });

  it("rejects a draft release", () => {
    expect(parseLatestRelease({ tag_name: "v1.0.0", html_url: "https://x", draft: true })).toBeNull();
  });

  it("rejects a payload missing html_url", () => {
    expect(parseLatestRelease({ tag_name: "v1.0.0" })).toBeNull();
  });

  it("rejects a payload missing tag_name", () => {
    expect(parseLatestRelease({ html_url: "https://x" })).toBeNull();
  });

  it("rejects null", () => {
    expect(parseLatestRelease(null)).toBeNull();
  });

  it("rejects a non-object (e.g. 404 body)", () => {
    expect(parseLatestRelease({ message: "Not Found" })).toBeNull();
  });

  it("rejects malformed shapes", () => {
    expect(parseLatestRelease("not json")).toBeNull();
    expect(parseLatestRelease(42)).toBeNull();
  });
});

describe("githubLatestReleaseUrl", () => {
  it("builds the releases/latest API URL for an owner/repo slug", () => {
    expect(githubLatestReleaseUrl("Innei/kansoku")).toBe(
      "https://api.github.com/repos/Innei/kansoku/releases/latest",
    );
  });
});

function makeDeps(overrides: Partial<UpdaterDeps> = {}): UpdaterDeps {
  return {
    currentVersion: "1.0.0",
    now: () => "2026-07-11T12:00:00.000Z",
    fetchJson: vi.fn().mockResolvedValue({
      tag_name: "v1.1.0",
      html_url: "https://github.com/owner/repo/releases/tag/v1.1.0",
      draft: false,
    }),
    readLastCheck: vi.fn().mockResolvedValue(null),
    writeLastCheck: vi.fn().mockResolvedValue(undefined),
    notify: vi.fn(),
    releasesUrl: "https://api.github.com/repos/owner/repo/releases/latest",
    ...overrides,
  };
}

describe("checkForUpdate", () => {
  it("notifies when a newer release exists and persists the check timestamp", async () => {
    const deps = makeDeps();
    await checkForUpdate(deps);
    expect(deps.notify).toHaveBeenCalledWith({
      version: "v1.1.0",
      htmlUrl: "https://github.com/owner/repo/releases/tag/v1.1.0",
    });
    expect(deps.writeLastCheck).toHaveBeenCalledWith("2026-07-11T12:00:00.000Z");
  });

  it("fetches from the given releasesUrl", async () => {
    const deps = makeDeps({ releasesUrl: "https://api.github.com/repos/foo/bar/releases/latest" });
    await checkForUpdate(deps);
    expect(deps.fetchJson).toHaveBeenCalledWith("https://api.github.com/repos/foo/bar/releases/latest");
  });

  it("skips the network call entirely when the throttle blocks it", async () => {
    const deps = makeDeps({ readLastCheck: vi.fn().mockResolvedValue("2026-07-11T11:30:00.000Z") });
    await checkForUpdate(deps);
    expect(deps.fetchJson).not.toHaveBeenCalled();
    expect(deps.notify).not.toHaveBeenCalled();
  });

  it("honors a custom throttleMs", async () => {
    const deps = makeDeps({
      readLastCheck: vi.fn().mockResolvedValue("2026-07-11T11:59:00.000Z"),
      throttleMs: 30_000,
    });
    await checkForUpdate(deps);
    expect(deps.fetchJson).toHaveBeenCalled();
  });

  it("does not notify when the latest release is not newer", async () => {
    const deps = makeDeps({
      fetchJson: vi.fn().mockResolvedValue({
        tag_name: "v1.0.0",
        html_url: "https://x",
        draft: false,
      }),
    });
    await checkForUpdate(deps);
    expect(deps.notify).not.toHaveBeenCalled();
    expect(deps.writeLastCheck).toHaveBeenCalled();
  });

  it("stays silent when the fetch rejects (offline / rate-limit)", async () => {
    const deps = makeDeps({ fetchJson: vi.fn().mockRejectedValue(new Error("network down")) });
    await expect(checkForUpdate(deps)).resolves.toEqual({
      kind: "fetch-failed",
      message: "network down",
    });
    expect(deps.notify).not.toHaveBeenCalled();
    expect(deps.writeLastCheck).not.toHaveBeenCalled();
  });

  it("stays silent when the response parses to null (404 / draft-only repo)", async () => {
    const deps = makeDeps({ fetchJson: vi.fn().mockResolvedValue({ message: "Not Found" }) });
    await checkForUpdate(deps);
    expect(deps.notify).not.toHaveBeenCalled();
    expect(deps.writeLastCheck).toHaveBeenCalled();
  });

  it("bypasses throttle when force is true", async () => {
    const deps = makeDeps({
      force: true,
      readLastCheck: vi.fn().mockResolvedValue("2026-07-11T11:30:00.000Z"),
    });
    const result = await checkForUpdate(deps);
    expect(deps.fetchJson).toHaveBeenCalled();
    expect(result.kind).toBe("available");
  });

  it("returns up-to-date when force check finds no newer release", async () => {
    const deps = makeDeps({
      force: true,
      fetchJson: vi.fn().mockResolvedValue({
        tag_name: "v1.0.0",
        html_url: "https://x",
        draft: false,
      }),
    });
    const result = await checkForUpdate(deps);
    expect(result).toEqual({ kind: "up-to-date", current: "1.0.0", latest: "v1.0.0" });
    expect(deps.notify).not.toHaveBeenCalled();
  });

  it("does not notify when silent and a newer release exists", async () => {
    const deps = makeDeps({ silent: true });
    const result = await checkForUpdate(deps);
    expect(result.kind).toBe("available");
    expect(deps.notify).not.toHaveBeenCalled();
  });

  it("applies a custom tagPrefix when comparing versions", async () => {
    const deps = makeDeps({
      currentVersion: "desktop-v1.0.0",
      tagPrefix: "desktop-v",
      fetchJson: vi.fn().mockResolvedValue({
        tag_name: "desktop-v1.1.0",
        html_url: "https://x",
        draft: false,
      }),
    });
    const result = await checkForUpdate(deps);
    expect(result.kind).toBe("available");
  });

  it("writes last-check AFTER a successful fetch, not before", async () => {
    const order: string[] = [];
    const deps = makeDeps({
      fetchJson: vi.fn().mockImplementation(async () => {
        order.push("fetch");
        return { tag_name: "v1.1.0", html_url: "https://x", draft: false };
      }),
      writeLastCheck: vi.fn().mockImplementation(async () => {
        order.push("write");
      }),
    });
    await checkForUpdate(deps);
    expect(order).toEqual(["fetch", "write"]);
  });

  it("does not writeLastCheck when the fetch fails", async () => {
    const deps = makeDeps({ fetchJson: vi.fn().mockRejectedValue(new Error("boom")) });
    await checkForUpdate(deps);
    expect(deps.writeLastCheck).not.toHaveBeenCalled();
  });

  it("calls log with the appropriate message at each stage", async () => {
    const log = vi.fn();
    const deps = makeDeps({ log });
    await checkForUpdate(deps);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("notified"));
  });
});
