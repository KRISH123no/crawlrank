/**
 * URL normalisation.
 *
 * Two links that point at the same page should collapse to one frontier entry,
 * otherwise a crawl spends its budget re-fetching the same document with a
 * different fragment or campaign parameter on the end.
 */

/** Query parameters that never change what a page returns. */
const TRACKING_PARAMS = [
  /^utm_/i,
  /^ga_/i,
  /^fbclid$/i,
  /^gclid$/i,
  /^msclkid$/i,
  /^mc_(cid|eid)$/i,
  /^ref$/i,
  /^igshid$/i,
];

const DEFAULT_PORTS: Record<string, string> = { "http:": "80", "https:": "443" };

export function isHttpUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Resolve `raw` against `base` and return a canonical form, or null when it is
 * not a crawlable http(s) URL.
 *
 * Canonical means: lower-case scheme and host, no default port, no fragment,
 * no tracking parameters, remaining parameters sorted, and an explicit "/"
 * path. Case in the path is preserved, because plenty of servers care.
 */
export function normalizeUrl(raw: string, base?: string): string | null {
  let url: URL;
  try {
    url = base ? new URL(raw, base) : new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;

  url.hash = "";
  url.username = "";
  url.password = "";
  if (url.port === DEFAULT_PORTS[url.protocol]) url.port = "";

  const kept: [string, string][] = [];
  for (const [key, value] of url.searchParams) {
    if (!TRACKING_PARAMS.some((pattern) => pattern.test(key))) kept.push([key, value]);
  }
  kept.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  url.search = "";
  for (const [key, value] of kept) url.searchParams.append(key, value);

  if (url.pathname === "") url.pathname = "/";
  return url.toString();
}

export function hostOf(raw: string): string {
  try {
    return new URL(raw).host.toLowerCase();
  } catch {
    return "";
  }
}

/** The path plus query, which is what robots.txt rules are matched against. */
export function pathOf(raw: string): string {
  try {
    const url = new URL(raw);
    return url.pathname + url.search;
  } catch {
    return "/";
  }
}

export function sameSite(a: string, b: string): boolean {
  return hostOf(a) === hostOf(b) && hostOf(a) !== "";
}
