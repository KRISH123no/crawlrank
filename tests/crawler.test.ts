import { describe, expect, it, vi } from "vitest";

import { Crawler, type Fetcher, type FetchResponse } from "../src/crawler.js";
import { createDemoFetcher, DEMO_SEED } from "../src/demo-site.js";

/** Matches the crawler's idle poll, which is noise in the backoff assertions. */
const IDLE_POLL_MS = 5;

/**
 * Run a crawl under fake timers and let virtual time run out.
 *
 * The crawler's own setTimeout and Date.now are what get faked, so the timing
 * assertions exercise the real politeness code rather than a stand-in.
 */
async function underFakeTimers<T>(run: () => Promise<T>, virtualMs = 60_000): Promise<T> {
  vi.useFakeTimers();
  try {
    const promise = run();
    await vi.advanceTimersByTimeAsync(virtualMs);
    return await promise;
  } finally {
    vi.useRealTimers();
  }
}

function html(title: string, body: string): FetchResponse {
  return {
    url: "",
    status: 200,
    contentType: "text/html",
    body: `<html><head><title>${title}</title></head><body>${body}</body></html>`,
  };
}

function siteFetcher(pages: Record<string, FetchResponse>, log: string[] = []): Fetcher {
  return async (url) => {
    log.push(url);
    const page = pages[url];
    if (!page) return { url, status: 404, contentType: "text/html", body: "" };
    return { ...page, url: page.url || url };
  };
}

describe("Crawler", () => {
  it("crawls a site, obeying robots.txt, noindex and nofollow", async () => {
    const { fetcher, log } = createDemoFetcher();
    const crawler = new Crawler({ fetcher, delayMs: 0, concurrency: 2 });
    const { index, report } = await crawler.crawl([DEMO_SEED]);

    expect(index.allDocuments().map((doc) => doc.url).sort()).toEqual([
      "https://roast.example/",
      "https://roast.example/beans",
      "https://roast.example/brewing",
    ]);
    expect(report.skipped.robots).toBe(1); // /admin/secret
    expect(report.skipped.noindex).toBe(1); // /about
    expect(log).toContain("https://roast.example/robots.txt");
    expect(log).not.toContain("https://roast.example/admin/secret");
  });

  it("fetches robots.txt once per host", async () => {
    const { fetcher, log } = createDemoFetcher();
    await new Crawler({ fetcher, delayMs: 0 }).crawl([DEMO_SEED]);
    expect(log.filter((url) => url.endsWith("robots.txt"))).toHaveLength(1);
  });

  it("indexes the URL a redirect lands on, not the one requested", async () => {
    const { fetcher } = createDemoFetcher();
    const { index } = await new Crawler({ fetcher, delayMs: 0, maxDepth: 0 }).crawl([
      "https://roast.example/coffee",
    ]);
    expect(index.allDocuments()[0]?.url).toBe("https://roast.example/beans");
  });

  it("stops at the page budget", async () => {
    const { fetcher } = createDemoFetcher();
    const { index, report } = await new Crawler({ fetcher, delayMs: 0, maxPages: 2 }).crawl([
      DEMO_SEED,
    ]);
    expect(index.size).toBe(2);
    expect(report.pages).toBe(2);
  });

  it("stops at the depth limit", async () => {
    const { fetcher } = createDemoFetcher();
    const { index } = await new Crawler({ fetcher, delayMs: 0, maxDepth: 0 }).crawl([DEMO_SEED]);
    expect(index.size).toBe(1);
  });

  it("stays on the seed host unless told otherwise", async () => {
    const pages: Record<string, FetchResponse> = {
      "https://a.example/": html("A", '<a href="https://b.example/">B</a>'),
      "https://b.example/": html("B", "elsewhere"),
    };
    const sameHost = await new Crawler({
      fetcher: siteFetcher(pages),
      delayMs: 0,
      obeyRobots: false,
    }).crawl(["https://a.example/"]);
    expect(sameHost.index.size).toBe(1);

    const allHosts = await new Crawler({
      fetcher: siteFetcher(pages),
      delayMs: 0,
      obeyRobots: false,
      sameHostOnly: false,
    }).crawl(["https://a.example/"]);
    expect(allHosts.index.size).toBe(2);
  });

  it("skips robots.txt entirely when asked to ignore it", async () => {
    const { fetcher, log } = createDemoFetcher();
    const { index } = await new Crawler({ fetcher, delayMs: 0, obeyRobots: false }).crawl([
      DEMO_SEED,
    ]);
    expect(log.some((url) => url.endsWith("robots.txt"))).toBe(false);
    expect(index.allDocuments().map((doc) => doc.url)).toContain(
      "https://roast.example/admin/secret",
    );
  });

  it("leaves the politeness delay between two requests to one host", async () => {
    const times: number[] = [];
    const fetcher: Fetcher = async (url) => {
      times.push(Date.now());
      return url === "https://a.example/"
        ? html("A", '<a href="/two">two</a><a href="/three">three</a>')
        : html("page", "text");
    };
    await underFakeTimers(() =>
      new Crawler({ fetcher, obeyRobots: false, concurrency: 3, delayMs: 1000 }).crawl([
        "https://a.example/",
      ]),
    );

    expect(times).toHaveLength(3);
    const sorted = [...times].sort((a, b) => a - b);
    expect(sorted[1]! - sorted[0]!).toBeGreaterThanOrEqual(1000);
    expect(sorted[2]! - sorted[1]!).toBeGreaterThanOrEqual(1000);
  });

  it("honours a longer Crawl-delay from robots.txt but not a shorter one", async () => {
    const times: number[] = [];
    const fetcher: Fetcher = async (url) => {
      if (url.endsWith("robots.txt")) {
        return {
          url,
          status: 200,
          contentType: "text/plain",
          body: "User-agent: *\nCrawl-delay: 5",
        };
      }
      times.push(Date.now());
      return url === "https://a.example/" ? html("A", '<a href="/two">two</a>') : html("two", "x");
    };
    await underFakeTimers(() =>
      new Crawler({ fetcher, delayMs: 100 }).crawl(["https://a.example/"]),
    );
    expect(times[1]! - times[0]!).toBeGreaterThanOrEqual(5000);
  });

  it("works on several hosts at once", async () => {
    const times: number[] = [];
    const fetcher: Fetcher = async () => {
      times.push(Date.now());
      return html("page", "text");
    };
    const { index } = await underFakeTimers(() =>
      new Crawler({
        fetcher,
        obeyRobots: false,
        sameHostOnly: false,
        concurrency: 2,
        delayMs: 1000,
        maxDepth: 0,
      }).crawl(["https://a.example/", "https://b.example/"]),
    );

    expect(index.size).toBe(2);
    // Neither host waited for the other: both fetches land inside one delay.
    expect(Math.abs(times[1]! - times[0]!)).toBeLessThan(1000);
  });

  it("retries a 500 with exponential backoff and then succeeds", async () => {
    const waits: number[] = [];
    let attempts = 0;
    const fetcher: Fetcher = async (url) => {
      attempts++;
      if (attempts < 3) return { url, status: 500, contentType: "text/html", body: "" };
      return html("recovered", "body text");
    };
    const { index, report } = await new Crawler({
      fetcher,
      obeyRobots: false,
      delayMs: 0,
      backoffMs: 100,
      random: () => 0.5,
      sleep: async (ms) => {
        if (ms > IDLE_POLL_MS) waits.push(ms); // ignore idle-worker polling
      },
    }).crawl(["https://a.example/"]);

    expect(attempts).toBe(3);
    expect(waits).toEqual([100, 200]); // base delay, then doubled
    expect(index.size).toBe(1);
    expect(report.errors).toBe(0);
  });

  it("gives up after the retry budget and records the error", async () => {
    const onError = vi.fn();
    const fetcher: Fetcher = async () => {
      throw new Error("connection reset");
    };
    const { index, report } = await new Crawler({
      fetcher,
      obeyRobots: false,
      delayMs: 0,
      retries: 1,
      backoffMs: 0,
      onError,
    }).crawl(["https://a.example/"]);

    expect(index.size).toBe(0);
    expect(report.errors).toBe(1);
    expect(onError).toHaveBeenCalledOnce();
    expect(onError.mock.calls[0]?.[1]).toBeInstanceOf(Error);
  });

  it("retries 429 as well as 5xx", async () => {
    let attempts = 0;
    const fetcher: Fetcher = async (url) => {
      attempts++;
      return attempts === 1
        ? { url, status: 429, contentType: "text/html", body: "" }
        : html("ok", "text");
    };
    const { index } = await new Crawler({
      fetcher,
      obeyRobots: false,
      delayMs: 0,
      backoffMs: 0,
    }).crawl(["https://a.example/"]);
    expect(attempts).toBe(2);
    expect(index.size).toBe(1);
  });

  it("does not retry a 404", async () => {
    let attempts = 0;
    const fetcher: Fetcher = async (url) => {
      attempts++;
      return { url, status: 404, contentType: "text/html", body: "" };
    };
    const { report } = await new Crawler({ fetcher, obeyRobots: false, delayMs: 0 }).crawl([
      "https://a.example/missing",
    ]);
    expect(attempts).toBe(1);
    expect(report.skipped.status).toBe(1);
  });

  it("skips responses that are not text", async () => {
    const fetcher: Fetcher = async (url) => ({
      url,
      status: 200,
      contentType: "image/png",
      body: "PNG",
    });
    const { index, report } = await new Crawler({ fetcher, obeyRobots: false, delayMs: 0 }).crawl([
      "https://a.example/logo.png",
    ]);
    expect(index.size).toBe(0);
    expect(report.skipped.contentType).toBe(1);
  });

  it("truncates a response that exceeds the byte cap", async () => {
    const fetcher: Fetcher = async (url) => ({
      url,
      status: 200,
      contentType: "text/html",
      body: `<html><body>${"word ".repeat(10_000)}</body></html>`,
    });
    const { index } = await new Crawler({
      fetcher,
      obeyRobots: false,
      delayMs: 0,
      maxBytes: 200,
    }).crawl(["https://a.example/"]);
    expect(index.allDocuments()[0]!.length).toBeLessThan(60);
  });

  it("reports pages, requests and per-host counts", async () => {
    const { fetcher } = createDemoFetcher();
    const onPage = vi.fn();
    const { report } = await new Crawler({ fetcher, delayMs: 0, onPage }).crawl([DEMO_SEED]);
    expect(report.pages).toBe(3);
    expect(report.requests).toBeGreaterThanOrEqual(4);
    expect(report.hosts).toEqual({ "roast.example": 3 });
    expect(onPage).toHaveBeenCalledTimes(3);
  });

  it("ignores seeds that are not crawlable URLs", async () => {
    const { fetcher } = createDemoFetcher();
    const { index } = await new Crawler({ fetcher, delayMs: 0 }).crawl(["mailto:x@y.z", "nonsense"]);
    expect(index.size).toBe(0);
  });
});
