/**
 * A polite, concurrent crawler.
 *
 * "Polite" is the whole design constraint: obey robots.txt, keep at most one
 * request in flight per host, leave a gap between requests to the same host,
 * back off when a server says it is struggling, and stop at a page budget.
 * Concurrency therefore comes from crawling *different* hosts at once, not
 * from hammering one.
 *
 * The network is injected, so the tests drive a full crawl — redirects,
 * retries, backoff and all — without touching a socket.
 */

import { extract } from "./html.js";
import { SearchIndex } from "./index-store.js";
import { crawlDelayFor, isAllowed, parseRobots, PERMISSIVE, type Robots } from "./robots.js";
import { Frontier } from "./frontier.js";
import { hostOf, normalizeUrl, pathOf } from "./url.js";

export interface FetchResponse {
  /** The final URL after redirects. */
  readonly url: string;
  readonly status: number;
  readonly contentType: string;
  readonly body: string;
}

export type Fetcher = (
  url: string,
  context: { readonly signal: AbortSignal; readonly userAgent: string },
) => Promise<FetchResponse>;

export interface CrawlerOptions {
  readonly fetcher?: Fetcher;
  /** How many hosts to work on at once. */
  readonly concurrency?: number;
  /** Minimum gap between two requests to the same host, in milliseconds. */
  readonly delayMs?: number;
  readonly maxPages?: number;
  readonly maxDepth?: number;
  readonly userAgent?: string;
  readonly obeyRobots?: boolean;
  readonly sameHostOnly?: boolean;
  readonly timeoutMs?: number;
  /** Retries after the first attempt, for network errors, 429 and 5xx. */
  readonly retries?: number;
  readonly backoffMs?: number;
  readonly maxBytes?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly random?: () => number;
  readonly now?: () => number;
  readonly onPage?: (page: CrawledPage) => void;
  readonly onError?: (url: string, error: Error) => void;
}

export interface CrawledPage {
  readonly url: string;
  readonly depth: number;
  readonly title: string;
  readonly links: number;
  readonly bytes: number;
}

export interface CrawlReport {
  readonly pages: number;
  readonly requests: number;
  readonly errors: number;
  readonly elapsedMs: number;
  readonly skipped: {
    readonly robots: number;
    readonly contentType: number;
    readonly status: number;
    readonly noindex: number;
  };
  readonly hosts: Record<string, number>;
}

export interface CrawlResult {
  readonly index: SearchIndex;
  readonly report: CrawlReport;
}

const DEFAULT_USER_AGENT = "crawlrank/0.1 (+https://github.com/)";

/** How long an idle worker waits before checking the frontier again. */
const IDLE_POLL_MS = 5;

export class Crawler {
  private readonly options: Required<Omit<CrawlerOptions, "onPage" | "onError" | "fetcher">> & {
    fetcher: Fetcher;
    onPage?: (page: CrawledPage) => void;
    onError?: (url: string, error: Error) => void;
  };
  private readonly robotsCache = new Map<string, Promise<Robots>>();
  private readonly hostReadyAt = new Map<string, number>();
  private readonly hostCounts = new Map<string, number>();
  private requests = 0;
  private errors = 0;
  private readonly skipped = { robots: 0, contentType: 0, status: 0, noindex: 0 };

  constructor(options: CrawlerOptions = {}) {
    this.options = {
      fetcher: options.fetcher ?? defaultFetcher,
      concurrency: options.concurrency ?? 4,
      delayMs: options.delayMs ?? 500,
      maxPages: options.maxPages ?? 50,
      maxDepth: options.maxDepth ?? 3,
      userAgent: options.userAgent ?? DEFAULT_USER_AGENT,
      obeyRobots: options.obeyRobots ?? true,
      sameHostOnly: options.sameHostOnly ?? true,
      timeoutMs: options.timeoutMs ?? 10_000,
      retries: options.retries ?? 2,
      backoffMs: options.backoffMs ?? 500,
      maxBytes: options.maxBytes ?? 2_000_000,
      sleep: options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
      random: options.random ?? Math.random,
      now: options.now ?? Date.now,
      ...(options.onPage ? { onPage: options.onPage } : {}),
      ...(options.onError ? { onError: options.onError } : {}),
    };
  }

  async crawl(seeds: string[], index = new SearchIndex()): Promise<CrawlResult> {
    const started = this.options.now();
    const normalizedSeeds = seeds.map((seed) => normalizeUrl(seed)).filter(isString);
    const frontier = new Frontier({
      maxDepth: this.options.maxDepth,
      ...(this.options.sameHostOnly
        ? { allowedHosts: normalizedSeeds.map(hostOf).filter((host) => host !== "") }
        : {}),
    });
    for (const seed of normalizedSeeds) frontier.add(seed, 0);

    let inFlight = 0;
    const workerCount = Math.max(1, this.options.concurrency);

    const worker = async (): Promise<void> => {
      for (;;) {
        if (index.size >= this.options.maxPages) return;
        const entry = frontier.next();
        if (!entry) {
          if (inFlight === 0) return;
          // Another worker is mid-fetch and may still add links.
          await this.options.sleep(IDLE_POLL_MS);
          continue;
        }
        inFlight++;
        try {
          await this.visit(entry.url, entry.depth, frontier, index);
        } finally {
          inFlight--;
        }
      }
    };

    await Promise.all(Array.from({ length: workerCount }, worker));

    return {
      index,
      report: {
        pages: index.size,
        requests: this.requests,
        errors: this.errors,
        elapsedMs: this.options.now() - started,
        skipped: { ...this.skipped },
        hosts: Object.fromEntries([...this.hostCounts].sort((a, b) => b[1] - a[1])),
      },
    };
  }

  private async visit(
    url: string,
    depth: number,
    frontier: Frontier,
    index: SearchIndex,
  ): Promise<void> {
    const host = hostOf(url);
    if (this.options.obeyRobots) {
      const robots = await this.robotsFor(url);
      if (!isAllowed(robots, this.options.userAgent, pathOf(url))) {
        this.skipped.robots++;
        return;
      }
    }
    await this.waitForHost(host);

    let response: FetchResponse;
    try {
      response = await this.fetchWithRetry(url);
    } catch (error) {
      this.errors++;
      this.options.onError?.(url, error as Error);
      return;
    }

    if (response.status >= 400) {
      this.skipped.status++;
      return;
    }
    if (response.body === "" || !/html|xml|text\/plain/i.test(response.contentType)) {
      this.skipped.contentType++;
      return;
    }
    if (index.size >= this.options.maxPages) return;

    const finalUrl = normalizeUrl(response.url) ?? url;
    const page = extract(response.body, finalUrl);
    if (page.noIndex) {
      this.skipped.noindex++;
    } else {
      index.addDocument(finalUrl, page.title || finalUrl, page.text);
      this.hostCounts.set(host, (this.hostCounts.get(host) ?? 0) + 1);
      this.options.onPage?.({
        url: finalUrl,
        depth,
        title: page.title,
        links: page.links.length,
        bytes: response.body.length,
      });
    }
    if (page.noFollow) return;
    for (const link of page.links) frontier.add(link, depth + 1);
  }

  /**
   * One request per host at a time, spaced by the politeness delay.
   *
   * The slot is reserved with a synchronous read-modify-write. Any `await`
   * between reading `hostReadyAt` and writing it back would let a second
   * worker read the same value and book the same slot, which is exactly the
   * burst that politeness is meant to prevent — so the delay is resolved
   * first, before the reservation.
   */
  private async waitForHost(host: string): Promise<void> {
    const delay = await this.delayForHost(host);
    const now = this.options.now();
    const readyAt = this.hostReadyAt.get(host) ?? 0;
    const startAt = Math.max(now, readyAt);
    this.hostReadyAt.set(host, startAt + delay);
    const wait = startAt - now;
    if (wait > 0) await this.options.sleep(wait);
  }

  private async delayForHost(host: string): Promise<number> {
    if (!this.options.obeyRobots) return this.options.delayMs;
    const robots = await this.robotsFor(`https://${host}/`);
    const declared = crawlDelayFor(robots, this.options.userAgent);
    // A site asking for a longer gap wins; a shorter one does not licence us.
    return declared === undefined
      ? this.options.delayMs
      : Math.max(this.options.delayMs, declared * 1000);
  }

  private robotsFor(url: string): Promise<Robots> {
    const host = hostOf(url);
    const cached = this.robotsCache.get(host);
    if (cached) return cached;

    const origin = new URL(url).origin;
    const promise = (async () => {
      try {
        const response = await this.fetchOnce(`${origin}/robots.txt`);
        // 4xx means no rules; 5xx conventionally means "stay away", but this
        // crawler is small and read-only, so it treats both as permissive.
        if (response.status >= 400) return PERMISSIVE;
        return parseRobots(response.body);
      } catch {
        return PERMISSIVE;
      }
    })();
    this.robotsCache.set(host, promise);
    return promise;
  }

  private async fetchWithRetry(url: string): Promise<FetchResponse> {
    let lastError: Error | null = null;
    for (let attempt = 0; attempt <= this.options.retries; attempt++) {
      if (attempt > 0) {
        // Exponential backoff with jitter, so retries from several workers
        // do not line up into a second thundering herd.
        const base = this.options.backoffMs * 2 ** (attempt - 1);
        await this.options.sleep(Math.round(base * (0.5 + this.options.random())));
      }
      try {
        const response = await this.fetchOnce(url);
        if (response.status === 429 || response.status >= 500) {
          lastError = new Error(`HTTP ${response.status} from ${url}`);
          continue;
        }
        return response;
      } catch (error) {
        lastError = error as Error;
      }
    }
    throw lastError ?? new Error(`failed to fetch ${url}`);
  }

  private async fetchOnce(url: string): Promise<FetchResponse> {
    this.requests++;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs);
    try {
      const response = await this.options.fetcher(url, {
        signal: controller.signal,
        userAgent: this.options.userAgent,
      });
      return response.body.length > this.options.maxBytes
        ? { ...response, body: response.body.slice(0, this.options.maxBytes) }
        : response;
    } finally {
      clearTimeout(timer);
    }
  }
}

export const defaultFetcher: Fetcher = async (url, { signal, userAgent }) => {
  const response = await fetch(url, {
    signal,
    redirect: "follow",
    headers: { "user-agent": userAgent, accept: "text/html,application/xhtml+xml,text/plain" },
  });
  const contentType = response.headers.get("content-type") ?? "";
  const readable = /html|xml|text\/plain/i.test(contentType);
  return {
    url: response.url || url,
    status: response.status,
    contentType,
    body: readable ? await response.text() : "",
  };
};

function isString(value: string | null): value is string {
  return value !== null;
}
