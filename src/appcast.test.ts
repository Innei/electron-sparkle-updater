import { describe, expect, it } from "vitest";
import { fixAppcastEnclosureUrls, injectPublicKey } from "./appcast.js";

describe("injectPublicKey", () => {
  it("replaces all occurrences of the placeholder with the key", () => {
    const content = "a SPARKLE_ED_PUBLIC_KEY_PLACEHOLDER b SPARKLE_ED_PUBLIC_KEY_PLACEHOLDER c";
    const result = injectPublicKey(content, "real-key", "SPARKLE_ED_PUBLIC_KEY_PLACEHOLDER");
    expect(result).toEqual({ content: "a real-key b real-key c", replacements: 2 });
  });

  it("throws naming the placeholder when it does not occur", () => {
    expect(() => injectPublicKey("no match here", "real-key", "SPARKLE_ED_PUBLIC_KEY_PLACEHOLDER")).toThrow(
      /SPARKLE_ED_PUBLIC_KEY_PLACEHOLDER/,
    );
  });

  it("supports a custom placeholder token", () => {
    const result = injectPublicKey("<<KEY>>", "real-key", "<<KEY>>");
    expect(result).toEqual({ content: "real-key", replacements: 1 });
  });
});

describe("fixAppcastEnclosureUrls", () => {
  const makeXml = (url: string) =>
    `<?xml version="1.0"?><rss><channel><item><enclosure ${url} /></item></channel></rss>`;

  it("repoints an enclosure URL to the version's own tag using the default v prefix", () => {
    const xml = makeXml(
      'url="https://github.com/owner/repo/releases/download/vSOMETHING-ELSE/App-1.2.3.zip"',
    );
    const result = fixAppcastEnclosureUrls(xml, "owner/repo", "v");
    expect(result.rewrites).toBe(1);
    expect(result.xml).toContain(
      'url="https://github.com/owner/repo/releases/download/v1.2.3/App-1.2.3.zip"',
    );
  });

  it("supports a custom tag prefix such as desktop-v", () => {
    const xml = makeXml(
      'url="https://github.com/owner/repo/releases/download/desktop-vOLD/App-2.0.0.zip"',
    );
    const result = fixAppcastEnclosureUrls(xml, "owner/repo", "desktop-v");
    expect(result.rewrites).toBe(1);
    expect(result.xml).toContain(
      'url="https://github.com/owner/repo/releases/download/desktop-v2.0.0/App-2.0.0.zip"',
    );
  });

  it("defaults the tag prefix to v when omitted", () => {
    const xml = makeXml('url="https://github.com/owner/repo/releases/download/vOLD/App-3.4.5.zip"');
    const result = fixAppcastEnclosureUrls(xml, "owner/repo");
    expect(result.rewrites).toBe(1);
    expect(result.xml).toContain(
      'url="https://github.com/owner/repo/releases/download/v3.4.5/App-3.4.5.zip"',
    );
  });

  it("does not rewrite when the URL already points at the correct tag", () => {
    const xml = makeXml('url="https://github.com/owner/repo/releases/download/v1.2.3/App-1.2.3.zip"');
    const result = fixAppcastEnclosureUrls(xml, "owner/repo", "v");
    expect(result.rewrites).toBe(0);
    expect(result.xml).toBe(xml);
  });

  it("leaves the URL untouched when the filename has no semver", () => {
    const xml = makeXml('url="https://github.com/owner/repo/releases/download/vOLD/App-latest.zip"');
    const result = fixAppcastEnclosureUrls(xml, "owner/repo", "v");
    expect(result.rewrites).toBe(0);
    expect(result.xml).toBe(xml);
  });

  it("ignores enclosures for other repos", () => {
    const xml = makeXml('url="https://github.com/other/repo/releases/download/vOLD/App-1.2.3.zip"');
    const result = fixAppcastEnclosureUrls(xml, "owner/repo", "v");
    expect(result.rewrites).toBe(0);
    expect(result.xml).toBe(xml);
  });

  it("escapes a dot in repoSlug so it does not act as a regex wildcard", () => {
    const dotSlugXml = makeXml('url="https://github.com/owner/re.po/releases/download/vOLD/App-1.2.3.zip"');
    const wildcardSlugXml = makeXml('url="https://github.com/ownerXreXpo/releases/download/vOLD/App-1.2.3.zip"');

    expect(fixAppcastEnclosureUrls(wildcardSlugXml, "owner/re.po", "v").rewrites).toBe(0);

    const result = fixAppcastEnclosureUrls(dotSlugXml, "owner/re.po", "v");
    expect(result.rewrites).toBe(1);
    expect(result.xml).toContain(
      'url="https://github.com/owner/re.po/releases/download/v1.2.3/App-1.2.3.zip"',
    );
  });

  it("escapes regex metacharacters in tagPrefix so it is matched literally", () => {
    const literalPrefixXml = makeXml(
      'url="https://github.com/owner/repo/releases/download/v1.2.3-old/App-9.9.9.zip"',
    );
    const wildcardPrefixXml = makeXml(
      'url="https://github.com/owner/repo/releases/download/vX1X2X3-old/App-9.9.9.zip"',
    );

    expect(fixAppcastEnclosureUrls(wildcardPrefixXml, "owner/repo", "v1.2.3-").rewrites).toBe(0);

    const result = fixAppcastEnclosureUrls(literalPrefixXml, "owner/repo", "v1.2.3-");
    expect(result.rewrites).toBe(1);
    expect(result.xml).toContain(
      'url="https://github.com/owner/repo/releases/download/v1.2.3-9.9.9/App-9.9.9.zip"',
    );
  });
});
