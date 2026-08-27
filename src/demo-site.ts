/**
 * A tiny fake website, so `crawlrank demo` and the tests can exercise the
 * whole pipeline — robots.txt, redirects, politeness, ranking — offline.
 */

import type { Fetcher, FetchResponse } from "./crawler.js";

const PAGES: Record<string, string> = {
  "https://roast.example/robots.txt": [
    "User-agent: *",
    "Disallow: /admin",
    "Crawl-delay: 0",
    "",
    "Sitemap: https://roast.example/sitemap.xml",
  ].join("\n"),

  "https://roast.example/": `<html><head><title>Roast — small-batch coffee roasters</title></head>
    <body><h1>Roast</h1>
    <p>We roast coffee in small batches every Tuesday. Fresh beans, ground to order.</p>
    <a href="/beans">Our beans</a> <a href="/brewing">Brewing guides</a>
    <a href="/admin/secret">Admin</a> <a href="/about">About</a></body></html>`,

  "https://roast.example/beans": `<html><head><title>Our beans</title></head>
    <body><p>Ethiopian beans, Colombian beans and a decaf blend. Every bag is roasted
    to order and shipped within a day of roasting. Coffee beans lose their aroma quickly.</p>
    <a href="/brewing">How to brew</a></body></html>`,

  "https://roast.example/brewing": `<html><head><title>Brewing guides: cold brew and filter</title></head>
    <body><p>Cold brew takes twelve hours. Filter coffee takes three minutes. Both need
    coffee ground correctly: coarse for cold brew, medium for filter. Brewing is mostly patience.</p>
    <a href="/beans">Beans</a></body></html>`,

  "https://roast.example/about": `<html><head><title>About us</title>
    <meta name="robots" content="noindex"></head>
    <body><p>Two people and a roaster in a shed.</p></body></html>`,

  "https://roast.example/admin/secret": `<html><head><title>Admin</title></head>
    <body><p>Nothing to see.</p></body></html>`,
};

/** URLs that answer with a redirect rather than a body. */
const REDIRECTS: Record<string, string> = {
  "https://roast.example/coffee": "https://roast.example/beans",
};

/** How many times each URL has been requested, for the politeness assertions. */
export function createDemoFetcher(log: string[] = []): { fetcher: Fetcher; log: string[] } {
  const fetcher: Fetcher = async (url): Promise<FetchResponse> => {
    log.push(url);
    const redirect = REDIRECTS[url];
    if (redirect) {
      const body = PAGES[redirect] ?? "";
      return { url: redirect, status: 200, contentType: "text/html", body };
    }
    const body = PAGES[url];
    if (body === undefined) {
      return { url, status: 404, contentType: "text/html", body: "" };
    }
    const contentType = url.endsWith("robots.txt") ? "text/plain" : "text/html";
    return { url, status: 200, contentType, body };
  };
  return { fetcher, log };
}

export const DEMO_SEED = "https://roast.example/";
