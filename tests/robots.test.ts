import { describe, expect, it } from "vitest";

import { crawlDelayFor, groupFor, isAllowed, parseRobots } from "../src/robots.js";
import { hostOf, normalizeUrl, pathOf, sameSite } from "../src/url.js";

describe("normalizeUrl", () => {
  it("resolves relative links against a base", () => {
    expect(normalizeUrl("../x", "https://a.example/one/two/")).toBe("https://a.example/one/x");
  });

  it("drops fragments, credentials and default ports", () => {
    expect(normalizeUrl("https://user:pw@A.Example:443/p#frag")).toBe("https://a.example/p");
    expect(normalizeUrl("http://a.example:80/")).toBe("http://a.example/");
  });

  it("strips tracking parameters and sorts the rest", () => {
    expect(normalizeUrl("https://a.example/p?b=2&utm_source=x&a=1&fbclid=y")).toBe(
      "https://a.example/p?a=1&b=2",
    );
  });

  it("collapses links that differ only by noise", () => {
    const one = normalizeUrl("https://a.example/p?utm_medium=email#top");
    const two = normalizeUrl("https://a.example/p");
    expect(one).toBe(two);
  });

  it("preserves path case, which servers often care about", () => {
    expect(normalizeUrl("https://a.example/Path")).toBe("https://a.example/Path");
  });

  it("rejects anything that is not http(s)", () => {
    expect(normalizeUrl("mailto:x@y.z")).toBeNull();
    expect(normalizeUrl("ftp://a.example/f")).toBeNull();
    expect(normalizeUrl("not a url")).toBeNull();
  });

  it("exposes host, path and same-site helpers", () => {
    expect(hostOf("https://a.example/p")).toBe("a.example");
    expect(pathOf("https://a.example/p?q=1")).toBe("/p?q=1");
    expect(sameSite("https://a.example/1", "https://a.example/2")).toBe(true);
    expect(sameSite("https://a.example/1", "https://b.example/2")).toBe(false);
  });
});

describe("parseRobots", () => {
  const text = `
    # a comment
    User-agent: *
    Disallow: /private
    Allow: /private/public
    Crawl-delay: 2

    User-agent: crawlrank
    User-agent: friendly-bot
    Disallow: /
    Allow: /open

    Sitemap: https://a.example/sitemap.xml
  `;
  const robots = parseRobots(text);

  it("collects sitemaps regardless of grouping", () => {
    expect(robots.sitemaps).toEqual(["https://a.example/sitemap.xml"]);
  });

  it("shares one rule set between consecutive user-agent lines", () => {
    expect(groupFor(robots, "friendly-bot")).toBe(groupFor(robots, "crawlrank/0.1"));
  });

  it("prefers a named group over the wildcard", () => {
    expect(isAllowed(robots, "crawlrank/0.1", "/private")).toBe(false);
    expect(isAllowed(robots, "crawlrank/0.1", "/open")).toBe(true);
    expect(isAllowed(robots, "other-bot", "/private")).toBe(false);
    expect(isAllowed(robots, "other-bot", "/anything-else")).toBe(true);
  });

  it("lets the longest matching rule win", () => {
    expect(isAllowed(robots, "other-bot", "/private/public/page")).toBe(true);
  });

  it("reads crawl-delay from the group that applies", () => {
    expect(crawlDelayFor(robots, "other-bot")).toBe(2);
    expect(crawlDelayFor(robots, "crawlrank/0.1")).toBeUndefined();
  });
});

describe("robots path patterns", () => {
  const robots = parseRobots(
    ["User-agent: *", "Disallow: /*.pdf$", "Disallow: /a/*/b", "Allow: /a/keep/b"].join("\n"),
  );

  it("supports the $ end anchor", () => {
    expect(isAllowed(robots, "bot", "/file.pdf")).toBe(false);
    expect(isAllowed(robots, "bot", "/file.pdf?download=1")).toBe(true);
  });

  it("supports * wildcards in the middle of a path", () => {
    expect(isAllowed(robots, "bot", "/a/anything/b")).toBe(false);
    expect(isAllowed(robots, "bot", "/a/keep/b")).toBe(true);
  });

  it("treats an empty Disallow as permission", () => {
    const permissive = parseRobots("User-agent: *\nDisallow:");
    expect(isAllowed(permissive, "bot", "/anything")).toBe(true);
  });

  it("allows everything when the file has no rules for anyone", () => {
    expect(isAllowed(parseRobots(""), "bot", "/x")).toBe(true);
  });

  it("ignores malformed lines rather than failing", () => {
    const messy = parseRobots("garbage line\nUser-agent: *\nDisallow: /x\nnonsense");
    expect(isAllowed(messy, "bot", "/x")).toBe(false);
  });
});
