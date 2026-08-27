/** Public API. See README.md for the shape of a typical session. */

export { Crawler, defaultFetcher } from "./crawler.js";
export type {
  CrawledPage,
  CrawlerOptions,
  CrawlReport,
  CrawlResult,
  Fetcher,
  FetchResponse,
} from "./crawler.js";
export { Frontier } from "./frontier.js";
export type { FrontierEntry, FrontierOptions } from "./frontier.js";
export { extract, decodeEntities } from "./html.js";
export type { ExtractedPage } from "./html.js";
export { DEFAULT_BM25, SearchIndex } from "./index-store.js";
export type { Bm25Params, IndexedDoc, Posting, SearchHit } from "./index-store.js";
export { isEmpty, parseQuery } from "./query.js";
export type { ParsedQuery } from "./query.js";
export { crawlDelayFor, groupFor, isAllowed, parseRobots, PERMISSIVE } from "./robots.js";
export type { Robots, RobotsGroup, RobotsRule } from "./robots.js";
export { stem } from "./stem.js";
export { STOP_WORDS, tokenize } from "./tokenize.js";
export { hostOf, isHttpUrl, normalizeUrl, pathOf, sameSite } from "./url.js";
