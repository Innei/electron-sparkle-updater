export interface InjectPublicKeyResult {
  content: string;
  replacements: number;
}

export function injectPublicKey(content: string, key: string, placeholder: string): InjectPublicKeyResult {
  const replacements = content.split(placeholder).length - 1;
  if (replacements === 0) {
    throw new Error(`placeholder "${placeholder}" not found`);
  }
  return { content: content.split(placeholder).join(key), replacements };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export interface FixAppcastResult {
  xml: string;
  rewrites: number;
}

export function fixAppcastEnclosureUrls(xml: string, repoSlug: string, tagPrefix = "v"): FixAppcastResult {
  // generate_appcast stamps every archive it processes with the current run's
  // --download-url-prefix, so items regenerated from older zips (fetched into the
  // archive dir only as delta bases) end up pointing at the new tag's release,
  // where those assets were never uploaded (404). Enclosure URLs are not covered
  // by the EdDSA signatures (those sign the file contents), so rewriting each URL
  // back to the tag its own version was published under is safe.
  const enclosureUrl = new RegExp(
    `url="https://github\\.com/${escapeRegExp(repoSlug)}/releases/download/${escapeRegExp(tagPrefix)}[^/"]+/([^/"]+)"`,
    "g",
  );

  let rewrites = 0;
  const fixed = xml.replace(enclosureUrl, (match, filename) => {
    const version = /\d+\.\d+\.\d+/.exec(filename)?.[0];
    if (!version) return match;
    const url = `url="https://github.com/${repoSlug}/releases/download/${tagPrefix}${version}/${filename}"`;
    if (url !== match) {
      rewrites++;
    }
    return url;
  });

  return { xml: fixed, rewrites };
}
