/**
 * A tolerant HTML reader.
 *
 * A crawler meets far more broken markup than valid markup, so this does not
 * try to build a DOM. It strips the elements whose text is not content,
 * pulls out the title, links and visible text, and never throws.
 */

import { normalizeUrl } from "./url.js";

export interface ExtractedPage {
  readonly title: string;
  readonly text: string;
  readonly links: string[];
  /** True when a robots meta tag asked crawlers not to follow the links. */
  readonly noFollow: boolean;
  readonly noIndex: boolean;
}

/** The named entities that actually show up in crawled pages. */
const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  copy: "\u00a9", reg: "\u00ae", trade: "\u2122", hellip: "\u2026",
  mdash: "\u2014", ndash: "\u2013", lsquo: "\u2018", rsquo: "\u2019",
  ldquo: "\u201c", rdquo: "\u201d", laquo: "\u00ab", raquo: "\u00bb",
  bull: "\u2022", middot: "\u00b7", deg: "\u00b0", times: "\u00d7",
  euro: "\u20ac", pound: "\u00a3", yen: "\u00a5", cent: "\u00a2",
  eacute: "\u00e9", egrave: "\u00e8", ecirc: "\u00ea", agrave: "\u00e0",
  aacute: "\u00e1", acirc: "\u00e2", auml: "\u00e4", aring: "\u00e5",
  ccedil: "\u00e7", iacute: "\u00ed", oacute: "\u00f3", ouml: "\u00f6",
  uacute: "\u00fa", uuml: "\u00fc", ntilde: "\u00f1", szlig: "\u00df",
};

export function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, name: string) => {
    const key = name.toLowerCase();
    if (ENTITIES[key] !== undefined) return ENTITIES[key];
    if (key.startsWith("#x")) {
      const code = Number.parseInt(key.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    if (key.startsWith("#")) {
      const code = Number.parseInt(key.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return whole;
  });
}

/** Elements whose contents are markup or styling rather than prose. */
const NON_CONTENT = /<(script|style|noscript|template|svg)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
const COMMENTS = /<!--[\s\S]*?-->/g;
const TAG = /<\/?[a-z][^>]*>/gi;
const TITLE = /<title[^>]*>([\s\S]*?)<\/title\s*>/i;
const ANCHOR = /<a\b[^>]*?href\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>/gi;
const META_ROBOTS = /<meta\b[^>]*name\s*=\s*["']?robots["']?[^>]*>/gi;
const CONTENT_ATTR = /content\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i;
/** Tags that imply a word boundary once the markup is gone. */
const BLOCK = /<\/?(p|div|br|li|tr|td|th|h[1-6]|section|article|header|footer|nav|ul|ol|table)\b[^>]*>/gi;

export function extract(html: string, baseUrl: string): ExtractedPage {
  const cleaned = html.replace(COMMENTS, " ").replace(NON_CONTENT, " ");

  const titleMatch = TITLE.exec(cleaned);
  const title = titleMatch?.[1] ? collapse(decodeEntities(stripTags(titleMatch[1]))) : "";

  let noFollow = false;
  let noIndex = false;
  for (const meta of cleaned.matchAll(META_ROBOTS)) {
    const content = CONTENT_ATTR.exec(meta[0]);
    const value = (content?.[2] ?? content?.[3] ?? content?.[4] ?? "").toLowerCase();
    if (value.includes("nofollow")) noFollow = true;
    if (value.includes("noindex")) noIndex = true;
  }

  const links: string[] = [];
  const seen = new Set<string>();
  for (const anchor of cleaned.matchAll(ANCHOR)) {
    const href = anchor[2] ?? anchor[3] ?? anchor[4];
    if (!href) continue;
    const trimmed = decodeEntities(href.trim());
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    if (/^(javascript|mailto|tel|data):/i.test(trimmed)) continue;
    if (/\brel\s*=\s*["']?[^"'>]*nofollow/i.test(anchor[0])) continue;
    const resolved = normalizeUrl(trimmed, baseUrl);
    if (resolved && !seen.has(resolved)) {
      seen.add(resolved);
      links.push(resolved);
    }
  }

  // The title is indexed as its own field, so keep <head> out of the body text.
  const body = cleaned.replace(/<head\b[^>]*>[\s\S]*?<\/head\s*>/i, " ");
  const text = collapse(decodeEntities(stripTags(body.replace(BLOCK, " "))));
  return { title, text, links, noFollow, noIndex };
}

function stripTags(html: string): string {
  return html.replace(TAG, " ");
}

function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}
